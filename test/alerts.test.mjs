// Job-alert emails: the email text, the LinkedIn cards in it, the read-only mailbox session,
// and alert roles going through a whole run. Every company, role and address here is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { parseEmail, readMailbox, internalDate, MailError } from '../src/mail.mjs';
import { parseLinkedIn, readAlerts, trackedCompany, ignored, alertKey } from '../src/alerts.mjs';
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
    assert.deepEqual(first.summary.alerts, { emails: 1, roles: 6, listed: 4, error: null });
    const site = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
    assert.match(site, /"via":"linkedin-alert"/);

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
