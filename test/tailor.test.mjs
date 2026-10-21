// Tailor requests: the dashboard's "Tailor for this role" button, queued for your own tailoring tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../src/dashboard/worker.js';
import { run } from '../src/run.mjs';
import { loadSettings, ConfigError } from '../src/config.mjs';
import { applyTailor, pageTailor } from '../src/tailor.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const quiet = () => {};

// ── settings ────────────────────────────────────────────────────────────────

test('tailor is off by default, and true or { enabled } turns it on', () => {
  const off = tempProject({ companies: [] });
  assert.deepEqual(loadSettings(off).tailor, { enabled: false, done: 'tailored.json' });
  const on = tempProject({ companies: [], settings: { tailor: true } });
  assert.deepEqual(loadSettings(on).tailor, { enabled: true, done: 'tailored.json' });
  const custom = tempProject({ companies: [], settings: { tailor: { enabled: true, done: 'out/done.json' } } });
  assert.equal(loadSettings(custom).tailor.done, 'out/done.json');
  const bad = tempProject({ companies: [], settings: { tailor: { enabled: 'yes' } } });
  assert.throws(() => loadSettings(bad), ConfigError);
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
