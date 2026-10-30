// Your to-do list: todo.yml by hand, ticked off (with a short note) on the Insights tab, kept in data/todo.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTodo, applyTicks, pageTodo, loadTodo, slugOf } from '../src/todo.mjs';
import { loadSettings, ConfigError } from '../src/config.mjs';
import { run } from '../src/run.mjs';
import worker from '../src/dashboard/worker.js';
import { tempProject, stubFetch } from './helpers.mjs';

const quiet = () => {};
const example = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'instance');

test('the file: tasks with a group, priority, details and link; junk dropped; ids unique', () => {
  const { items, dropped } = normalizeTodo({
    todo: [
      { task: '  Rewrite the CV   summary ', group: 'Resume', priority: 'NOW', details: 'Outcomes first.', link: 'https://example.test/cv' },
      'Book the AZ-305 exam',
      { task: 'Rewrite the CV summary', priority: 'soon', link: 'javascript:alert(1)' },
      { task: 'Write to two people', id: 'outreach', done: true },
      { group: 'Resume' },
    ],
  });
  assert.deepEqual(items[0], { id: 'rewrite-the-cv-summary', task: 'Rewrite the CV summary', group: 'Resume', priority: 'now', details: 'Outcomes first.', link: 'https://example.test/cv', done: false });
  assert.deepEqual([items[1].id, items[1].priority], ['book-the-az-305-exam', 'next']);
  assert.deepEqual([items[2].id, items[2].priority, items[2].link], ['rewrite-the-cv-summary-2', 'next', null], 'same task twice: its own id; an unknown priority is next; a non-web link is dropped');
  assert.deepEqual([items[3].id, items[3].done], ['outreach', true]);
  assert.deepEqual(dropped, ['item 5 has no task']);
  assert.deepEqual(normalizeTodo(null), { items: [], dropped: [] });
  assert.deepEqual(normalizeTodo({ todo: 'x' }).dropped, ['the file needs a list under todo:']);
  assert.equal(slugOf('Ünïcode — fine'), 'unicode-fine');
});

test('a bad file is a warning, never a stopped run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axia-todo-'));
  const logs = [];
  assert.equal(loadTodo(dir, { todo: { file: 'todo.yml' } }, { log: (m) => logs.push(m) }), null, 'no file, no list');
  writeFileSync(join(dir, 'todo.yml'), 'todo: [unclosed');
  assert.equal(loadTodo(dir, { todo: { file: 'todo.yml' } }, { log: (m) => logs.push(m) }), null);
  assert.match(logs.join('\n'), /could not be read/);
  assert.equal(loadTodo(dir, { todo: { file: '' } }), null, 'turned off');
});

test('ticks: the newest wins, and the dashboard tick wins over done: in the file', () => {
  const ticks = { version: 1, items: { a: { done: true, note: 'sent', at: '2026-10-20T10:00:00Z' } } };
  const pulled = new Map([
    ['a', { done: false, note: '', at: '2026-10-19T10:00:00Z' }], // older than the one kept: ignored
    ['b', { done: true, note: 'booked for 12 Nov', at: '2026-10-21T10:00:00Z' }],
  ]);
  assert.equal(applyTicks(ticks, pulled), 1);
  assert.equal(ticks.items.a.done, true);
  assert.equal(ticks.items.b.note, 'booked for 12 Nov');
  assert.equal(applyTicks(ticks, pulled), 0, 'nothing new the second time');
  assert.equal(applyTicks(ticks, null), 0, 'Cloudflare not reachable');

  const items = normalizeTodo({ todo: [{ task: 'A', id: 'a' }, { task: 'B', id: 'b' }, { task: 'C', id: 'c', done: true }] }).items;
  const page = pageTodo(items, { items: { ...ticks.items, c: { done: false, note: 'reopened', at: '2026-10-22T00:00:00Z' } } }, { api: true });
  assert.deepEqual(page.items.map((i) => [i.id, i.done, i.note]), [['a', true, 'sent'], ['b', true, 'booked for 12 Nov'], ['c', false, 'reopened']]);
  assert.equal(pageTodo(null, ticks, { api: true }), null);
});

test('settings: todo.file is todo.yml by default; false turns it off; anything else is refused', () => {
  const base = readFileSync(join(example, 'settings.yml'), 'utf8');
  const withYaml = (yaml) => {
    const dir = mkdtempSync(join(tmpdir(), 'axia-todo-'));
    writeFileSync(join(dir, 'settings.yml'), base + yaml);
    return dir;
  };
  assert.equal(loadSettings(example).todo.file, 'todo.yml');
  assert.equal(loadSettings(withYaml('\ntodo: false\n')).todo.file, '');
  assert.equal(loadSettings(withYaml('\ntodo:\n  file: plans/todo.yml\n')).todo.file, 'plans/todo.yml');
  assert.throws(() => loadSettings(withYaml('\ntodo:\n  file: 3\n')), (e) => e instanceof ConfigError && /todo.file/.test(e.message));
});

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
const signedIn = { 'cf-access-jwt-assertion': 'jwt' };
const post = (body) =>
  new Request('https://jobs.example.test/api/todo', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://jobs.example.test', ...signedIn }, body: JSON.stringify(body) });

test('the Worker saves a tick and its note apart from your calls on roles, and lists them back', async () => {
  const e = { FEEDBACK: fakeKV(), ASSETS: { fetch: async () => new Response('the page') } };
  assert.equal((await worker.fetch(post({ id: 'cv-summary', done: true, note: '  sent to   two friends ' }), e)).status, 200);
  assert.deepEqual([...e.FEEDBACK.data.keys()], ['td:cv-summary']);
  assert.equal(e.FEEDBACK.data.get('td:cv-summary').metadata.n, 'sent to two friends');
  assert.equal((await worker.fetch(post({ id: 'cv-summary', done: 'yes' }), e)).status, 400);
  assert.equal((await worker.fetch(post({ id: '../x', done: true }), e)).status, 400);
  await worker.fetch(post({ id: 'long', done: false, note: 'é'.repeat(600) }), e);
  assert.ok(new TextEncoder().encode(JSON.stringify(e.FEEDBACK.data.get('td:long').metadata)).length <= 1000);
  const list = await (await worker.fetch(new Request('https://jobs.example.test/api/todo', { headers: signedIn }), e)).json();
  assert.deepEqual(Object.keys(list.entries).sort(), ['cv-summary', 'long']);
  const calls = await (await worker.fetch(new Request('https://jobs.example.test/api/feedback', { headers: signedIn }), e)).json();
  assert.deepEqual(calls.entries, {}, 'ticks are not calls on roles');
});

// ── the run ────────────────────────────────────────────────────────────────

const COMPANIES = [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }];
const JOBS = [{ id: 1, title: 'Solution Architect, Payments', location: { name: 'Pune' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', first_published: '2026-10-14T10:00:00Z', content: 'x' }];
const CF = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc' };
async function day(dir, date, ticks) {
  const stub = stubFetch([
    ['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: JOBS })],
    ['api.cloudflare.com', (url) =>
      url.includes('/keys')
        ? { success: true, result: url.includes('prefix=td') ? Object.entries(ticks).map(([id, m]) => ({ name: `td:${id}`, metadata: m })) : [], result_info: { cursor: '' } }
        : { success: true, result: [{ id: 'kv1', title: 'axia-feedback' }] }],
  ]);
  try {
    return await run(['--no-notify'], CF, { dir, now: new Date(`${date}T03:00:00Z`), log: quiet });
  } finally {
    stub.restore();
  }
}

test('each run copies the ticks into data/todo.json and shows the list on the Insights tab', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { titles: { include: ['Solution Architect'], exclude: [] }, dashboard: { domain: 'jobs.example.test' } } });
  await day(dir, '2026-10-15', {});
  assert.ok(!existsSync(join(dir, 'data/todo.json')), 'no todo.yml: nothing written');
  assert.doesNotMatch(readFileSync(join(dir, '.axia/site/index.html'), 'utf8'), /"todo":\{/);

  writeFileSync(join(dir, 'todo.yml'), 'todo:\n  - task: Rewrite the CV summary\n    id: cv-summary\n    priority: now\n  - task: Book the AZ-305 exam\n');
  await day(dir, '2026-10-16', { 'cv-summary': { d: true, n: 'sent to two friends', t: '2026-10-15T20:00:00Z' }, gone: { d: true, n: '', t: '2026-10-15T20:00:00Z' } });
  const saved = JSON.parse(readFileSync(join(dir, 'data/todo.json'), 'utf8'));
  assert.deepEqual(saved.items['cv-summary'], { done: true, note: 'sent to two friends', at: '2026-10-15T20:00:00Z' });
  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  assert.match(html, /id="ins-todo"/);
  assert.match(html, /"todo":\{"api":true,"items":\[\{"id":"cv-summary"[^\]]*"done":true,"note":"sent to two friends"/);

  // Cloudflare down: the ticks already saved stay.
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: JOBS })], ['api.cloudflare.com', () => new Response('down', { status: 500 })]]);
  try {
    assert.equal((await run(['--no-notify'], CF, { dir, now: new Date('2026-10-17T03:00:00Z'), log: quiet })).exitCode, 0);
  } finally {
    stub.restore();
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'data/todo.json'), 'utf8')).items['cv-summary'].done, true);
});
