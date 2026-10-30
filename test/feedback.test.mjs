// Your calls on the dashboard (Applied, Shortlist, Not for me): saved by the Worker, copied into
// data/feedback.json by each run with the posting text, and published back to the page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/dashboard/worker.js';
import { run } from '../src/run.mjs';
import { deploy, wranglerConfig } from '../src/deploy.mjs';
import { judgedRoles } from '../src/calibrate.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const quiet = () => {};

// ── the Worker ─────────────────────────────────────────────────────────────

function fakeKV() {
  const data = new Map();
  return {
    data,
    async put(key, value, { metadata } = {}) { data.set(key, { value, metadata }); },
    async list({ prefix = '' } = {}) {
      return { keys: [...data].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true };
    },
  };
}
const env = (kv = fakeKV()) => ({ FEEDBACK: kv, ASSETS: { fetch: async () => new Response('the page') } });
const signedIn = { 'cf-access-jwt-assertion': 'jwt' };
const post = (body, headers = {}) =>
  new Request('https://jobs.example.test/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://jobs.example.test', ...signedIn, ...headers }, body: JSON.stringify(body) });

test('the Worker saves a call and lists it back', async () => {
  const e = env();
  let res = await worker.fetch(post({ id: 'greenhouse-acme-1', verdict: 'not-for-me', reason: '  commercial   product role ' }), e);
  assert.equal(res.status, 200);
  const saved = e.FEEDBACK.data.get('fb:greenhouse-acme-1');
  assert.equal(saved.metadata.v, 'not-for-me');
  assert.equal(saved.metadata.r, 'commercial product role');
  res = await worker.fetch(new Request('https://jobs.example.test/api/feedback', { headers: signedIn }), e);
  assert.deepEqual(Object.keys((await res.json()).entries), ['greenhouse-acme-1']);
  // Cleared: kept as null, so the next run knows to drop it.
  await worker.fetch(post({ id: 'greenhouse-acme-1', verdict: null }), e);
  assert.equal(e.FEEDBACK.data.get('fb:greenhouse-acme-1').metadata.v, null);
});

test('the Worker refuses what did not come through your login, from elsewhere, or malformed', async () => {
  const e = env();
  const noLogin = new Request('https://jobs.example.test/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await worker.fetch(noLogin, e)).status, 403);
  assert.equal((await worker.fetch(post({ id: 'a', verdict: 'applied' }, { origin: 'https://evil.example' }), e)).status, 403);
  assert.equal((await worker.fetch(post({ id: 'a', verdict: 'maybe' }), e)).status, 400);
  assert.equal((await worker.fetch(post({ id: '../x', verdict: 'applied' }), e)).status, 400);
  assert.equal(e.FEEDBACK.data.size, 0);
  // A long reason is cut so the call fits in KV metadata (1024 bytes).
  await worker.fetch(post({ id: 'a', verdict: 'applied', reason: 'é'.repeat(600) }), e);
  assert.ok(new TextEncoder().encode(JSON.stringify(e.FEEDBACK.data.get('fb:a').metadata)).length <= 1000);
  // Everything else is the page.
  assert.equal(await (await worker.fetch(new Request('https://jobs.example.test/'), e)).text(), 'the page');
});

// ── publishing ──────────────────────────────────────────────────────────────

function builtSite() {
  const dir = mkdtempSync(join(tmpdir(), 'axia-deploy-'));
  mkdirSync(join(dir, '.axia/site'), { recursive: true });
  writeFileSync(join(dir, '.axia/site/index.html'), '<meta name="axia" content="private-dashboard">');
  return dir;
}
const dashboard = (extra = {}) => ({ dashboard: { url: '', worker: 'axia', domain: 'jobs.example.test', public: false, feedback: true, ...extra } });

test('deploy creates the feedback store once and binds it to the Worker', async () => {
  const configs = [];
  const cfCalls = [];
  const cfFetch = async (url, init) => {
    cfCalls.push([init.method, url]);
    return init.method === 'POST' ? Response.json({ success: true, result: { id: 'kv-new' } }) : Response.json({ success: true, result: [{ id: 'other', title: 'something' }] });
  };
  const wrangler = async (args) => (configs.push(JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'))), 'ok');
  const dir = builtSite();
  await deploy({ dir, env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc' }, settings: dashboard(), log: quiet, wrangler, check: async () => 'private', cfFetch });
  assert.deepEqual(cfCalls.map((c) => c[0]), ['GET', 'POST']);
  assert.equal(configs[0].main, 'worker.js');
  assert.deepEqual(configs[0].kv_namespaces, [{ binding: 'FEEDBACK', id: 'kv-new' }]);
  assert.equal(configs[0].assets.binding, 'ASSETS');
  assert.ok(existsSync(join(dir, '.axia/worker.js')));
  assert.ok(!existsSync(join(dir, '.axia/site/worker.js')), 'the Worker code is never published as a page file');
});

test('a failed store setup still publishes the page; a public demo and the empty placeholder never take writes', async () => {
  const configs = [];
  const logs = [];
  const wrangler = async (args) => (configs.push(JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'))), 'ok');
  const cfFetch = async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'Authentication error' }] }), { status: 403 });
  await deploy({ dir: builtSite(), env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc' }, settings: dashboard(), log: (l) => logs.push(l), wrangler, check: async () => 'private', cfFetch });
  assert.equal(configs[0].main, undefined);
  assert.match(logs.join('\n'), /Feedback buttons not connected: .*Authentication error/);

  await deploy({ dir: builtSite(), env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc' }, settings: dashboard({ public: true }), log: quiet, wrangler, check: async () => 'private', cfFetch: () => assert.fail('no store for a public page') });
  assert.equal(configs[1].main, undefined);
  assert.equal(wranglerConfig({ worker: 'axia', domain: 'x' }, '/s').main, undefined, 'the placeholder is a plain page');
});

// ── the run ─────────────────────────────────────────────────────────────────

const COMPANIES = [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }];
const gh = (id, title) => ({ id, title, location: { name: 'Pune' }, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, first_published: '2026-10-14T10:00:00Z', content: `&lt;p&gt;${title}: what the job is.&lt;/p&gt;` });
const JOBS = [gh(1, 'Solution Architect, Payments'), gh(2, 'Solution Architect, Data'), gh(3, 'Solution Architect, Cards')];
const CF = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc' };

function cloudflare(entries) {
  return ['api.cloudflare.com', (url) =>
    url.includes('/keys')
      ? { success: true, result: Object.entries(entries).map(([id, m]) => ({ name: `fb:${id}`, metadata: m })), result_info: { cursor: '' } }
      : { success: true, result: [{ id: 'kv1', title: 'axia-feedback' }] }];
}
async function day(dir, date, entries, { argv = ['--no-notify'] } = {}) {
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: JOBS })], cloudflare(entries)]);
  try {
    return await run(argv, CF, { dir, now: new Date(`${date}T03:00:00Z`), log: quiet });
  } finally {
    stub.restore();
  }
}
const feedbackFile = (dir) => JSON.parse(readFileSync(join(dir, 'data/feedback.json'), 'utf8'));

test('each run copies your calls into data/feedback.json with the posting, and shows them on the page', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { titles: { include: ['Solution Architect'], exclude: [] } } });
  await day(dir, '2026-10-15', {});
  assert.deepEqual(feedbackFile(dir).roles, {});

  await day(dir, '2026-10-16', {
    'greenhouse-acme-1': { v: 'applied', r: '', t: '2026-10-15T20:00:00Z' },
    'greenhouse-acme-2': { v: 'not-for-me', r: 'data platform, not payments', t: '2026-10-15T20:01:00Z' },
    'greenhouse-acme-999': { v: 'applied', r: '', t: '2026-10-15T20:02:00Z' }, // a role Axia no longer knows
  });
  let f = feedbackFile(dir);
  assert.deepEqual(Object.keys(f.roles), ['greenhouse:acme:1', 'greenhouse:acme:2']);
  const nfm = f.roles['greenhouse:acme:2'];
  assert.equal(nfm.verdict, 'not-for-me');
  assert.equal(nfm.reason, 'data platform, not payments');
  assert.match(nfm.description, /Solution Architect, Data: what the job is/, 'the posting is kept, so the call outlives the role');
  assert.equal(nfm.score.scorer, 'keyword');
  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  assert.match(html, /"feedback":\{"api":true,"entries":\{"greenhouse-acme-1":\{"v":"applied"/);

  // Cleared on the dashboard: gone from the file. Unchanged calls stay as they were.
  await day(dir, '2026-10-17', { 'greenhouse-acme-1': { v: 'applied', r: '', t: '2026-10-15T20:00:00Z' }, 'greenhouse-acme-2': { v: null, r: '', t: '2026-10-16T09:00:00Z' } });
  f = feedbackFile(dir);
  assert.deepEqual(Object.keys(f.roles), ['greenhouse:acme:1']);

  // Cloudflare unreachable: the run carries on and the calls already saved stay.
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: JOBS })], ['api.cloudflare.com', () => new Response('down', { status: 500 })]]);
  try {
    const out = await run(['--no-notify'], CF, { dir, now: new Date('2026-10-18T03:00:00Z'), log: quiet });
    assert.equal(out.exitCode, 0);
    assert.equal(out.summary.feedback.read, false);
  } finally {
    stub.restore();
  }
  assert.deepEqual(Object.keys(feedbackFile(dir).roles), ['greenhouse:acme:1']);

  // Calls become judged roles for calibrate and the weekly review.
  const judged = judgedRoles({ dir });
  assert.deepEqual(judged.map((r) => [r.source, r.decision, r.call]), [['dashboard', 'Apply', 'Applied']]);
});

// ── what came of an application: Rejected or Turned down ──────────────────

test('the Worker keeps an outcome on an Applied call only, and fits it in the metadata', async () => {
  const e = env();
  const outcome = { kind: 'rejected', reason: 'No reason given', stage: 'Before any call', note: '  LinkedIn   email ', at: '2026-10-26T18:10:00Z' };
  let res = await worker.fetch(post({ id: 'a', verdict: 'applied', reason: 'Good match', outcome }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(e.FEEDBACK.data.get('fb:a').metadata.o, { k: 'rejected', r: 'No reason given', s: 'Before any call', n: 'LinkedIn email', t: '2026-10-26T18:10:00Z' });
  // Back to In process: the outcome goes, the call stays.
  await worker.fetch(post({ id: 'a', verdict: 'applied', reason: 'Good match', outcome: null }), e);
  assert.equal(e.FEEDBACK.data.get('fb:a').metadata.o, undefined);
  assert.equal(e.FEEDBACK.data.get('fb:a').metadata.v, 'applied');
  assert.equal((await worker.fetch(post({ id: 'b', verdict: 'shortlist', outcome }), e)).status, 400, 'an outcome needs Applied');
  assert.equal((await worker.fetch(post({ id: 'b', verdict: 'applied', outcome: { kind: 'ghosted' } }), e)).status, 400);
  // Long reason and note are cut so the whole entry stays under 1024 bytes.
  await worker.fetch(post({ id: 'c', verdict: 'applied', reason: 'é'.repeat(240), outcome: { ...outcome, reason: 'é'.repeat(200), stage: 'é'.repeat(200), note: 'é'.repeat(240) } }), e);
  const big = e.FEEDBACK.data.get('fb:c').metadata;
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).length <= 1000);
  assert.equal(big.o.k, 'rejected');
});

test('outcomes are copied into data/feedback.json and back to the page; a call that leaves Applied drops it', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { titles: { include: ['Solution Architect'], exclude: [] } } });
  const o = { k: 'turned-down', r: 'Pay below expectations', s: 'After an offer', n: '', t: '2026-10-16T08:00:00Z' };
  await day(dir, '2026-10-16', { 'greenhouse-acme-1': { v: 'applied', r: '', t: '2026-10-16T08:00:00Z', o } });
  let r = feedbackFile(dir).roles['greenhouse:acme:1'];
  assert.deepEqual(r.outcome, { kind: 'turned-down', reason: 'Pay below expectations', stage: 'After an offer', note: '', at: '2026-10-16T08:00:00Z' });
  assert.ok(r.description, 'the posting is kept as before');
  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  assert.match(html, /"greenhouse-acme-1":\{"v":"applied","r":"","t":"2026-10-16T08:00:00Z","o":\{"k":"turned-down","r":"Pay below expectations"/);
  assert.match(html, /"outcomes":\{"rejected":\["No reason given",/, 'the reason lists reach the page');
  // A rejected role still counts as one you judged worth applying.
  assert.deepEqual(judgedRoles({ dir }).map((x) => x.decision), ['Apply']);

  await day(dir, '2026-10-17', { 'greenhouse-acme-1': { v: 'shortlist', r: '', t: '2026-10-17T08:00:00Z', o } });
  r = feedbackFile(dir).roles['greenhouse:acme:1'];
  assert.equal(r.verdict, 'shortlist');
  assert.equal(r.outcome, undefined);
});
