// Scoring on a Claude subscription through `claude -p`, with the CLI replaced
// by a stand-in that records what it was asked and answers like the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { makeScorer } from '../src/score.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const gh = (id, title, location) => ({
  id,
  title,
  location: { name: location },
  absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  first_published: '2026-10-14T10:00:00Z',
  content: '&lt;p&gt;Own the payments architecture.&lt;/p&gt;',
});
const BOARD = [gh(1, 'Senior Solution Architect', 'Pune'), gh(2, 'Payments Architect', 'Pune'), gh(3, 'Enterprise Architect', 'Bengaluru')];
const COMPANIES = [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }];
const quiet = () => {};

/** Answers like `claude -p --output-format json --json-schema …` does. */
function fakeClaude(calls, { answer } = {}) {
  return async (args, { input, cwd, env }) => {
    calls.push({ args, input, cwd, env, system: readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8') });
    if (answer) return answer(calls.length, input);
    const ids = [...input.matchAll(/<job id="(\d+)">\nCompany: .*\nTitle: (.*)/g)].map((m) => [m[1], m[2]]);
    const structured = { results: ids.map(([id, title]) => ({ id, score: title.startsWith('Payments') ? 81 : 66, summary: `Fit for ${title}.`, strengths: ['payments'], gaps: ['no AWS'] })) };
    return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured, modelUsage: { 'claude-sonnet-5-5': {} } }) };
  };
}

test('subscription scoring: batched, no tools, schema-checked, your criteria included', async () => {
  const dir = tempProject({ companies: COMPANIES });
  const calls = [];
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: BOARD })]]);
  let out;
  try {
    out = await run(['--no-notify'], { CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: '' }, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet, scorerOverrides: { runClaude: fakeClaude(calls) } });
  } finally {
    stub.restore();
  }
  assert.equal(out.summary.ai.engine, 'Claude Code (your subscription)');
  assert.equal(out.summary.ai.scored, 3);
  assert.equal(calls.length, 2, '3 roles at batch_size 2 → 2 requests');

  const { args, input, env, system } = calls[0];
  assert.equal(args[0], '-p');
  assert.equal(args[args.indexOf('--tools') + 1], '', 'no tools: the model only reads and answers');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).required[0], 'results');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.match(input, /<job id="1">\nCompany: Acme Bank\nTitle: /);
  assert.match(system, /<resume>[\s\S]*Solution Architect[\s\S]*<\/resume>/);
  assert.match(system, /<criteria>\nPrefers Pune\. Not interested in QA roles\.\n<\/criteria>/);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  assert.equal('ANTHROPIC_API_KEY' in env, false, 'an empty API key must not shadow the subscription token');

  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  const byTitle = Object.fromEntries(Object.values(state.jobs).map((j) => [j.title, j.score]));
  assert.equal(byTitle['Payments Architect'].value, 81);
  assert.equal(byTitle['Payments Architect'].scorer, 'ai');
  assert.equal(byTitle['Payments Architect'].model, 'claude-sonnet-5-5');
  assert.match(readFileSync(join(dir, 'dashboard/README.md'), 'utf8'), /by Claude Code \(your subscription\), model claude-opus-5-5/);
});

test('a login or usage-limit problem stops after one request; keyword estimates fill in', async () => {
  const dir = tempProject({ companies: COMPANIES });
  const calls = [];
  const answer = () => ({ code: 1, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 3pm.' }) });
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: BOARD })]]);
  let out;
  try {
    out = await run(['--no-notify'], { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet, scorerOverrides: { runClaude: fakeClaude(calls, { answer }) } });
  } finally {
    stub.restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(out.exitCode, 0, 'the report still goes out');
  assert.match(out.summary.ai.stoppedBecause, /usage limit reached/);
  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  for (const j of Object.values(state.jobs)) assert.equal(j.score.scorer, 'keyword');
  assert.match(readFileSync(join(dir, 'dashboard/README.md'), 'utf8'), /AI scoring stopped early today: Claude Code: Claude usage limit reached/);
});

test('a missing claude binary is reported plainly', async () => {
  const scorer = makeScorer({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_BIN: '/nonexistent/claude' },
    settings: { scoring: { model: 'sonnet', batch_size: 8 } },
    resume: 'r',
    criteria: '',
  });
  const out = await scorer.scoreAll([{ key: 'k', company: 'A', title: 'T', location: 'Pune' }]);
  assert.equal(out.scores.size, 0);
  assert.match(out.stoppedBecause, /could not start claude/);
});

test('a role the model skipped stays unscored instead of getting a wrong score', async () => {
  const calls = [];
  const answer = () => {
    const structured = { results: [{ id: '2', score: 70, summary: 's', strengths: [], gaps: [] }, { id: '99', score: 99, summary: 'stray', strengths: [], gaps: [] }] };
    return { code: 0, stderr: '', stdout: JSON.stringify({ is_error: false, structured_output: structured }) };
  };
  const scorer = makeScorer({ env: {}, settings: { scoring: { model: 'sonnet', batch_size: 8 } }, resume: 'r', criteria: '', runClaude: fakeClaude(calls, { answer }) });
  const jobs = [1, 2].map((i) => ({ key: `k${i}`, company: 'A', title: `T${i}`, location: 'Pune' }));
  const out = await scorer.scoreAll(jobs);
  assert.deepEqual([...out.scores.keys()], ['k2']);
  assert.equal(out.failed, 1);
  assert.equal(out.stoppedBecause, null);
});

test('scorer choice follows the secrets present', () => {
  const base = { settings: { scoring: { model: 'sonnet' } }, resume: 'r', criteria: '' };
  assert.equal(makeScorer({ ...base, env: {} }), null);
  assert.equal(makeScorer({ ...base, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } }).engine, 'Claude Code (your subscription)');
  assert.equal(makeScorer({ ...base, env: { ANTHROPIC_API_KEY: 'k' } }).engine, 'Claude API');
  assert.equal(makeScorer({ ...base, env: { ANTHROPIC_API_KEY: 'k' } }).model, 'claude-sonnet-5-5', 'alias mapped to an API model id');
  assert.equal(makeScorer({ ...base, env: { AXIA_SCORER: 'claude-code' } }).engine, 'Claude Code (your subscription)');
});

test('calibrate compares AI scores with your own decisions', async () => {
  const { calibrate } = await import('../src/calibrate.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = tempProject({ companies: COMPANIES });
  mkdirSync(join(dir, 'calibration'));
  writeFileSync(join(dir, 'calibration/a.md'), 'Payments architecture role.');
  writeFileSync(join(dir, 'calibration/b.md'), 'Hands-on QA role.');
  writeFileSync(
    join(dir, 'calibration/roles.yml'),
    JSON.stringify([
      { file: 'a.md', company: 'Acme', title: 'Payments Architect', location: 'Pune', your_score: 4.4, decision: 'Apply' },
      { file: 'b.md', company: 'Acme', title: 'Payments QA Engineer', location: 'Pune', your_score: 2, decision: 'Skip' },
    ]),
  );
  const lines = [];
  const rows = await calibrate({ dir, env: {}, log: (l) => lines.push(l), scorerOverrides: { runClaude: fakeClaude([]) } });
  // The stand-in scores every "Payments…" title 81, so the Skip role is a disagreement.
  assert.deepEqual(rows.map((r) => [r.ai, r.agrees]), [[81, true], [81, false]]);
  assert.match(lines.join("\n"), /Agreement in all: 1\/2/);
  assert.match(lines.join('\n'), /Every Apply above every Skip: no/);
});
