// Your to-do list: the things you mean to do for your search (resume edits, a certification, people to
// write to), kept in a short file by hand (settings.yml → todo.file, todo.yml by default) and ticked off
// on the dashboard's Insights tab, each with an optional short note.
//
// The file looks like:
//   todo:
//     - task: Rewrite the CV summary around payments and governance
//       group: Resume                  # optional: groups the list
//       priority: now                  # now, next or later (next when left out)
//       details: Lead with outcomes…   # optional, longer, shown when the item is opened
//       link: https://…                # optional
//       id: cv-summary                 # optional: keeps the tick if you reword the task
//       done: true                     # optional: already done before Axia had the list
//
// A tick and its note save to the same Cloudflare store as your calls on roles (key td:<id>), so they show
// on every device at once. Each run copies them into data/todo.json in your private repository, so they
// last. Items can also be added (and removed) on the dashboard, like a quick note; those live only in
// data/todo.json, with their words and priority. Nothing here is scored, sent or read by the model.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { truncate } from './text.mjs';
import { feedbackEnabled, findNamespace } from './feedback.mjs';

export const PRIORITIES = ['now', 'next', 'later'];
export const MAX_NOTE = 240;
const MAX_TASK = 200;
const MAX_DETAILS = 1500;
const MAX_ITEMS = 300;
const CF_API = 'https://api.cloudflare.com/client/v4';

const clean = (v, max) => (v == null || typeof v === 'object' ? '' : truncate(String(v).replace(/\s+/g, ' ').trim(), max));
const link = (v) => {
  try {
    const u = new URL(String(v ?? '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};
/** "Rewrite the CV summary" → "rewrite-the-cv-summary": the id a tick is saved under when the item has none. */
export const slugOf = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';

/** The file's content → { items, dropped }. Anything unusable is dropped with a reason; ids are made unique. */
export function normalizeTodo(raw) {
  const list = Array.isArray(raw) ? raw : raw?.todo;
  if (list == null) return { items: [], dropped: [] };
  if (!Array.isArray(list)) return { items: [], dropped: ['the file needs a list under todo:'] };
  const items = [];
  const dropped = [];
  const seen = new Set();
  for (const [i, x] of list.entries()) {
    if (items.length >= MAX_ITEMS) {
      dropped.push(`only the first ${MAX_ITEMS} items are kept`);
      break;
    }
    const task = clean(typeof x === 'string' ? x : x?.task, MAX_TASK);
    if (!task) {
      dropped.push(`item ${i + 1} has no task`);
      continue;
    }
    const o = typeof x === 'object' && x ? x : {};
    const priority = PRIORITIES.includes(String(o.priority ?? '').toLowerCase().trim()) ? String(o.priority).toLowerCase().trim() : 'next';
    let id = slugOf(o.id ?? task);
    for (let n = 2; seen.has(id); n++) id = `${slugOf(o.id ?? task)}-${n}`;
    seen.add(id);
    items.push({ id, task, group: clean(o.group, 40) || null, priority, details: clean(o.details, MAX_DETAILS) || null, link: link(o.link), done: o.done === true });
  }
  return { items, dropped };
}

/** Reads todo.yml: its items, [] when there is no file, null when turned off. A bad file never stops the run. */
export function loadTodo(dir, settings, { log = console.log } = {}) {
  const file = settings.todo?.file;
  if (!file) return null;
  const path = resolve(dir, file);
  if (!existsSync(path)) return []; // no file yet: items added on the dashboard can still show
  try {
    const { items, dropped } = normalizeTodo(parse(readFileSync(path, 'utf8')));
    for (const d of dropped) log(`::warning::To-do: ${file}: ${d}.`);
    return items;
  } catch (err) {
    log(`::warning::To-do: ${file} could not be read: ${err.message}. The list is left off the dashboard this run.`);
    return null;
  }
}

// data/todo.json: { version, items: { <id>: { done, note, at, task?, priority?, removed? } } }, the ticks and notes you
// made on the dashboard; task and priority mark an item added there, removed one taken off again.
export const todoPath = (dir) => resolve(dir, 'data/todo.json');

export function loadTicks(dir) {
  const path = todoPath(dir);
  if (!existsSync(path)) return { version: 1, items: {} };
  const f = JSON.parse(readFileSync(path, 'utf8'));
  return { version: 1, items: f.items ?? {} };
}

export function saveTicks(dir, ticks) {
  const path = todoPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const items = Object.fromEntries(Object.keys(ticks.items).sort().map((k) => [k, ticks.items[k]]));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 1) + '\n');
  renameSync(tmp, path);
}

async function cf(path, env, fetchImpl = fetch) {
  const res = await fetchImpl(`${CF_API}${path}`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(`Cloudflare GET: ${data.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  return data;
}

/**
 * Every tick saved on the dashboard: Map<id, { done, note, at }>.
 * Null when the dashboard can't save (public, or feedback off) or Cloudflare can't be asked; the run carries on.
 */
export async function pullTicks({ env, settings, log = console.log, fetchImpl }) {
  if (!feedbackEnabled(settings) || !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return null;
  try {
    const ns = await findNamespace({ env, settings, fetchImpl });
    if (!ns) return new Map();
    const out = new Map();
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const data = await cf(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ns}/keys?limit=1000&prefix=td%3A${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, env, fetchImpl);
      for (const k of data.result ?? []) {
        const m = k.metadata ?? {};
        if (typeof m.d !== 'boolean') continue;
        const t = { done: m.d, note: clean(m.n, MAX_NOTE), at: m.t ?? null };
        const task = clean(m.a, 200);
        if (task) Object.assign(t, { task, priority: PRIORITIES.includes(m.p) ? m.p : 'now', ...(m.x === true ? { removed: true } : {}) });
        out.set(k.name.slice(3), t);
      }
      cursor = data.result_info?.cursor;
      if (!cursor) break;
    }
    return out;
  } catch (err) {
    log(`Could not read your to-do ticks: ${err.message}`);
    return null;
  }
}

const entryOf = (t) => ({ done: t.done, note: t.note, at: t.at, ...(t.task ? { task: t.task, priority: t.priority, ...(t.removed ? { removed: true } : {}) } : {}) });

/** The dashboard's ticks into data/todo.json: the newest wins. Returns how many changed. */
export function applyTicks(ticks, pulled) {
  let changed = 0;
  for (const [id, t] of pulled ?? []) {
    const prev = ticks.items[id];
    if (prev && JSON.stringify(prev) === JSON.stringify(entryOf(t))) continue;
    if (prev?.at && t.at && t.at < prev.at) continue;
    ticks.items[id] = entryOf(t);
    changed++;
  }
  return changed;
}

/**
 * For the page: each item with its tick and note (a tick on the dashboard wins over done: in the file), then
 * the items added on the dashboard, newest first. Null when there is nothing to show and nowhere to add.
 */
export function pageTodo(items, ticks, { api }) {
  if (!items) return null;
  const inFile = new Set(items.map((it) => it.id));
  const added = Object.entries(ticks?.items ?? {})
    .filter(([id, t]) => t.task && !t.removed && !inFile.has(id))
    .map(([id, t]) => ({ id, task: t.task, group: null, priority: t.priority, details: null, link: null, done: t.done, note: t.note ?? '', at: t.at ?? null, added: true }))
    .sort((a, b) => b.id.localeCompare(a.id)); // ids start with the time they were added
  const list = [
    ...added,
    ...items.map((it) => {
      const t = ticks?.items?.[it.id];
      return { ...it, done: t ? t.done : it.done, note: t?.note ?? '', at: t?.at ?? null };
    }),
  ];
  if (!list.length && !api) return null;
  return { api, items: list };
}
