// End to end: real run() over a throwaway folder, with every network call
// (job boards, Claude API, Telegram) answered by a local stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const COMPANIES = [
  { name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' },
  { name: 'Big Bank', url: 'https://bank.wd3.myworkdayjobs.com/en-US/Careers' },
  { name: 'Manual Co', url: 'https://careers.example.com/' },
];

const gh = (id, title, location, content = '<p>Own the payments architecture.</p>') => ({
  id,
  title,
  location: { name: location },
  absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  first_published: '2026-10-14T10:00:00Z',
  content: content.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
});

const DAY1_GH = [
  gh(1, 'Senior Solution Architect', 'Pune'),
  gh(2, 'Solution Architect Intern', 'Pune'),
  gh(3, 'Vice President, Payments Architecture', 'New York'),
  gh(4, 'Senior Solution Architect', 'Pune'), // same role posted twice
];

const workdayRoutes = (fail = false) => [
  ['bank.wd3.myworkdayjobs.com/wday/cxs/bank/Careers/jobs', () =>
    fail
      ? new Response('oops', { status: 500 })
      : { total: 1, jobPostings: [{ title: 'Enterprise Architect - VP', externalPath: '/job/Pune/Enterprise-Architect---VP_R-100', locationsText: '2 Locations', postedOn: 'Posted Yesterday' }] }],
  ['bank.wd3.myworkdayjobs.com/wday/cxs/bank/Careers/job/', () => ({
    jobPostingInfo: { jobDescription: '<p>Core banking target architecture.</p>', location: 'Pune, India', additionalLocations: ['Mumbai, India'], startDate: '2026-10-14' },
  })],
];

function claude(scores, requests) {
  return ['/v1/messages', (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, headers: new Headers(init.headers) });
    const title = body.messages[0].content.match(/Title: (.*)/)[1];
    const score = scores[title] ?? 50;
    return {
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: JSON.stringify({ score, summary: `Fit for ${title}.`, strengths: ['payments depth'], gaps: ['no AWS'] }) }],
      stop_reason: 'end_turn',
      stop_details: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
  }];
}

function telegram(sent) {
  return ['api.telegram.org', (url, init) => {
    sent.push({ url, init });
    return { ok: true, result: {} };
  }];
}

const ENV = { ANTHROPIC_API_KEY: 'test-key', TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42' };
const quiet = () => {};

test('daily runs: new, duplicate, out-of-area, closed, failed board, AI scores, messages', async () => {
  const dir = tempProject({ companies: COMPANIES });
  const requests = [];
  const sent = [];

  // ── Day 1 ──
  let stub = stubFetch([
    ['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: DAY1_GH })],
    ...workdayRoutes(),
    claude({ 'Senior Solution Architect': 88, 'Enterprise Architect - VP': 64 }, requests),
    telegram(sent),
  ]);
  let out;
  try {
    out = await run([], ENV, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.equal(out.exitCode, 0);
  assert.equal(out.summary.counts.new, 2);
  assert.equal(out.summary.counts.duplicates, 1);
  assert.equal(out.summary.ai.scored, 2);
  assert.deepEqual(out.delivery, [{ kind: 'digest', channel: 'telegram', ok: true }]);
  assert.equal(out.summary.changes.line, 'First run: 2 roles found in your titles and places.');

  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  const jobs = Object.values(state.jobs);
  assert.equal(jobs.length, 2);
  const wd = jobs.find((j) => j.company === 'Big Bank');
  assert.equal(wd.location, 'Pune, India; Mumbai, India', 'location read from the posting when the list said "2 Locations"');
  assert.equal(wd.score.value, 64);
  assert.equal(wd.score.scorer, 'ai');
  assert.equal(Object.keys(state.skipped).length, 0, 'roles with a listed location are not stored when filtered out');

  // The request the SDK actually sent.
  const { body, headers } = requests[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.fallbacks, 'default');
  assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.match(body.system[0].text, /<resume>[\s\S]*Solution Architect[\s\S]*<\/resume>/);
  assert.match(body.messages[0].content, /Company: Acme Bank\nTitle: Senior Solution Architect/);

  // One message: the new good match (88). 64 is below the line, so it waits on the dashboard.
  assert.equal(sent.length, 1);
  const msg = JSON.parse(sent[0].init.body);
  assert.equal(msg.parse_mode, 'HTML');
  assert.match(msg.text, /^<b>Axia<\/b> · 1 new good match/);
  assert.match(msg.text, /<b>88<\/b> · <a href="[^"]+">Senior Solution Architect<\/a>/);
  assert.doesNotMatch(msg.text, /Enterprise Architect - VP/);
  assert.match(msg.text, /https:\/\/example\.test\/dash\/#greenhouse-acme-1/);
  assert.equal(state.jobs['greenhouse:acme:1'].notifiedOn, '2026-10-15');

  const md = readFileSync(join(dir, 'dashboard/README.md'), 'utf8');
  assert.match(md, /\*\*88\*\* \| \[Senior Solution Architect\]/);
  assert.match(md, /Manual Co \| ✋ no public feed/);
  assert.match(md, /2 of 3 companies read \(1 checked by hand\)/);
  assert.equal(existsSync(join(dir, 'dashboard/index.html')), false, 'the dashboard is published, not committed');
  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  assert.match(html, /"title":"Senior Solution Architect"/);
  assert.ok(existsSync(join(dir, '.axia/site/manifest.webmanifest')));

  // ── Day 2: role 1 is gone, a new one appears, Workday is down ──
  requests.length = 0;
  sent.length = 0;
  stub = stubFetch([
    ['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: [gh(5, 'Payments Architect', 'Bengaluru')] })],
    ...workdayRoutes(true),
    claude({ 'Payments Architect': 79 }, requests),
    telegram(sent),
  ]);
  try {
    out = await run([], ENV, { dir, now: new Date('2026-10-16T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.equal(out.exitCode, 0, 'one failed board is a warning, not a failed run');
  assert.equal(out.summary.counts.new, 1);
  assert.equal(out.summary.counts.closedToday, 1);
  assert.equal(requests.length, 1, 'only the new role is sent to the AI; earlier scores are kept');

  // The brief of what changed, worked out without any AI request.
  const ch = out.summary.changes;
  assert.deepEqual(ch.new, ['greenhouse:acme:5']);
  assert.deepEqual(ch.closed, ['greenhouse:acme:1']);
  assert.deepEqual(ch.scored, ['greenhouse:acme:5']);
  assert.deepEqual(ch.notified, ['greenhouse:acme:5']);
  assert.deepEqual(ch.companies.unreadable, ['Big Bank']);
  assert.equal(ch.since, '2026-10-15T03:00:00.000Z');
  assert.equal(ch.line, '1 new role and 1 closed. Scored 1 role for the first time: 1 good match. 1 good match sent to you. Big Bank could not be read.');

  const s2 = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  const byTitle = Object.fromEntries(Object.values(s2.jobs).map((j) => [j.title, j]));
  assert.equal(byTitle['Senior Solution Architect'].status, 'closed');
  assert.equal(byTitle['Senior Solution Architect'].closedOn, '2026-10-16');
  assert.equal(byTitle['Enterprise Architect - VP'].status, 'open', 'a board that failed to load must not close its roles');
  assert.equal(byTitle['Payments Architect'].score.value, 79);
  assert.equal(s2.lastRun.changes.line, ch.line, 'the brief is kept in memory with the run');
  assert.deepEqual(s2.history.map((h) => [h.today, h.new, h.closed, h.scored, h.good]), [['2026-10-16', 1, 1, 1, 1], ['2026-10-15', 2, 0, 2, 1]]);
  assert.match(readFileSync(join(dir, 'dashboard/README.md'), 'utf8'), /\*\*What changed in this run:\*\* 1 new role and 1 closed\./);
  assert.match(readFileSync(join(dir, '.axia/site/index.html'), 'utf8'), /"brief":\{"line":"1 new role and 1 closed\./);

  assert.equal(sent.length, 1, 'one failed day is not worth a message yet');
  assert.match(JSON.parse(sent[0].init.body).text, /Payments Architect/);
  assert.equal(s2.problems['read:Big Bank'].since, '2026-10-16');
  assert.match(readFileSync(join(dir, 'dashboard/README.md'), 'utf8'), /⚠️ \*\*Big Bank\*\* could not be read today/);

  // ── Day 3: every readable board fails → the run fails loudly ──
  sent.length = 0;
  stub = stubFetch([...workdayRoutes(true), telegram(sent)]);
  try {
    out = await run([], ENV, { dir, now: new Date('2026-10-17T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.equal(out.exitCode, 1);
  assert.match(out.reason, /No company job board could be read/);
  assert.equal(sent.length, 0);
  const s3 = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  assert.equal(Object.values(s3.jobs).filter((j) => j.status === 'open').length, 2, 'nothing is closed on a day nothing could be read');
});

test('a bad API key stops AI scoring once; the run carries on with keyword estimates', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
  const sent = [];
  let anthropicCalls = 0;
  const stub = stubFetch([
    ['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: [gh(1, 'Senior Solution Architect', 'Pune'), gh(6, 'Payments Architect', 'Pune')] })],
    ['/v1/messages', () => {
      anthropicCalls++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    }],
    telegram(sent),
  ]);
  let out;
  try {
    out = await run([], ENV, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.equal(out.exitCode, 0);
  assert.equal(anthropicCalls, 1, 'a fatal error is not retried for every role');
  assert.match(out.summary.ai.stoppedBecause, /invalid x-api-key|401/);
  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  for (const j of Object.values(state.jobs)) assert.equal(j.score.scorer, 'keyword');
  assert.equal(sent.length, 0, 'one failed run is not a message; two in a row are');
  assert.match(readFileSync(join(dir, 'dashboard/README.md'), 'utf8'), /AI scoring stopped early today/);
  assert.ok(state.problems.ai);
});

test('no API key: keyword estimates; --dry-run writes and sends nothing', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: DAY1_GH })]]);
  let out;
  try {
    out = await run(['--dry-run'], { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' }, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.equal(out.summary.ai.enabled, false);
  assert.equal(out.summary.counts.open, 1);
  assert.deepEqual(out.delivery, []);
  assert.equal(stub.calls.some((c) => c.url.includes('telegram')), false);
  assert.equal(existsSync(join(dir, 'data/jobs.json')), false);
});

test('settings changes apply to remembered roles on the next run', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: DAY1_GH })]]);
  try {
    await run(['--no-notify'], {}, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
    const narrower = tempProject({ companies: COMPANIES.slice(0, 1), settings: { titles: { include: ['Enterprise Architect'], exclude: [] } } });
    // Same memory, narrower titles.
    const { copyFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(narrower, 'data'));
    copyFileSync(join(dir, 'data/jobs.json'), join(narrower, 'data/jobs.json'));
    const out = await run(['--no-notify'], {}, { dir: narrower, now: new Date('2026-10-16T03:00:00Z'), log: quiet });
    assert.equal(out.summary.counts.open, 0);
  } finally {
    stub.restore();
  }
});

test('when the kept copy of a twice-posted role is taken down, the role carries on under the other copy', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
  const day = (jobs, date) => {
    const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs })]]);
    return run(['--no-notify'], {}, { dir, now: new Date(`${date}T03:00:00Z`), log: quiet }).finally(() => stub.restore());
  };
  let out = await day([gh(1, 'Senior Solution Architect', 'Pune'), gh(4, 'Senior Solution Architect', 'Pune')], '2026-10-15');
  assert.equal(out.summary.counts.duplicates, 1);
  const before = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs['greenhouse:acme:1'];

  out = await day([gh(4, 'Senior Solution Architect', 'Pune')], '2026-10-16');
  assert.equal(out.summary.counts.open, 1, 'still open');
  assert.equal(out.summary.counts.new, 0, 'not announced as new');
  assert.equal(out.summary.counts.closedToday, 0);
  const jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  assert.deepEqual(Object.keys(jobs), ['greenhouse:acme:4']);
  assert.equal(jobs['greenhouse:acme:4'].firstSeen, before.firstSeen);
  assert.deepEqual(jobs['greenhouse:acme:4'].score, before.score, 'score kept');
  assert.equal(jobs['greenhouse:acme:4'].url, 'https://job-boards.greenhouse.io/acme/jobs/4');
});

test('postings with the same title and place but different descriptions are different roles', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1), settings: { titles: { include: ['Engineering Manager'], exclude: [] } } });
  const boilerplate = '<p>About Acme Bank: a bank for everyone, with flexible working, a great culture and equal opportunity for all.</p>';
  const stub = stubFetch([
    ['boards-api.greenhouse.io/v1/boards/acme', () => ({
      jobs: [
        gh(1, 'Engineering Manager', 'Pune', `<p>Lead the team building our case-management platform on Pega.</p>${boilerplate}`),
        gh(2, 'Engineering Manager', 'Pune', `<p>Lead enterprise storage engineering: SAN, backup and recovery.</p>${boilerplate}`),
        gh(3, 'Engineering Manager', 'Pune', `<p>Lead the team building our case-management platform on Pega.</p>${boilerplate}`),
      ],
    })],
  ]);
  let out;
  try {
    out = await run(['--no-notify'], {}, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.equal(out.summary.counts.new, 2, 'the storage role is its own role');
  assert.equal(out.summary.counts.duplicates, 1, 'the repost of the Pega role is not');
  const jobs = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  assert.deepEqual(Object.keys(jobs).sort(), ['greenhouse:acme:1', 'greenhouse:acme:2']);
  assert.deepEqual(jobs['greenhouse:acme:1'].copies, ['greenhouse:acme:3']);
});

test('upgrading memory marks only matches scored before this run; a match scored today is still sent', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const old = { key: 'greenhouse:acme:1', company: 'Acme Bank', title: 'Senior Solution Architect', location: 'Pune', url: 'u1', firstSeen: '2026-10-14', status: 'open', titleMatch: 'Solution Architect', score: { value: 90, scorer: 'ai', summary: 's', strengths: [], gaps: [], resumeHash: 'x' } };
  // Version 1 memory, as the daily-digest version left it.
  writeFileSync(join(dir, 'data/jobs.json'), JSON.stringify({ version: 1, lastRun: { runAt: '2026-10-14T03:00:00Z' }, jobs: { [old.key]: old }, skipped: {}, companies: {} }));
  const sent = [];
  const stub = stubFetch([
    ['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: [gh(1, 'Senior Solution Architect', 'Pune'), gh(6, 'Payments Architect', 'Pune')] })],
    claude({ 'Senior Solution Architect': 90, 'Payments Architect': 77 }, []),
    telegram(sent),
  ]);
  try {
    await run(['--max-ai', '1'], ENV, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.equal(sent.length, 1);
  const text = JSON.parse(sent[0].init.body).text;
  assert.match(text, /<b>77<\/b> · <a href="[^"]+">Payments Architect<\/a>/, "scored today: sent");
  assert.doesNotMatch(text, /Senior Solution Architect/, 'scored before the upgrade: already seen');
});

test('a role you shortlist while it waits is scored first, ahead of stronger titles', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
  const { writeFileSync } = await import('node:fs');
  const jobs = [gh(1, 'Senior Solution Architect', 'Pune'), gh(6, 'Data Architect', 'Pune')];
  let stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs })]]);
  try {
    await run(['--no-notify'], {}, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet }); // keyword estimates only
  } finally {
    stub.restore();
  }
  writeFileSync(join(dir, 'data/feedback.json'), JSON.stringify({ version: 1, lastReview: null, roles: { 'greenhouse:acme:6': { id: 'greenhouse-acme-6', company: 'Acme Bank', title: 'Data Architect', verdict: 'shortlist', reason: '', at: '2026-10-15T05:00:00Z' } } }));
  const requests = [];
  stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs })], claude({}, requests)]);
  try {
    await run(['--max-ai', '1', '--no-notify'], ENV, { dir, now: new Date('2026-10-16T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  assert.equal(state.jobs['greenhouse:acme:6'].score.scorer, 'ai', 'shortlisted: scored first');
  assert.equal(state.jobs['greenhouse:acme:1'].score.scorer, 'keyword', 'the stronger title waits');
});

test('a settings.yml edit re-ranks roles already waiting for a score', async () => {
  const jobs = [gh(1, 'Senior Architect', 'Pune', ''), gh(6, 'Technology Architect', 'Pune', '')];
  const first = tempProject({ companies: COMPANIES.slice(0, 1), settings: { titles: { include: ['Architect'], exclude: [] } } });
  let stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs })]]);
  try {
    await run(['--no-notify'], {}, { dir: first, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  const before = JSON.parse(readFileSync(join(first, 'data/jobs.json'), 'utf8')).jobs;
  assert.ok(before['greenhouse:acme:1'].score.value > before['greenhouse:acme:6'].score.value, 'day one: the senior title leads');
  // Same memory; "Technology Architect" is now a target title of its own.
  const dir = tempProject({ companies: COMPANIES.slice(0, 1), settings: { titles: { include: ['Architect', 'Technology Architect'], exclude: [] } } });
  const { copyFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'data'));
  copyFileSync(join(first, 'data/jobs.json'), join(dir, 'data/jobs.json'));
  stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs })], claude({}, [])]);
  try {
    await run(['--max-ai', '1', '--no-notify'], ENV, { dir, now: new Date('2026-10-16T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  const after = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs;
  assert.equal(after['greenhouse:acme:6'].score.scorer, 'ai');
  assert.equal(after['greenhouse:acme:1'].score.scorer, 'keyword');
});

test('--max-ai caps AI scores for this run only; empty keeps settings.yml', async () => {
  const board = [gh(1, 'Senior Solution Architect', 'Pune'), gh(6, 'Payments Architect', 'Pune'), gh(7, 'Data Architect', 'Pune')];
  const scoredWith = async (args) => {
    const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
    const stub = stubFetch([
      ['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: board })],
      claude({ 'Senior Solution Architect': 60, 'Payments Architect': 55, 'Data Architect': 50 }, []),
    ]);
    try {
      await run([...args, '--no-notify'], ENV, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
    } finally {
      stub.restore();
    }
    const { jobs } = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
    return Object.values(jobs).filter((j) => j.score?.scorer === 'ai').length;
  };
  assert.equal(await scoredWith(['--max-ai', '2']), 2);
  assert.equal(await scoredWith(['--max-ai', '']), 3, 'empty, as the action passes when the box is left blank');
  assert.equal(await scoredWith([]), 3);
});

test('a --max-ai that is not a whole number stops the run before anything is read', async () => {
  const dir = tempProject({ companies: COMPANIES.slice(0, 1) });
  const stub = stubFetch([]);
  try {
    await assert.rejects(run(['--max-ai', 'lots'], ENV, { dir, log: quiet }), /must be a whole number such as 100, not "lots"/);
    await assert.rejects(run(['--max-ai=-5'], ENV, { dir, log: quiet }), /whole number/);
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 0);
});
