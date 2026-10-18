// The weekly review: proposes a criteria.md change only when it makes the scores agree with your calls
// more often, proven by scoring your judged roles with and without it, and only as a pull request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { review } from '../src/review.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const quiet = () => {};
const RULE = 'Data platform roles are a poor fit for me.';

/** Three calls; today every role scores 75 (good match is 70), so "Not for me" on the data role disagrees. */
function project({ calls = 3, settings = {} } = {}) {
  const dir = tempProject({ companies: [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }], settings: { report: { timezone: 'UTC', good_match: 70, show_from: 50 }, ...settings } });
  const role = (n, title, verdict, reason = '') => [`greenhouse:acme:${n}`, { id: `greenhouse-acme-${n}`, company: 'Acme Bank', title, location: 'Pune', url: 'https://x', verdict, reason, at: `2026-10-1${n}T10:00:00Z`, score: { value: 75, scorer: 'ai' }, description: `${title}: what the job is.` }];
  const roles = [role(1, 'Solution Architect, Payments', 'applied'), role(2, 'Solution Architect, Data', 'not-for-me', 'data platform, not payments'), role(3, 'Solution Architect, Cards', 'shortlist')].slice(0, calls);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data/feedback.json'), JSON.stringify({ version: 1, lastReview: null, roles: Object.fromEntries(roles) }));
  return dir;
}

/**
 * A Claude API stand-in. Scoring: 30 for a data role when the criteria carry RULE, else 75.
 * The review's question returns `proposal` (by default: add RULE).
 */
function claude(requests, proposal = (criteria) => ({ changes: [{ change: 'Data platform roles count against a role.', why: 'Answers call 1.' }], criteria: `${criteria}\n${RULE}` })) {
  return ['/v1/messages', (_url, init) => {
    const body = JSON.parse(init.body);
    const system = body.system[0].text;
    const isReview = system.includes('keep the written criteria');
    requests.push(isReview ? 'review' : 'score');
    const criteria = system.match(/<criteria>\n([\s\S]*?)\n<\/criteria>/)[1];
    const text = isReview
      ? JSON.stringify(proposal(criteria))
      : JSON.stringify({ score: criteria.includes(RULE) && /Data/.test(body.messages[0].content) ? 30 : 75, summary: 'ok', strengths: [], gaps: [] });
    return { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } };
  }];
}

function githubApi(calls, { openPulls = [], canOpenPull = true } = {}) {
  return ['api.github.com/repos/me/private', (url, init) => {
    const method = init.method ?? 'GET';
    const path = url.replace('https://api.github.com/repos/me/private', '');
    calls.push([method, path.split('?')[0], init.body ? JSON.parse(init.body) : null]);
    if (method === 'GET' && path.startsWith('/pulls')) return openPulls;
    if (method === 'GET' && path.startsWith('/git/ref/heads/main')) return { object: { sha: 'base-sha' } };
    if (method === 'POST' && path === '/git/refs') return new Response('{}', { status: 201 });
    if (method === 'GET' && path.startsWith('/contents/')) return { sha: 'file-sha' };
    if (method === 'PUT') return { content: {} };
    if (method === 'POST' && path === '/pulls') return canOpenPull ? { html_url: 'https://github.com/me/private/pull/7' } : new Response(JSON.stringify({ message: 'GitHub Actions is not permitted to create or approve pull requests.' }), { status: 403 });
    return new Response('{}', { status: 404 });
  }];
}
const ENV = (dir) => ({ ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'gh', GITHUB_REPOSITORY: 'me/private', GITHUB_REF_NAME: 'main', GITHUB_WORKSPACE: dir });

async function go(dir, routes, { argv = ['--now'], now = new Date('2026-10-18T03:00:00Z'), log = quiet } = {}) {
  const stub = stubFetch(routes);
  try {
    return await review(argv, ENV(dir), { dir, now, log });
  } finally {
    stub.restore();
  }
}

test('a change that agrees with your calls more often is proposed as a pull request', async () => {
  const dir = project();
  const requests = [];
  const gh = [];
  const out = await go(dir, [claude(requests), githubApi(gh)]);
  assert.equal(out.status, 'proposed');
  assert.deepEqual([out.agreeBefore, out.agreeAfter], [2, 3]);
  assert.equal(out.url, 'https://github.com/me/private/pull/7');
  assert.equal(requests.filter((r) => r === 'review').length, 1);
  assert.equal(requests.filter((r) => r === 'score').length, 6, 'every judged role scored twice: today\'s criteria and the proposal');

  const put = gh.find(([m]) => m === 'PUT');
  assert.equal(put[1], '/contents/criteria.md');
  assert.equal(put[2].branch, 'axia/review-2026-10-18');
  assert.equal(put[2].sha, 'file-sha');
  assert.match(Buffer.from(put[2].content, 'base64').toString(), new RegExp(`Not interested in QA roles\\.\\n${RULE}`), 'your criteria, with the one line added');
  const pr = gh.find(([m, p]) => m === 'POST' && p === '/pulls')[2];
  assert.match(pr.body, /\*\*Agreement with your judged roles: 2 of 3 today → 3 of 3 with this change\.\*\*/);
  assert.match(pr.body, /Solution Architect, Data · Acme Bank \| Not for me _\(data platform, not payments\)_ \| 75 ✗ \| 30 ✓/);
  assert.equal(readFileSync(join(dir, 'criteria.md'), 'utf8'), 'Prefers Pune. Not interested in QA roles.', 'your file is untouched until you merge');
  assert.equal(JSON.parse(readFileSync(join(dir, 'data/feedback.json'), 'utf8')).lastReview, '2026-10-18');
});

test('when Actions may not open pull requests, the change is left on a branch with a link to open one', async () => {
  const dir = project();
  const logs = [];
  const out = await go(dir, [claude([]), githubApi([], { canOpenPull: false })], { log: (l) => logs.push(l) });
  assert.equal(out.url, 'https://github.com/me/private/compare/main...axia/review-2026-10-18?expand=1');
  assert.match(logs.join('\n'), /could not open a pull request: .*not permitted/);
});

test('a change that does not agree with you more often is not proposed', async () => {
  const dir = project();
  const gh = [];
  const out = await go(dir, [claude([], (criteria) => ({ changes: [{ change: 'Prefer banks.', why: '' }], criteria: `${criteria}\nI prefer banks.` })), githubApi(gh)]);
  assert.equal(out.status, 'not better');
  assert.deepEqual(gh.map(([m, p]) => `${m} ${p}`), ['GET /pulls'], 'no branch, no pull request');
  assert.ok(existsSync(join(dir, '.axia/review/report.md')), 'what was tried is kept locally');
});

test('nothing runs when the scores already agree, there are too few calls, or last week\'s proposal is open', async () => {
  const requests = [];
  // Too few calls.
  assert.equal((await go(project({ calls: 2 }), [claude(requests), githubApi([])])).status, 'too few');
  // Every call agrees with today's score.
  const dir = project();
  const f = JSON.parse(readFileSync(join(dir, 'data/feedback.json'), 'utf8'));
  f.roles['greenhouse:acme:2'].score.value = 40;
  writeFileSync(join(dir, 'data/feedback.json'), JSON.stringify(f));
  assert.equal((await go(dir, [claude(requests), githubApi([])])).status, 'agrees');
  // An earlier proposal still open.
  const out = await go(project(), [claude(requests), githubApi([], { openPulls: [{ head: { ref: 'axia/review-2026-10-11' }, html_url: 'https://github.com/me/private/pull/6' }] })]);
  assert.equal(out.status, 'pending');
  assert.deepEqual(requests, [], 'no AI spent');
});

test('without --now it runs only on review.day, once', async () => {
  const dir = project({ settings: { review: { day: 'sunday' } } });
  const requests = [];
  const saturday = new Date('2026-10-17T03:00:00Z');
  const sunday = new Date('2026-10-18T03:00:00Z');
  assert.equal((await go(dir, [claude(requests), githubApi([])], { argv: [], now: saturday })).status, 'not due');
  assert.equal((await go(dir, [claude(requests), githubApi([])], { argv: [], now: sunday })).status, 'proposed');
  assert.equal((await go(dir, [claude(requests), githubApi([])], { argv: [], now: sunday })).status, 'not due', 'once a day');
  const off = project({ settings: { review: { day: false } } });
  assert.equal((await go(off, [claude([]), githubApi([])], { argv: [], now: sunday })).status, 'off');
});

test('a workflow token without pull-request access still gets the change onto a branch', async () => {
  const dir = project();
  const api = githubApi([], { canOpenPull: false });
  const handler = api[1];
  api[1] = (url, init) => ((init.method ?? 'GET') === 'GET' && url.includes('/pulls') ? new Response('{"message":"Resource not accessible by integration"}', { status: 403 }) : handler(url, init));
  const out = await go(dir, [claude([]), api]);
  assert.equal(out.status, 'proposed');
  assert.match(out.url, /compare\/main\.\.\.axia\/review-2026-10-18/);
});
