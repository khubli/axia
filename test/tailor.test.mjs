// Tailor requests: the dashboard's "Tailor for this role" button, queued for your own tailoring tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../src/dashboard/worker.js';
import { run } from '../src/run.mjs';
import { loadSettings, ConfigError } from '../src/config.mjs';
import { applyTailor, pageTailor, tailorRequest } from '../src/tailor.mjs';
import { deploy } from '../src/deploy.mjs';
import { mkdirSync } from 'node:fs';
import { tempProject, stubFetch } from './helpers.mjs';

const quiet = () => {};

// ── settings ────────────────────────────────────────────────────────────────

test('tailor is off by default, and true or { enabled } turns it on', () => {
  const off = tempProject({ companies: [] });
  assert.deepEqual(loadSettings(off).tailor, { enabled: false, done: 'tailored.json', dispatch: '', workflow: 'tailor.yml', ref: 'main' });
  const on = tempProject({ companies: [], settings: { tailor: true } });
  assert.deepEqual(loadSettings(on).tailor, { enabled: true, done: 'tailored.json', dispatch: '', workflow: 'tailor.yml', ref: 'main' });
  const custom = tempProject({ companies: [], settings: { tailor: { enabled: true, done: 'out/done.json' } } });
  assert.equal(loadSettings(custom).tailor.done, 'out/done.json');
  const bad = tempProject({ companies: [], settings: { tailor: { enabled: 'yes' } } });
  assert.throws(() => loadSettings(bad), ConfigError);
  const repo = tempProject({ companies: [], settings: { tailor: { enabled: true, dispatch: 'me/my-axia' } } });
  assert.equal(loadSettings(repo).tailor.dispatch, 'me/my-axia');
  assert.throws(() => loadSettings(tempProject({ companies: [], settings: { tailor: { enabled: true, dispatch: 'https://x' } } })), ConfigError);
});

// ── the Worker ──────────────────────────────────────────────────────────────

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
const signedIn = { 'cf-access-jwt-assertion': 'jwt' };
const post = (path, body) =>
  new Request(`https://jobs.example.test/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://jobs.example.test', ...signedIn }, body: JSON.stringify(body) });

test('the Worker keeps Tailor requests apart from your calls', async () => {
  const kv = fakeKV();
  const e = { FEEDBACK: kv, ASSETS: { fetch: async () => new Response('the page') } };
  let res = await worker.fetch(post('tailor', { id: 'greenhouse-acme-1', on: true, note: '  stress   payments  ' }), e);
  assert.equal(res.status, 200);
  await worker.fetch(post('feedback', { id: 'greenhouse-acme-1', verdict: 'shortlist' }), e);
  assert.deepEqual([...kv.data.keys()].sort(), ['fb:greenhouse-acme-1', 'tr:greenhouse-acme-1']);
  res = await worker.fetch(new Request('https://jobs.example.test/api/tailor', { headers: signedIn }), e);
  const { entries } = await res.json();
  assert.deepEqual(Object.keys(entries), ['greenhouse-acme-1']);
  assert.equal(entries['greenhouse-acme-1'].on, true);
  assert.equal(entries['greenhouse-acme-1'].n, 'stress payments');
  res = await worker.fetch(new Request('https://jobs.example.test/api/feedback', { headers: signedIn }), e);
  assert.deepEqual(Object.keys((await res.json()).entries), ['greenhouse-acme-1'], 'calls list only calls');
  assert.equal((await worker.fetch(post('tailor', { id: 'a', on: 'yes' }), e)).status, 400);
  assert.equal((await worker.fetch(post('tailor', { id: '../a', on: true }), e)).status, 400);
  assert.equal((await worker.fetch(new Request('https://jobs.example.test/api/tailor'), e)).status, 403, 'not through your login');
});

test('with a repository and token set, a Tailor click starts its workflow at once', async () => {
  const kv = fakeKV();
  const e = { FEEDBACK: kv, ASSETS: { fetch: async () => new Response('') }, TAILOR_REPO: 'me/my-axia', TAILOR_TOKEN: 'ghp_x' };
  const stub = stubFetch([['api.github.com/repos/me/my-axia/actions/workflows/tailor.yml/dispatches', () => new Response(null, { status: 204 })]]);
  try {
    let res = await (await worker.fetch(post('tailor', { id: 'workday-acme-1', on: true, note: 'stress payments' }), e)).json();
    assert.equal(res.started, true);
    const call = stub.calls.find((c) => c.url.includes('/dispatches'));
    assert.equal(call.init.headers.Authorization, 'Bearer ghp_x');
    const body = JSON.parse(call.init.body);
    assert.equal(body.ref, 'main');
    assert.equal(body.inputs.id, 'workday-acme-1');
    assert.equal(body.inputs.note, 'stress payments');
    assert.equal(typeof body.inputs.at, 'string');
    // Cancelling starts nothing; without the token nothing is started either.
    res = await (await worker.fetch(post('tailor', { id: 'workday-acme-1', on: false }), e)).json();
    assert.equal(res.started, false);
    res = await (await worker.fetch(post('tailor', { id: 'workday-acme-1', on: true }), { ...e, TAILOR_TOKEN: undefined })).json();
    assert.equal(res.started, false);
    assert.equal(stub.calls.filter((c) => c.url.includes('/dispatches')).length, 1);
  } finally {
    stub.restore();
  }
});

test('deploy gives the Worker the repository as a setting and the token as a secret', async () => {
  const dir = tempProject({ companies: [] });
  mkdirSync(join(dir, '.axia/site'), { recursive: true });
  writeFileSync(join(dir, '.axia/site/index.html'), 'x');
  const calls = [];
  const configs = [];
  const wrangler = async (args) => {
    calls.push(args);
    if (args[0] === 'deploy') configs.push(JSON.parse(readFileSync(args[2], 'utf8')));
    if (args[0] === 'secret') assert.deepEqual(JSON.parse(readFileSync(args[2], 'utf8')), { TAILOR_TOKEN: 'ghp_x' });
    return '';
  };
  const cfFetch = async () => new Response(JSON.stringify({ success: true, result: [{ id: 'kv1', title: 'axia-feedback' }] }));
  const settings = { dashboard: { worker: 'axia', domain: 'jobs.example.test', public: false, feedback: true }, tailor: { enabled: true, done: 'tailored.json', dispatch: 'me/my-axia', workflow: 'tailor.yml', ref: 'main' } };
  const env = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc', AXIA_TAILOR_TOKEN: 'ghp_x' };
  await deploy({ dir, env, settings, log: quiet, wrangler, check: async () => 'private', cfFetch });
  assert.deepEqual(configs[0].vars, { TAILOR_REPO: 'me/my-axia', TAILOR_WORKFLOW: 'tailor.yml', TAILOR_REF: 'main' });
  assert.ok(!JSON.stringify(configs[0]).includes('ghp_x'), 'the token is never in the config file');
  assert.equal(calls[1][0], 'secret');
  assert.ok(!existsSync(join(dir, '.axia/tailor-secret.json')), 'the secret file is removed');

  // No token: published as before, clicks wait for the nightly run.
  const logs = [];
  calls.length = 0;
  await deploy({ dir, env: { ...env, AXIA_TAILOR_TOKEN: '' }, settings, log: (l) => logs.push(l), wrangler, check: async () => 'private', cfFetch });
  assert.deepEqual(calls.map((c) => c[0]), ['deploy']);
  assert.match(logs.join('\n'), /queued for the nightly run only/);
});

// ── the queue ───────────────────────────────────────────────────────────────

const STATE = {
  jobs: {
    'greenhouse:acme:1': {
      key: 'greenhouse:acme:1', company: 'Acme Bank', title: 'Solution Architect, Payments', location: 'Pune', url: 'https://x/1', status: 'open',
      score: { value: 82, scorer: 'ai', summary: 'Fits.', strengths: ['payments'], gaps: ['cloud'], musts: [{ requirement: 'Payments', quote: 'payments experience', match: 'yes' }] },
    },
  },
};
const SHOTS = [{ id: 'globex-head-of-architecture', company: 'Globex', title: 'Head of Architecture', location: 'Pune', url: 'https://g/1', why: 'Head role', requirements: ['12+ team'], gaps: ['GCP'], fit: 'high', fitText: 'High', closesOn: '2026-10-27' }];

test('a request carries what the tailoring tool needs, for a role or a moonshot', () => {
  const tailor = { version: 1, requests: {} };
  const pulled = new Map([
    ['greenhouse-acme-1', { on: true, note: 'stress payments', at: '2026-10-21T10:00:00.000Z' }],
    ['globex-head-of-architecture', { on: true, note: '', at: '2026-10-21T10:01:00.000Z' }],
    ['gone-role-9', { on: true, note: '', at: '2026-10-21T10:02:00.000Z' }],
  ]);
  const out = applyTailor(tailor, pulled, { state: STATE, moonshots: SHOTS });
  assert.equal(out.added, 2);
  assert.equal(out.unmatched, 1);
  assert.deepEqual(out.needText, ['greenhouse:acme:1']);
  const role = tailor.requests['greenhouse-acme-1'];
  assert.equal(role.kind, 'role');
  assert.equal(role.status, 'requested');
  assert.equal(role.note, 'stress payments');
  assert.equal(role.score.musts[0].quote, 'payments experience');
  const shot = tailor.requests['globex-head-of-architecture'];
  assert.equal(shot.kind, 'moonshot');
  assert.deepEqual(shot.moonshot, { why: 'Head role', requirements: ['12+ team'], gaps: ['GCP'], fit: 'High', closesOn: '2026-10-27' });
});

test('your tool marks a request done; asking again wants a fresh version; cancelling goes back', () => {
  const tailor = { version: 1, requests: {} };
  const at1 = '2026-10-21T10:00:00.000Z';
  applyTailor(tailor, new Map([['greenhouse-acme-1', { on: true, note: '', at: at1 }]]), { state: STATE });

  // Done: tailored.json says so, after the request.
  const done = { 'greenhouse-acme-1': { at: '2026-10-22T03:00:00.000Z', folder: 'Applications/Acme Bank/Solution Architect', note: null } };
  let out = applyTailor(tailor, new Map([['greenhouse-acme-1', { on: true, note: '', at: at1 }]]), { state: STATE, done });
  assert.equal(out.finished, 1);
  assert.equal(tailor.requests['greenhouse-acme-1'].status, 'done');
  assert.deepEqual(pageTailor(tailor)['greenhouse-acme-1'].d, done['greenhouse-acme-1']);

  // Asked again (a newer click): requested, the last version still recorded.
  const at2 = '2026-10-23T10:00:00.000Z';
  applyTailor(tailor, new Map([['greenhouse-acme-1', { on: true, note: 'shorter', at: at2 }]]), { state: STATE, done });
  assert.equal(tailor.requests['greenhouse-acme-1'].status, 'requested');
  assert.equal(tailor.requests['greenhouse-acme-1'].done.folder, 'Applications/Acme Bank/Solution Architect');

  // Cancelled: back to done, not deleted.
  out = applyTailor(tailor, new Map([['greenhouse-acme-1', { on: false, note: '', at: '2026-10-23T11:00:00.000Z' }]]), { state: STATE, done });
  assert.equal(out.cleared, 1);
  assert.equal(tailor.requests['greenhouse-acme-1'].status, 'done');

  // A request never done is simply removed when cancelled.
  const fresh = { version: 1, requests: {} };
  applyTailor(fresh, new Map([['greenhouse-acme-1', { on: true, note: '', at: at1 }]]), { state: STATE });
  applyTailor(fresh, new Map([['greenhouse-acme-1', { on: false, note: '', at: at2 }]]), { state: STATE });
  assert.deepEqual(fresh.requests, {});
});

test('tailor-request: one request for a tailoring job, with the posting read from its board when not saved', async () => {
  const board = { source: { type: 'greenhouse', list: async () => [{ id: '1', title: 'Solution Architect, Payments', description: 'The whole posting.' }] }, params: { scope: 'acme' } };
  const req = await tailorRequest({ id: 'greenhouse-acme-1', note: 'stress payments', at: '2026-10-21T10:00:00.000Z', state: STATE, companies: [{ boards: [board] }], moonshots: SHOTS, feedback: { roles: {} }, tailor: { requests: {} } });
  assert.equal(req.kind, 'role');
  assert.equal(req.description, 'The whole posting.');
  assert.equal(req.note, 'stress payments');
  assert.equal(req.score.musts.length, 1);
  const shot = await tailorRequest({ id: 'globex-head-of-architecture', state: STATE, companies: [], moonshots: SHOTS, feedback: { roles: {} }, tailor: { requests: {} } });
  assert.equal(shot.kind, 'moonshot');
  await assert.rejects(tailorRequest({ id: 'nope', state: STATE, companies: [], moonshots: SHOTS, feedback: { roles: {} }, tailor: { requests: {} } }), /No role or moonshot/);
});

// ── the run ─────────────────────────────────────────────────────────────────

const COMPANIES = [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }];
const gh = (id, title) => ({ id, title, location: { name: 'Pune' }, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, first_published: '2026-10-14T10:00:00Z', content: `&lt;p&gt;${title}: what the job is.&lt;/p&gt;` });
const JOBS = [gh(1, 'Solution Architect, Payments'), gh(2, 'Solution Architect, Data')];
const CF = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc' };

function cloudflare(tr) {
  return ['api.cloudflare.com', (url) =>
    url.includes('/keys')
      ? { success: true, result: url.includes('prefix=tr') ? Object.entries(tr).map(([id, m]) => ({ name: `tr:${id}`, metadata: m })) : [], result_info: { cursor: '' } }
      : { success: true, result: [{ id: 'kv1', title: 'axia-feedback' }] }];
}
async function day(dir, date, tr) {
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: JOBS })], cloudflare(tr)]);
  try {
    return await run(['--no-notify'], CF, { dir, now: new Date(`${date}T03:00:00Z`), log: quiet });
  } finally {
    stub.restore();
  }
}
const pageData = (dir) => {
  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  return html;
};

test('each run queues requests in data/tailor.json with the posting, and shows them on the page', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { titles: { include: ['Solution Architect'], exclude: [] }, tailor: true } });
  writeFileSync(join(dir, 'moonshots.json'), JSON.stringify({ roles: [{ id: 'globex-head', company: 'Globex', title: 'Head of Architecture', requirements: ['12+ team'] }] }));
  await day(dir, '2026-10-15', {});
  await day(dir, '2026-10-16', {
    'greenhouse-acme-1': { on: true, n: 'stress payments', t: '2026-10-15T20:00:00.000Z' },
    'globex-head': { on: true, n: '', t: '2026-10-15T20:01:00.000Z' },
  });
  let f = JSON.parse(readFileSync(join(dir, 'data/tailor.json'), 'utf8'));
  assert.deepEqual(Object.keys(f.requests), ['globex-head', 'greenhouse-acme-1']);
  assert.match(f.requests['greenhouse-acme-1'].description, /Solution Architect, Payments: what the job is/);
  assert.equal(f.requests['globex-head'].kind, 'moonshot');
  assert.match(pageData(dir), /"tailor":\{"api":true,"entries":\{[^}]*"greenhouse-acme-1":\{"on":true,"n":"stress payments"/);

  // Your tool writes tailored.json; the next run marks it done.
  writeFileSync(join(dir, 'tailored.json'), JSON.stringify({ 'greenhouse-acme-1': { at: '2026-10-16T08:00:00Z', folder: 'Applications/Acme Bank/Solution Architect' } }));
  const out = await day(dir, '2026-10-17', {
    'greenhouse-acme-1': { on: true, n: 'stress payments', t: '2026-10-15T20:00:00.000Z' },
    'globex-head': { on: true, n: '', t: '2026-10-15T20:01:00.000Z' },
  });
  f = JSON.parse(readFileSync(join(dir, 'data/tailor.json'), 'utf8'));
  assert.equal(f.requests['greenhouse-acme-1'].status, 'done');
  assert.equal(f.requests['globex-head'].status, 'requested');
  assert.equal(out.summary.tailor.waiting, 1);
});

test('off by default: no queue file and no buttons', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { titles: { include: ['Solution Architect'], exclude: [] } } });
  await day(dir, '2026-10-16', { 'greenhouse-acme-1': { on: true, n: '', t: '2026-10-15T20:00:00.000Z' } });
  assert.ok(!existsSync(join(dir, 'data/tailor.json')));
  assert.match(pageData(dir), /"tailor":null/);
});
