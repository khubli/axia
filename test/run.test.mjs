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

  const s2 = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  const byTitle = Object.fromEntries(Object.values(s2.jobs).map((j) => [j.title, j]));
  assert.equal(byTitle['Senior Solution Architect'].status, 'closed');
  assert.equal(byTitle['Senior Solution Architect'].closedOn, '2026-10-16');
  assert.equal(byTitle['Enterprise Architect - VP'].status, 'open', 'a board that failed to load must not close its roles');
  assert.equal(byTitle['Payments Architect'].score.value, 79);

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
