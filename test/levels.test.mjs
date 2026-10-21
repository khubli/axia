// A role's level against yours: asked in the same request as the score, and caught up for roles
// scored before it existed (or before levels.md changed) without re-scoring them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { cleanLevel, levelsRev } from '../src/levels.mjs';
import { catchUp, catchUpQueue, CATCH_UP_MAX } from '../src/catchup.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const gh = (id, title) => ({
  id,
  title,
  location: { name: 'Pune' },
  absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  first_published: '2026-10-14T10:00:00Z',
  content: '&lt;p&gt;Lead the payments architecture. 15+ years. Reports to the CTO.&lt;/p&gt;',
});
// Scores the fake gives: 81, 66 and 40 (below show_from 50, so never caught up).
const BOARD = [gh(1, 'Payments Architect'), gh(2, 'Vice President, Solution Architect'), gh(3, 'Junior-ish Architect')];
const COMPANIES = [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }];
const SCORE = { 'Payments Architect': 81, 'Vice President, Solution Architect': 66, 'Junior-ish Architect': 40 };
const LEVEL = { 'Payments Architect': 'same', 'Vice President, Solution Architect': 'up', 'Junior-ish Architect': 'down' };
const quiet = () => {};

/** A stand-in for `claude -p`: scoring requests get scores (with or without a level); catch-up requests get levels. */
function fakeClaude(calls, { withLevel = true } = {}) {
  return async (args, { input }) => {
    const system = readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
    const catchUp = args[1].startsWith('Answer for all');
    calls.push({ args, input, system, catchUp, schema: JSON.parse(args[args.indexOf('--json-schema') + 1]) });
    const jobs = [...input.matchAll(/<job id="(\d+)">\nCompany: .*\nTitle: (.*)/g)].map((m) => [m[1], m[2]]);
    const level = (title) => ({ vs: LEVEL[title], note: `≈ ${LEVEL[title]} as Director at Acme` });
    const results = catchUp
      ? jobs.map(([id, title]) => ({ id, level: level(title) }))
      : jobs.map(([id, title]) => ({ id, score: SCORE[title], summary: `Fit for ${title}.`, strengths: [], gaps: [], musts: [], ...(withLevel ? { level: level(title) } : {}) }));
    const structured = { results };
    return { code: 0, stderr: '', stdout: JSON.stringify({ is_error: false, structured_output: structured, modelUsage: { 'claude-sonnet-5-5': {} } }) };
  };
}

async function runOnce(dir, calls, opts, now) {
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: BOARD })]]);
  try {
    return await run(['--no-notify'], { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, { dir, now: new Date(now), log: quiet, scorerOverrides: { runClaude: fakeClaude(calls, opts) } });
  } finally {
    stub.restore();
  }
}
const jobsOf = (dir) => Object.fromEntries(Object.values(JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs).map((j) => [j.title, j]));

test('the level comes with the score, judged with your levels guide', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { scoring: { model: 'sonnet', max_ai_scores_per_run: 10, batch_size: 8, criteria: 'criteria.md', keywords: [] } } });
  const guide = '## Where I am now\nDirector at Acme. VP at other banks is the same level.';
  writeFileSync(join(dir, 'levels.md'), guide);
  const calls = [];
  await runOnce(dir, calls, {}, '2026-10-15T03:00:00Z');

  assert.equal(calls.length, 1, 'one scoring request, no extra request for the level');
  assert.ok(calls[0].schema.properties.results.items.required.includes('level'));
  assert.match(calls[0].system, /<levels>\n## Where I am now\nDirector at Acme/);
  assert.match(calls[0].system, /level: compare the job's level with the candidate's current level/);

  const jobs = jobsOf(dir);
  assert.deepEqual(jobs['Vice President, Solution Architect'].score.level, { vs: 'up', note: '≈ up as Director at Acme', rev: levelsRev(guide) });
  assert.equal(jobs['Payments Architect'].score.level.vs, 'same');

  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  assert.match(html, /"level":\{"vs":"up","note":"≈ up as Director at Acme"\}/, 'the dashboard gets the label, not the guide version');
});

test('roles scored before levels existed are caught up once, without re-scoring', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { scoring: { model: 'sonnet', max_ai_scores_per_run: 10, batch_size: 8, criteria: 'criteria.md', keywords: [] } } });
  const calls = [];
  await runOnce(dir, calls, { withLevel: false }, '2026-10-15T03:00:00Z'); // as an older version would have scored them
  const before = jobsOf(dir);
  assert.equal(before['Payments Architect'].score.level, undefined);

  calls.length = 0;
  await runOnce(dir, calls, {}, '2026-10-16T03:00:00Z');
  assert.equal(calls.length, 1, 'one catch-up request and no scoring');
  assert.ok(calls[0].catchUp);
  assert.deepEqual(Object.keys(calls[0].schema.properties.results.items.properties), ['id', 'level'], 'asks for the level only');
  assert.doesNotMatch(calls[0].input, /Junior-ish Architect/, 'a role below show_from is not caught up');
  const after = jobsOf(dir);
  assert.equal(after['Vice President, Solution Architect'].score.level.vs, 'up');
  assert.equal(after['Payments Architect'].score.value, before['Payments Architect'].score.value, 'the score is untouched');
  assert.equal(after['Payments Architect'].score.scoredOn, '2026-10-15');
  assert.equal(after['Junior-ish Architect'].score.level, undefined);

  calls.length = 0;
  await runOnce(dir, calls, {}, '2026-10-17T03:00:00Z');
  assert.equal(calls.length, 0, 'nothing left to catch up');

  // Editing levels.md re-labels the shown roles, still without re-scoring.
  writeFileSync(join(dir, 'levels.md'), 'Director at Acme.');
  await runOnce(dir, calls, {}, '2026-10-18T03:00:00Z');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].catchUp);
  assert.match(calls[0].system, /<levels>\nDirector at Acme\.\n<\/levels>/);
  assert.equal(jobsOf(dir)['Payments Architect'].score.level.rev, levelsRev('Director at Acme.'));
});

test('a malformed level is dropped, never shown', () => {
  assert.equal(cleanLevel(undefined), null);
  assert.equal(cleanLevel({ vs: 'sideways', note: 'x' }), null);
  assert.deepEqual(cleanLevel({ vs: 'down', note: '  ≈ Associate   Director ' }), { vs: 'down', note: '≈ Associate Director' });
  assert.deepEqual(cleanLevel({ vs: 'unclear', note: '' }), { vs: 'unclear' });
});

test('catch-up queue: shown or kept roles, best first, capped', () => {
  const field = { name: 'level', rev: 'r1' };
  const role = (key, value, level) => ({ key, status: 'open', score: { scorer: 'ai', value, ...(level ? { level } : {}) } });
  const open = [
    role('low', 30),
    role('kept', 30),
    role('done', 90, { vs: 'up', rev: 'r1' }),
    role('stale', 60, { vs: 'up', rev: 'r0' }),
    role('new', 80),
    { key: 'kw', status: 'open', score: { scorer: 'keyword', value: 70 } },
    role('unlisted', 95),
    role('today', 85),
  ];
  const q = catchUpQueue({ open, fields: [field], listedToday: (k) => k !== 'unlisted', scoredToday: new Set(['today']), showFrom: 50, kept: (k) => k === 'kept' });
  assert.deepEqual(q.map((j) => j.key), ['new', 'stale', 'kept']);
  const many = Array.from({ length: 100 }, (_, i) => role(`r${i}`, 60));
  assert.equal(catchUpQueue({ open: many, fields: [field], listedToday: () => true, scoredToday: new Set(), showFrom: 50, kept: () => false }).length, CATCH_UP_MAX);
});

test('catch-up asks only for the fields a batch is missing', async () => {
  const asked = [];
  const scorer = {
    async ask({ schema, input }) {
      const names = Object.keys(schema.properties.results.items.properties).filter((k) => k !== 'id');
      asked.push(names);
      const ids = [...input.matchAll(/<job id="(\d+)">/g)].map((m) => m[1]);
      return { data: { results: ids.map((id) => Object.fromEntries([['id', id], ...names.map((n) => [n, { v: n }])])) } };
    },
  };
  const field = (name, rev) => ({ name, rev, schema: { type: 'object' }, rules: `- ${name}`, guide: '', clean: (o) => o });
  const fields = [field('level', 'L2'), field('pay', 'P1')];
  const job = (key, score) => ({ key, company: 'A', title: 'T', location: 'Pune', description: 'd', score });
  const jobs = [job('a', { level: { rev: 'L1' }, pay: { rev: 'P1' } }), job('b', { level: { rev: 'L2' }, pay: { rev: 'P0' } })];
  const { answers } = await catchUp({ scorer, jobs, resume: 'r', fields, batchSize: 1 });
  assert.deepEqual(asked, [['level'], ['pay']]);
  assert.deepEqual(answers.get('a'), { level: { v: 'level', rev: 'L2' } });
  assert.deepEqual(answers.get('b'), { pay: { v: 'pay', rev: 'P1' } });
});
