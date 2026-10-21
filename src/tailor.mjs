// Tailor requests: the dashboard's "Tailor for this role" button, on a role or a moonshot.
//
// Axia doesn't write resumes. The button only queues the role for whatever does the tailoring
// (your own tool, a script, a scheduled Claude task): each run copies the requests into
// data/tailor.json with what that tool needs, the posting text and the score's quoted must-haves
// for a role, or the requirements and gaps for a moonshot. Tailored versions never feed back
// into scoring: scores stay against your one resume.
//
// The tool says it's done by writing tailored.json next to settings.yml (settings.yml → tailor.done).
// Axia only reads that file, so the two never edit the same one:
//   { "<role id>": { "at": "2026-10-22T03:10:00Z", "folder": "Applications/Acme/Solution Architect", "note": "…" } }
//
// data/tailor.json:
//   { version, requests: { <role id>: { id, kind: 'role' | 'moonshot', key, company, title, location, url,
//       note, at, status: 'requested' | 'done', done: { at, folder, note } | null,
//       score: { value, summary, strengths, gaps, musts } | null, moonshot: { why, requirements, gaps, fit, closesOn } | null,
//       description } } }

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { jobId, truncate } from './text.mjs';
import { feedbackEnabled, findNamespace } from './feedback.mjs';

export const MAX_NOTE = 240;
const MAX_TEXT = 15000;
const CF_API = 'https://api.cloudflare.com/client/v4';

/** Tailor buttons need the feedback store (a private dashboard on Cloudflare) and are off unless turned on. */
export const tailorEnabled = (settings) => settings.tailor?.enabled === true;
export const tailorApi = (settings) => tailorEnabled(settings) && feedbackEnabled(settings);

export const tailorPath = (dir) => resolve(dir, 'data/tailor.json');

export function loadTailor(dir) {
  const path = tailorPath(dir);
  const empty = { version: 1, requests: {} };
  if (!existsSync(path)) return empty;
  const f = JSON.parse(readFileSync(path, 'utf8'));
  return { ...empty, ...f, requests: f.requests ?? {} };
}

export function saveTailor(dir, tailor) {
  const path = tailorPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const requests = Object.fromEntries(Object.keys(tailor.requests).sort().map((k) => [k, tailor.requests[k]]));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...tailor, requests }, null, 1) + '\n');
  renameSync(tmp, path);
}

/** What the tailoring tool has finished: { <role id>: { at, folder, note } }. A bad or missing file reads as nothing done. */
export function loadDone(dir, settings, { log = console.log } = {}) {
  const file = settings.tailor?.done;
  if (!file) return {};
  const path = resolve(dir, file);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected a JSON object keyed by role id');
    const out = {};
    for (const [id, d] of Object.entries(raw)) {
      const at = d && typeof d.at === 'string' && !Number.isNaN(Date.parse(d.at)) ? new Date(d.at).toISOString() : null;
      if (!at) continue;
      out[id] = { at, folder: d.folder ? truncate(String(d.folder), 300) : null, note: d.note ? truncate(String(d.note), MAX_NOTE) : null };
    }
    return out;
  } catch (err) {
    log(`::warning::Tailor: ${file} could not be read: ${err.message}. Requests show as waiting.`);
    return {};
  }
}

async function cf(path, env, fetchImpl = fetch) {
  const res = await fetchImpl(`${CF_API}${path}`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(`Cloudflare GET: ${data.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  return data;
}

/**
 * Every Tailor click saved on the dashboard: Map<role id, { on, note, at }>.
 * Returns null when the buttons are off or Cloudflare can't be asked; the run carries on without them.
 */
export async function pullTailor({ env, settings, log = console.log, fetchImpl }) {
  if (!tailorApi(settings) || !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return null;
  try {
    const ns = await findNamespace({ env, settings, fetchImpl });
    if (!ns) return new Map();
    const out = new Map();
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const data = await cf(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ns}/keys?limit=1000&prefix=tr%3A${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, env, fetchImpl);
      for (const k of data.result ?? []) {
        const m = k.metadata ?? {};
        if (typeof m.on !== 'boolean') continue;
        out.set(k.name.slice(3), { on: m.on, note: truncate(String(m.n ?? ''), MAX_NOTE), at: m.t ?? null });
      }
      cursor = data.result_info?.cursor;
      if (!cursor) break;
    }
    return out;
  } catch (err) {
    log(`Could not read your Tailor requests: ${err.message}`);
    return null;
  }
}

const roleFacts = (job) => ({
  kind: 'role',
  key: job.key,
  company: job.company,
  title: job.title,
  location: job.location ?? null,
  url: job.url ?? null,
  score: job.score?.scorer === 'ai'
    ? { value: job.score.value, summary: job.score.summary ?? null, strengths: job.score.strengths ?? [], gaps: job.score.gaps ?? [], musts: job.score.musts ?? [] }
    : job.score ? { value: job.score.value, summary: null, strengths: [], gaps: [], musts: [] } : null,
  moonshot: null,
});
const moonshotFacts = (r) => ({
  kind: 'moonshot',
  key: null,
  company: r.company,
  title: r.title,
  location: r.location ?? null,
  url: r.url ?? null,
  score: null,
  moonshot: { why: r.why ?? null, requirements: r.requirements ?? [], gaps: r.gaps ?? [], fit: r.fitText ?? r.fit ?? null, closesOn: r.closesOn ?? null },
});

/**
 * Bring the clicks into data/tailor.json, and mark requests done from the tool's tailored.json.
 * A request is matched by its dashboard id, to a role in memory or a moonshot; one that matches
 * neither is skipped. Clicking again after a request is done asks for a fresh version.
 * Returns the role keys whose posting text is still missing, and counts for the log.
 */
export function applyTailor(tailor, pulled, { state, moonshots = [], done = {} }) {
  const jobs = new Map(Object.values(state.jobs).map((j) => [jobId(j.key), j]));
  const shots = new Map(moonshots.map((r) => [r.id, r]));
  let added = 0;
  let cleared = 0;
  let unmatched = 0;
  for (const [id, t] of pulled ?? []) {
    const prev = tailor.requests[id];
    if (!t.on) {
      if (prev?.status === 'requested') {
        // Cancelled: back to the last tailored version if there is one, else gone.
        if (prev.done) prev.at = prev.done.at;
        else delete tailor.requests[id];
        cleared++;
      }
      continue;
    }
    if (prev && prev.at === t.at) {
      if (prev.note !== t.note) prev.note = t.note;
      continue;
    }
    const job = jobs.get(id);
    const shot = shots.get(id);
    if (!job && !shot && !prev) {
      unmatched++;
      continue;
    }
    const facts = job ? roleFacts(job) : shot ? moonshotFacts(shot) : {};
    tailor.requests[id] = { ...(prev ?? {}), id, ...facts, note: t.note || '', at: t.at, status: 'requested', done: prev?.done ?? null };
    if (!prev || prev.at !== t.at) added++;
  }
  let finished = 0;
  for (const r of Object.values(tailor.requests)) {
    const d = done[r.id];
    const isDone = Boolean(d && r.at && d.at >= r.at);
    if (d) r.done = d;
    if (isDone && r.status !== 'done') finished++;
    r.status = isDone ? 'done' : 'requested';
  }
  const needText = Object.values(tailor.requests).filter((r) => r.kind === 'role' && !r.description && r.key && state.jobs[r.key]).map((r) => r.key);
  return { added, cleared, unmatched, finished, needText };
}

/** Save the posting text for role requests (from today's listing, else from your saved calls). */
export function snapshotTailor(tailor, describe) {
  for (const r of Object.values(tailor.requests)) {
    if (r.kind !== 'role' || r.description || !r.key) continue;
    const text = describe(r.key);
    if (text) r.description = truncate(text, MAX_TEXT);
  }
}

/** For the dashboard: { role id: { on, n, t, s, d: { at, folder, note } | null } }. */
export function pageTailor(tailor) {
  const out = {};
  for (const r of Object.values(tailor?.requests ?? {})) out[r.id] = { on: true, n: r.note || '', t: r.at, s: r.status, d: r.done ?? null };
  return out;
}
