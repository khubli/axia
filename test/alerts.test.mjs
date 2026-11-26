// Job-alert emails: the email text, the LinkedIn cards in it, the read-only mailbox session,
// and alert roles going through a whole run. Every company, role and address here is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { parseEmail, readMailbox, internalDate, MailError } from '../src/mail.mjs';
import { parseLinkedIn, readAlerts, trackedCompany, ignored, alertKey, collapseAlertRoles, placesOf, postingDater } from '../src/alerts.mjs';
import { loadSettings, ConfigError } from '../src/config.mjs';
import { jobText } from '../src/score.mjs';
import { trackProblems, planMessages } from '../src/notify.mjs';
import { emptyState } from '../src/state.mjs';
import { run } from '../src/run.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EML = readFileSync(join(here, 'fixtures', 'linkedin-alert.eml'));

test('an alert email: sender, subject and the decoded plain text', () => {
  const e = parseEmail(EML);
  assert.equal(e.from, 'jobalerts-noreply@linkedin.com');
  assert.equal(e.subject, 'Woodgrove Bank Services in India Head of Technology – Trade Finance');
  assert.equal(e.date, '2026-11-25T05:51:53.000Z');
  assert.match(e.text, /Head of Technology – Trade Finance\nWoodgrove Bank Services in India\nBengaluru/);
  // Soft line breaks are joined: the job link is one line again.
  assert.match(e.text, /View job: https:\/\/www\.linkedin\.com\/comm\/jobs\/view\/4000000002\/\?trackingId=ghi%3D%3D&refId=jkl&trk=\S+jobid_4000000002\n/);
});

test('an email with only an HTML part is read as text', () => {
  const raw = 'From: a@example.com\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from('<p>Hello <b>there</b></p>').toString('base64') + '\r\n';
  assert.match(parseEmail(raw).text, /Hello there/);
});

test('the roles in a LinkedIn job alert: title, employer, place and link; notes and footers left out', () => {
  const roles = parseLinkedIn(parseEmail(EML).text);
  assert.deepEqual(roles, [
    { id: '4000000001', title: 'Head of Technology – Trade Finance', company: 'Woodgrove Bank Services in India', location: 'Bengaluru', url: 'https://www.linkedin.com/jobs/view/4000000001/' },
    { id: '4000000002', title: 'Director, Payments Architecture', company: 'Contoso Pay', location: 'Pune Division', url: 'https://www.linkedin.com/jobs/view/4000000002/' },
    { id: '4000000003', title: 'Vice President, Core Banking Platforms', company: 'Fabrikam Capital', location: 'Bengaluru East', url: 'https://www.linkedin.com/jobs/view/4000000003/' },
  ]);
});

test('LinkedIn "jobs similar to" and application emails: the header lines are not roles', () => {
  const similar = [
    'Jobs similar to Lead Architect at Contoso Pay https://www.linkedin.com/comm/jobs/view/4100000000?refId=x',
    '',
    'Lead Architect / Senior Associate Director',
    'Woodgrove Bank',
    'Pune Division',
    'View job: https://www.linkedin.com/comm/jobs/view/4100000001/?trackingId=a',
    '',
    '---------------------------------------------------------',
    '',
  ].join('\n');
  assert.deepEqual(parseLinkedIn(similar).map((r) => [r.id, r.title, r.company, r.location]), [['4100000001', 'Lead Architect / Senior Associate Director', 'Woodgrove Bank', 'Pune Division']]);

  const applied = [
    'Your application was sent to Fabrikam Capital',
    '',
    'Director – Head of IT Trade Finance',
    'Fabrikam Capital',
    'Bengaluru',
    'View job: https://www.linkedin.com/comm/jobs/view/4200000001/?trackingId=a',
    '',
    '---------------------------------------------------------',
    '',
    'Applied on November 25, 2026----------------------------------------------------------------',
    '        Now, take these next steps for more success',
    '',
    'View similar jobs you may be interested in',
    '',
    'Solution Architecture - VP',
    'Contoso Pay',
    '',
    '1 connection',
    '857 company alumni',
    'View job: https://www.linkedin.com/comm/jobs/view/4200000002/?trackingId=b',
  ].join('\n');
  assert.deepEqual(parseLinkedIn(applied).map((r) => [r.id, r.title, r.company, r.location]), [
    ['4200000001', 'Director – Head of IT Trade Finance', 'Fabrikam Capital', 'Bengaluru'],
    ['4200000002', 'Solution Architecture - VP', 'Contoso Pay', null], // no place given: a note is never taken for one
  ]);
});

test("IMAP's internal date", () => {
  assert.equal(internalDate('25-Nov-2026 05:51:53 +0000'), '2026-11-25T05:51:53.000Z');
  assert.equal(internalDate(' 5-Nov-2026 11:21:53 +0530'), '2026-11-05T05:51:53.000Z');
  assert.equal(internalDate('nonsense'), null);
});

/** A scripted IMAP server: answers each command from `replies(tag, command)`, and records what was sent. */
function fakeServer(replies) {
  const sent = [];
  const socket = new EventEmitter();
  const say = (s) => setImmediate(() => socket.emit('data', Buffer.from(s)));
  socket.write = (data) => {
    const line = String(data).replace(/\r\n$/, '');
    sent.push(line);
    const [tag, ...rest] = line.split(' ');
    say(replies(tag, rest.join(' ')));
  };
  socket.end = () => {};
  socket.destroy = () => {};
  return { sent, connect: async () => (say('* OK [CAPABILITY IMAP4rev1] ready\r\n'), socket) };
}

test('the mailbox is opened read-only and only the named senders are fetched', async () => {
  const server = fakeServer((tag, cmd) => {
    if (cmd.startsWith('LOGIN')) return `${tag} OK signed in\r\n`;
    if (cmd.startsWith('LIST')) return `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n${tag} OK done\r\n`;
    if (cmd.startsWith('EXAMINE')) return `* 12 EXISTS\r\n${tag} OK [READ-ONLY] opened\r\n`;
    if (cmd.startsWith('UID SEARCH')) return `* SEARCH 41 7\r\n${tag} OK done\r\n`;
    if (cmd.startsWith('UID FETCH')) {
      const uid = cmd.split(' ')[2];
      const body = uid === '7' ? EML : Buffer.from('From: jobs-noreply@linkedin.com\r\nSubject: hi\r\n\r\nnothing\r\n');
      return Buffer.concat([Buffer.from(`* 3 FETCH (UID ${uid} INTERNALDATE "24-Nov-2026 10:00:00 +0000" BODY[] {${body.length}}\r\n`), body, Buffer.from(`)\r\n${tag} OK done\r\n`)]).toString('latin1');
    }
    if (cmd.startsWith('LOGOUT')) return `* BYE\r\n${tag} OK bye\r\n`;
    return `${tag} BAD unexpected\r\n`;
  });
  // The fake replies as latin1, so the email's bytes arrive unchanged.
  const mail = await readMailbox({ host: 'imap.example.com', user: 'candidate@example.com', pass: 'app pass', senders: ['jobalerts-noreply@linkedin.com', 'jobs-noreply@linkedin.com'], since: '2026-11-18', connect: server.connect });
  assert.equal(server.sent[0], 'A1 LOGIN "candidate@example.com" "app pass"');
  assert.equal(server.sent[2], 'A3 EXAMINE "[Gmail]/All Mail"');
  assert.equal(server.sent[3], 'A4 UID SEARCH SINCE 18-Nov-2026 OR FROM "jobalerts-noreply@linkedin.com" FROM "jobs-noreply@linkedin.com"');
  assert.deepEqual(server.sent.slice(4, 6), ['A5 UID FETCH 7 (UID INTERNALDATE BODY.PEEK[])', 'A6 UID FETCH 41 (UID INTERNALDATE BODY.PEEK[])']);
  assert.ok(!server.sent.some((c) => /\b(SELECT|STORE|EXPUNGE|COPY|MOVE)\b/.test(c)), 'never changes the mailbox');
  assert.equal(mail.length, 2);
  assert.equal(mail[0].date, '2026-11-24T10:00:00.000Z');
  assert.equal(parseLinkedIn(mail[0].text).length, 3);
});

test('a refused sign-in is a plain error that never repeats the password', async () => {
  const server = fakeServer((tag, cmd) => (cmd.startsWith('LOGIN') ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n` : `${tag} OK\r\n`));
  await assert.rejects(readMailbox({ host: 'imap.example.com', user: 'u@example.com', pass: 'secret-pass', senders: ['a@example.com'], since: '2026-11-18', connect: server.connect }), (err) => {
    assert.ok(err instanceof MailError);
    assert.match(err.message, /^LOGIN: \[AUTHENTICATIONFAILED\] Invalid credentials/);
    assert.doesNotMatch(err.message, /secret-pass/);
    return true;
  });
});

test('employers in alerts match your companies by name, however the alert writes it', () => {
  const companies = [{ name: 'Woodgrove Bank' }, { name: 'Woodgrove' }, { name: 'Contoso Pay' }, { name: 'Société Lumière' }, { name: 'Fabrikam Capital of Asia' }, { name: 'Tailspin Toys' }, { name: 'Cred' }];
  assert.equal(trackedCompany(companies, 'Woodgrove Bank Services in India').name, 'Woodgrove Bank');
  assert.equal(trackedCompany(companies, 'contoso pay').name, 'Contoso Pay');
  assert.equal(trackedCompany(companies, 'Societe Lumiere Global Solution Centre').name, 'Société Lumière'); // accents
  assert.equal(trackedCompany(companies, 'Fabrikam Capital').name, 'Fabrikam Capital of Asia'); // the alert's name is shorter
  assert.equal(trackedCompany(companies, 'TailspinToys').name, 'Tailspin Toys'); // written without a space
  assert.equal(trackedCompany(companies, 'CreditX'), null); // a short name is never a prefix
  assert.equal(trackedCompany(companies, 'Northwind Traders'), null);
  // job_alerts.ignore takes only the name itself, or the name followed by more words.
  const settings = { job_alerts: { ignore: ['Woodgrove Bank Finance'] } };
  assert.equal(ignored(settings, 'Woodgrove Bank Finance India'), true);
  assert.equal(ignored(settings, 'Woodgrove Bank'), false);
});

test('job_alerts settings: off by default; plain errors for bad values', () => {
  const base = { titles: { include: ['Architect'] } };
  const settings = (job_alerts) => loadSettings(tempProject({ companies: [{ name: 'X', url: 'https://job-boards.greenhouse.io/x' }], settings: { ...base, ...(job_alerts === undefined ? {} : { job_alerts }) } }));
  assert.equal(settings().job_alerts.enabled, false);
  assert.equal(settings({ linkedin: true }).job_alerts.enabled, true);
  assert.equal(settings({ linkedin: true }).job_alerts.days, 30);
  assert.throws(() => settings({ linkedin: 'yes' }), ConfigError);
  assert.throws(() => settings({ linkedin: true, days: 0 }), /job_alerts.days must be a whole number from 1 to 90/);
  assert.throws(() => settings({ linkedin: true, ignore: 'Woodgrove' }), /job_alerts.ignore must be a list/);
});

test('reading alerts: since the last read (two days over), roles forgotten after `days` without an email', async () => {
  const settings = { job_alerts: { enabled: true, linkedin: true, days: 30, host: 'imap.example.com', port: 993, mailbox: '', ignore: [] } };
  const state = emptyState();
  const asked = [];
  const mail = [{ from: 'jobalerts-noreply@linkedin.com', date: '2026-11-20T05:00:00Z', text: parseEmail(EML).text }];
  const readMail = async (o) => (asked.push(o), mail);
  const env = { IMAP_USER: 'candidate@example.com', IMAP_PASSWORD: 'abcd efgh ijkl mnop' };
  let out = await readAlerts({ settings, env, state, today: '2026-11-25', readMail });
  assert.equal(asked[0].since, '2026-10-26'); // first read: the last 30 days
  assert.equal(asked[0].pass, 'abcdefghijklmnop'); // Google shows app passwords in groups of four
  assert.deepEqual(out.roles.map((r) => r.id), ['4000000001', '4000000002', '4000000003']);
  assert.equal(state.alerts.roles['4000000001'].lastSeen, '2026-11-20');
  out = await readAlerts({ settings, env, state, today: '2026-12-21', readMail: async (o) => (asked.push(o), []) });
  assert.equal(asked[1].since, '2026-11-23');
  assert.equal(out.roles.length, 0); // 31 days since the last email named them
  // No sign-in: a plain note, and nothing is read.
  out = await readAlerts({ settings, env: {}, state, today: '2026-12-22', readMail: async () => assert.fail('must not read') });
  assert.match(out.error, /IMAP_USER and IMAP_PASSWORD/);
});

test('an alert role is scored from its title, employer and place, and the prompt says so', () => {
  const text = jobText({ company: 'Fabrikam Capital', title: 'Head of Payments', location: 'Pune', via: 'linkedin-alert', description: null }, 1000);
  assert.match(text, /Known only from a job-alert email/);
});

test('an unreadable mailbox is a problem, messaged after three days', () => {
  const state = emptyState();
  const settings = { dashboard: { url: '' }, report: { good_match: 65, show_from: 50, timezone: 'UTC' }, notify: { weekly: false }, job_alerts: { days: 30 } };
  const summary = { companies: [], ai: {}, alerts: { error: 'LOGIN: Invalid credentials' } };
  for (const day of ['2026-11-23', '2026-11-24', '2026-11-25']) trackProblems(state, summary, day);
  const [m] = planMessages({ state, summary, settings, minScore: 65, today: '2026-11-25' });
  assert.match(m.html, /Job-alert emails<\/b> unreadable for 3 days \(LOGIN: Invalid credentials\)/);
  trackProblems(state, { ...summary, alerts: { error: null } }, '2026-11-26');
  assert.deepEqual(state.problems, {});
});

test('a run: alert roles join the roles from careers sites, under your company names where they match', async () => {
  const dir = tempProject({
    companies: [
      { name: 'Contoso Pay', url: 'https://job-boards.greenhouse.io/contoso' },
      { name: 'Woodgrove Bank', url: 'https://careers.example.com/', platform: 'manual' },
    ],
    settings: {
      titles: { include: ['Head of', 'Director', 'Vice President', 'Architect'], exclude: ['Intern'] },
      job_alerts: { linkedin: true, ignore: ['Northwind Traders'] },
    },
  });
  const contoso = [
    { id: 9, title: 'Lead Architect', location: { name: 'Pune' }, absolute_url: 'https://job-boards.greenhouse.io/contoso/jobs/9', first_published: '2026-11-20T10:00:00Z', content: 'Payments platform.' },
    { id: 10, title: 'Director - Payments Architecture', location: { name: 'Pune' }, absolute_url: 'https://job-boards.greenhouse.io/contoso/jobs/10', first_published: '2026-11-20T10:00:00Z', content: 'Payments platform.' },
  ];
  const extra = [
    '---------------------------------------------------------',
    'Head of Engineering', 'Northwind Traders', 'Bengaluru',
    'View job: https://www.linkedin.com/comm/jobs/view/4000000004/?x=1',
    '---------------------------------------------------------',
    'Head of Trade Finance Technology', 'Contoso Pay India', 'Pune',
    'View job: https://www.linkedin.com/comm/jobs/view/4000000006/?x=1',
    '---------------------------------------------------------',
    'Director, Core Banking', 'Tailspin Bank', 'New York',
    'View job: https://www.linkedin.com/comm/jobs/view/4000000005/?x=1',
  ].join('\n');
  const mail = [{ from: 'jobalerts-noreply@linkedin.com', date: '2026-11-25T05:00:00Z', text: parseEmail(EML).text + '\n' + extra }];
  const env = { IMAP_USER: 'candidate@example.com', IMAP_PASSWORD: 'app-pass' };
  const stub = stubFetch([['boards-api.greenhouse.io', () => ({ jobs: contoso })]]);
  try {
    const first = await run(['--no-notify'], env, { dir, now: new Date('2026-11-25T03:00:00Z'), log: () => {}, readMail: async () => mail });
    const jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
    const woodgrove = jobs[alertKey('4000000001')];
    assert.equal(woodgrove.company, 'Woodgrove Bank'); // its careers site is checked by hand
    assert.equal(woodgrove.via, 'linkedin-alert');
    assert.equal(woodgrove.url, 'https://www.linkedin.com/jobs/view/4000000001/');
    assert.equal(jobs[alertKey('4000000003')].company, 'Fabrikam Capital'); // not one of your companies: kept under its own name
    assert.equal(jobs[alertKey('4000000002')], undefined); // Contoso Pay's own site lists the same title today
    assert.equal(jobs[alertKey('4000000006')].company, 'Contoso Pay'); // ...but not this one, so the alert keeps it
    assert.equal(jobs[alertKey('4000000004')], undefined); // ignored employer
    assert.equal(jobs[alertKey('4000000005')], undefined); // outside your places
    assert.ok(jobs['greenhouse:contoso:9']);
    assert.deepEqual(first.summary.alerts, { emails: 1, roles: 6, listed: 4, reposts: 0, onSite: 0, tooOld: 0, error: null });
    const site = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
    assert.match(site, /"via":"linkedin-alert"/);
    assert.match(site, /<select id="source" aria-label="Where the role was found"/); // the Source filter: careers sites or LinkedIn alerts
    assert.match(site, /alert: \{ one: 'LinkedIn alert', many: 'LinkedIn alerts'/);

    // 31 days on, no email has named them: they close. The careers-site role is untouched by this.
    await run(['--no-notify'], env, { dir, now: new Date('2026-12-26T03:00:00Z'), log: () => {}, readMail: async () => [] });
    const later = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
    assert.equal(later[alertKey('4000000001')].status, 'closed');
    assert.match(later[alertKey('4000000001')].closedReason, /job-alert email/);
    assert.equal(later['greenhouse:contoso:9'].status, 'open');
  } finally {
    stub.restore();
  }
});

test("once a company's own site lists an alert role, the role carries over there and is scored again with the posting", async () => {
  const dir = tempProject({
    companies: [{ name: 'Contoso Pay', url: 'https://job-boards.greenhouse.io/contoso' }],
    settings: { titles: { include: ['Director'], exclude: [] }, job_alerts: { linkedin: true } },
  });
  const mail = [{ from: 'jobalerts-noreply@linkedin.com', date: '2026-11-25T05:00:00Z', text: parseEmail(EML).text }];
  const env = { IMAP_USER: 'candidate@example.com', IMAP_PASSWORD: 'app-pass' };
  let siteUp = false;
  const posting = { id: 77, title: 'Director, Payments Architecture', location: { name: 'Pune, India' }, absolute_url: 'https://job-boards.greenhouse.io/contoso/jobs/77', first_published: '2026-11-20T10:00:00Z', content: 'Own the payments architecture.' };
  const stub = stubFetch([['boards-api.greenhouse.io', () => (siteUp ? { jobs: [posting] } : new Response('down', { status: 500 }))]]);
  try {
    await run(['--no-notify'], env, { dir, now: new Date('2026-11-25T03:00:00Z'), log: () => {}, readMail: async () => mail });
    let jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
    assert.equal(jobs[alertKey('4000000002')].company, 'Contoso Pay'); // its site could not be read today
    assert.equal(jobs[alertKey('4000000002')].score.scorer, 'keyword');
    siteUp = true;
    await run(['--no-notify'], env, { dir, now: new Date('2026-11-26T03:00:00Z'), log: () => {}, readMail: async () => mail });
    jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
    assert.equal(jobs[alertKey('4000000002')], undefined);
    const moved = jobs['greenhouse:contoso:77'];
    assert.deepEqual(moved.was, [alertKey('4000000002')]);
    assert.equal(moved.via, undefined);
    assert.equal(moved.firstSeen, '2026-11-25');
  } finally {
    stub.restore();
  }
});

test('reposts of one role, under new ids or one per city, are one role in all its cities: the scored one is kept, with the newest link', () => {
  const role = (id, location, firstSeen, lastSeen, title = 'VP Engineering (Core Platform)') => ({ company: 'Contoso Pay', role: { id, title, company: 'Contoso Pay', location, url: `https://www.linkedin.com/jobs/view/${id}/`, firstSeen, lastSeen } });
  const entries = [
    role('101', 'Bengaluru, Karnataka, India', '2026-11-10', '2026-11-12'),
    role('102', 'Bengaluru East, Karnataka, India', '2026-11-14', '2026-11-16'),
    role('103', 'Bengaluru, Karnataka, India', '2026-11-20', '2026-11-25'),
    role('104', 'India', '2026-11-22', '2026-11-22'), // only the country, which its cities already say
    role('105', 'Pune, Maharashtra, India', '2026-11-20', '2026-11-24'), // the same posting, listed for another city
    role('106', 'Bengaluru, Karnataka, India', '2026-11-21', '2026-11-21', 'Head of Payments'),
    role('107', 'Bengaluru, Karnataka, India', '2026-11-23', '2026-11-23'), // you made a call on it
  ];
  const { keep, copies } = collapseAlertRoles(entries, { prefer: (r) => (r.id === '102' ? 1 : 0), called: (r) => r.id === '107' });
  assert.deepEqual(keep.map((e) => e.role.id).sort(), ['102', '106', '107']);
  const kept = keep.find((e) => e.role.id === '102').role;
  assert.equal(kept.url, 'https://www.linkedin.com/jobs/view/103/'); // the newest email's link
  assert.equal(kept.firstSeen, '2026-11-14'); // ...but its own history
  assert.equal(kept.location, 'Bengaluru East, Karnataka, India; Pune, Maharashtra, India'); // one place per city
  assert.equal(keep.find((e) => e.role.id === '107').role.location, 'Bengaluru, Karnataka, India');
  assert.deepEqual([...copies].sort(), [['101', '102'], ['103', '102'], ['104', '102'], ['105', '102']]);
  // Nothing scored yet: the earliest one is kept.
  assert.equal(collapseAlertRoles(entries.slice(0, 3)).keep[0].role.id, '101');
});

test('places of one role: one per city, and a country only when no city in it is named', () => {
  assert.equal(placesOf(['Pune, Maharashtra, India', 'India', 'Bangalore Urban, Karnataka, India', 'Bengaluru, Karnataka, India']), 'Pune, Maharashtra, India; Bangalore Urban, Karnataka, India');
  assert.equal(placesOf(['Singapore, Singapore', 'India']), 'Singapore, Singapore; India');
  assert.equal(placesOf([null, '']), null);
});

test('a run: a role reposted under a new id stays one role, with its score', async () => {
  const dir = tempProject({ companies: [{ name: 'Woodgrove Bank', url: 'https://careers.example.com/', platform: 'manual' }], settings: { titles: { include: ['VP'], exclude: [] }, job_alerts: { linkedin: true } } });
  const card = (id, place) => ['---------------------------------------------------------', 'VP Engineering (Core Platform)', 'Contoso Pay', place, `View job: https://www.linkedin.com/comm/jobs/view/${id}/?x=1`].join('\n');
  const env = { IMAP_USER: 'candidate@example.com', IMAP_PASSWORD: 'app-pass' };
  const mail = [{ from: 'jobalerts-noreply@linkedin.com', date: '2026-11-24T05:00:00Z', text: card('4100000001', 'Bengaluru, Karnataka, India') }];
  await run(['--no-notify'], env, { dir, now: new Date('2026-11-24T03:00:00Z'), log: () => {}, readMail: async () => mail });
  let jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  const score = jobs[alertKey('4100000001')].score;
  assert.ok(score);
  const repost = [{ from: 'jobalerts-noreply@linkedin.com', date: '2026-11-25T05:00:00Z', text: [card('4100000002', 'Bengaluru, Karnataka, India'), card('4100000003', 'India')].join('\n') }];
  const second = await run(['--no-notify'], env, { dir, now: new Date('2026-11-25T03:00:00Z'), log: () => {}, readMail: async () => repost });
  jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  assert.deepEqual(Object.keys(jobs).filter((k) => k.startsWith('linkedin:')), [alertKey('4100000001')]);
  assert.equal(jobs[alertKey('4100000001')].url, 'https://www.linkedin.com/jobs/view/4100000003/'); // the newest repost's link
  assert.deepEqual(jobs[alertKey('4100000001')].score, score);
  assert.equal(jobs[alertKey('4100000001')].status, 'open');
  assert.equal(second.summary.alerts.reposts, 2);
  assert.equal(second.summary.alerts.listed, 1);
});

test("an alert for a role you already have from the company's own site is that role: it stays listed, or is listed again", async () => {
  const dir = tempProject({
    companies: [{ name: 'Contoso Pay', url: 'https://job-boards.greenhouse.io/contoso' }],
    settings: { titles: { include: ['Director'], exclude: [] }, job_alerts: { linkedin: true } },
  });
  const mail = [{ from: 'jobalerts-noreply@linkedin.com', date: '2026-11-25T05:00:00Z', text: parseEmail(EML).text }];
  const env = { IMAP_USER: 'candidate@example.com', IMAP_PASSWORD: 'app-pass' };
  let site = 'up';
  const posting = { id: 77, title: 'Director, Payments Architecture', location: { name: 'Pune, India' }, absolute_url: 'https://job-boards.greenhouse.io/contoso/jobs/77', first_published: '2026-11-10T10:00:00Z', content: 'Own the payments architecture.' };
  const stub = stubFetch([['boards-api.greenhouse.io', () => (site === 'up' ? { jobs: [posting] } : site === 'empty' ? { jobs: [] } : new Response('down', { status: 500 }))]]);
  const day = async (iso, readMail) => {
    const out = await run(['--no-notify'], env, { dir, now: new Date(`${iso}T03:00:00Z`), log: () => {}, readMail });
    return { summary: out.summary, jobs: JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs };
  };
  try {
    await day('2026-11-15', async () => []);
    // The site can't be read for over a week, but emails still name the role: it stays open, once.
    site = 'down';
    let { summary, jobs } = await day('2026-11-25', async () => mail);
    assert.equal(jobs[alertKey('4000000002')], undefined);
    assert.equal(summary.alerts.onSite, 1);
    assert.equal(jobs['greenhouse:contoso:77'].status, 'open');
    // The site no longer lists it, so it closes; a later email lists it again, with its history.
    site = 'empty';
    ({ jobs } = await day('2026-11-26', async () => []));
    assert.equal(jobs['greenhouse:contoso:77'].status, 'open'); // the email from the day before still names it
    ({ jobs } = await day('2026-12-27', async () => []));
    assert.equal(jobs['greenhouse:contoso:77'].status, 'closed');
    ({ jobs } = await day('2026-12-28', async () => [{ ...mail[0], date: '2026-12-28T05:00:00Z' }]));
    assert.equal(jobs['greenhouse:contoso:77'].status, 'open');
    assert.equal(jobs['greenhouse:contoso:77'].firstSeen, '2026-11-15');
    assert.equal(jobs['greenhouse:contoso:77'].closedReason, undefined);
    assert.equal(Object.keys(jobs).filter((k) => k.startsWith('linkedin:')).includes(alertKey('4000000002')), false);
  } finally {
    stub.restore();
  }
});

test("a LinkedIn job's posting day, worked out from its number and the newest numbers seen each day", () => {
  const clock = {};
  for (let d = 0; d <= 20; d++) clock[`2026-11-${String(d + 1).padStart(2, '0')}`] = 4400000000 + d * 300000;
  clock['2026-11-04'] = 4390000000; // that day's emails held only older roles
  const dated = postingDater(clock);
  assert.equal(dated(4406000000), '2026-11-21'); // the newest number on the last day
  assert.equal(dated(4403000000), '2026-11-11');
  assert.equal(dated(4400000000 - 30 * 300000), '2026-10-02');
  assert.equal(dated(4407000000), '2026-11-21'); // never after the last email
  assert.equal(dated('not a number'), null);
  // Notes that span less than a week date nothing.
  assert.equal(postingDater({ '2026-11-20': 4405700000, '2026-11-21': 4406000000, '2026-11-22': 4406300000 })(4400000000), null);
  assert.equal(postingDater(undefined)(4400000000), null);
});

test('a run: alert roles posted longer ago than max_age are left out and not scored; the rest carry their posting day', async () => {
  const dir = tempProject({ companies: [{ name: 'Woodgrove Bank', url: 'https://careers.example.com/', platform: 'manual' }], settings: { titles: { include: ['Director'], exclude: [] }, job_alerts: { linkedin: true } } });
  const card = (id, title, employer) => ['---------------------------------------------------------', title, employer, 'Pune, Maharashtra, India', `View job: https://www.linkedin.com/comm/jobs/view/${id}/?x=1`].join('\n');
  const at = (d) => 4400000000 + d * 300000; // numbers rise 300,000 a day from 1 Nov
  const email = (d, cards) => ({ from: 'jobalerts-noreply@linkedin.com', date: `2026-11-${String(d + 1).padStart(2, '0')}T05:00:00Z`, text: cards.join('\n') });
  const mail = [];
  for (let d = 0; d <= 20; d++) mail.push(email(d, [card(at(d), `Director, Filler ${d}`, 'Tailspin Bank')]));
  mail.push(email(20, [
    card(at(18), 'Director, Payments Platform', 'Fabrikam Capital'), // posted 19 Nov
    card(at(-40), 'Director, Core Banking', 'Contoso Pay'), // posted about 22 Sep
    card(at(-50), 'Director, Cards', 'Litware Bank'), // first posted in September...
    card(at(19), 'Director, Cards', 'Litware Bank'), // ...and reposted on 20 Nov
  ]));
  const env = { IMAP_USER: 'candidate@example.com', IMAP_PASSWORD: 'app-pass' };
  const { summary } = await run(['--no-notify'], env, { dir, now: new Date('2026-11-21T03:00:00Z'), log: () => {}, readMail: async () => mail });
  const jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  assert.equal(jobs[alertKey(String(at(18)))].postedAt, '2026-11-19');
  assert.equal(jobs[alertKey(String(at(-40)))], undefined);
  const cards = Object.values(jobs).filter((j) => j.title === 'Director, Cards');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].postedAt, '2026-11-20'); // dated by its newest repost
  assert.equal(summary.alerts.tooOld, 1);
});

test('an alert role already listed closes once its posting is older than max_age', async () => {
  const dir = tempProject({ companies: [{ name: 'Woodgrove Bank', url: 'https://careers.example.com/', platform: 'manual' }], settings: { titles: { include: ['Director'], exclude: [] }, job_alerts: { linkedin: true, max_age: 14 } } });
  const card = (id, title) => ['---------------------------------------------------------', title, 'Fabrikam Capital', 'Pune, Maharashtra, India', `View job: https://www.linkedin.com/comm/jobs/view/${id}/?x=1`].join('\n');
  const at = (d) => 4400000000 + d * 300000;
  const email = (d, cards) => ({ from: 'jobalerts-noreply@linkedin.com', date: `2026-11-${String(d + 1).padStart(2, '0')}T05:00:00Z`, text: cards.join('\n') });
  const mail = [];
  for (let d = 0; d <= 10; d++) mail.push(email(d, [card(at(d), `Director, Filler ${d}`)]));
  mail.push(email(10, [card(at(5), 'Director, Payments Platform')])); // posted 6 Nov
  const env = { IMAP_USER: 'candidate@example.com', IMAP_PASSWORD: 'app-pass' };
  await run(['--no-notify'], env, { dir, now: new Date('2026-11-11T03:00:00Z'), log: () => {}, readMail: async () => mail });
  let jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  assert.equal(jobs[alertKey(String(at(5)))].status, 'open');
  const later = [email(20, [card(at(20), 'Director, Filler 20'), card(at(5), 'Director, Payments Platform')])];
  await run(['--no-notify'], env, { dir, now: new Date('2026-11-21T03:00:00Z'), log: () => {}, readMail: async () => later });
  jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  assert.equal(jobs[alertKey(String(at(5)))].status, 'closed');
  assert.match(jobs[alertKey(String(at(5)))].closedReason, /posted about 2026-11-06, over 14 days ago/);
});
