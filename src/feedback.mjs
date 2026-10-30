// Your calls on roles, from the dashboard's buttons: Applied, Shortlist, Not for me (with an optional reason),
// and for an Applied role what came of it: Rejected or Turned down, with a reason from your list, the stage and a note.
//
// The dashboard saves each click in a Cloudflare KV namespace next to the dashboard Worker (src/dashboard/worker.js).
// Every run copies them into data/feedback.json in your private repository, with the posting text, so they last
// after the role closes. They become judged roles for `axia calibrate` and the weekly `axia review`.
//
// data/feedback.json:
//   { version, lastReview, roles: { <role key>: { id, company, title, location, url, verdict, reason, at,
//                                                  outcome: { kind, reason, stage, note, at } (Applied roles, when you hear back),
//                                                  score: { value, scorer, model, resumeHash } | null, description } } }

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { jobId, truncate } from './text.mjs';

export const VERDICTS = ['applied', 'shortlist', 'not-for-me'];
export const LABEL = { applied: 'Applied', shortlist: 'Shortlist', 'not-for-me': 'Not for me' };
/** Applied and Shortlist mean "worth applying"; Not for me means "skip". */
export const decisionOf = (verdict) => (verdict === 'not-for-me' ? 'Skip' : 'Apply');
export const MAX_REASON = 240;
export const OUTCOMES = ['rejected', 'turned-down'];
export const OUTCOME_LABEL = { rejected: 'Rejected', 'turned-down': 'Turned down' };
const MAX_TEXT = 15000;
const CF_API = 'https://api.cloudflare.com/client/v4';

export const feedbackPath = (dir) => resolve(dir, 'data/feedback.json');

export function loadFeedback(dir) {
  const path = feedbackPath(dir);
  const empty = { version: 1, lastReview: null, roles: {} };
  if (!existsSync(path)) return empty;
  const f = JSON.parse(readFileSync(path, 'utf8'));
  return { ...empty, ...f, roles: f.roles ?? {} };
}

export function saveFeedback(dir, feedback) {
  const path = feedbackPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const roles = Object.fromEntries(Object.keys(feedback.roles).sort().map((k) => [k, feedback.roles[k]]));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...feedback, roles }, null, 1) + '\n');
  renameSync(tmp, path);
}

/** The KV namespace that holds the dashboard's clicks: one per dashboard Worker. */
export const namespaceTitle = (settings) => `${settings.dashboard?.worker || 'axia'}-feedback`;

/** Feedback needs a private dashboard on Cloudflare; a public demo never takes writes. */
export const feedbackEnabled = (settings) => settings.dashboard?.feedback !== false && settings.dashboard?.public !== true;

async function cf(path, env, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${CF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(`Cloudflare ${method} ${path.replace(/accounts\/[^/]+/, 'accounts/…')}: ${data.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  return data;
}

/** The namespace id, or null when it doesn't exist yet (and `create` is false). */
export async function findNamespace({ env, settings, create = false, fetchImpl }) {
  const title = namespaceTitle(settings);
  const base = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces`;
  for (let page = 1; page <= 20; page++) {
    const data = await cf(`${base}?per_page=100&page=${page}`, env, { fetchImpl });
    const hit = (data.result ?? []).find((n) => n.title === title);
    if (hit) return hit.id;
    if ((data.result ?? []).length < 100) break;
  }
  if (!create) return null;
  return (await cf(base, env, { method: 'POST', body: { title }, fetchImpl })).result.id;
}

/**
 * Every click saved on the dashboard: Map<role id, { verdict, reason, at }>. A cleared call has verdict null.
 * Returns null when feedback is off or Cloudflare can't be asked; the run carries on without it.
 */
export async function pullFeedback({ env, settings, log = console.log, fetchImpl }) {
  if (!feedbackEnabled(settings) || !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return null;
  try {
    const ns = await findNamespace({ env, settings, fetchImpl });
    if (!ns) return new Map();
    const out = new Map();
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const data = await cf(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ns}/keys?limit=1000&prefix=fb%3A${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, env, { fetchImpl });
      for (const k of data.result ?? []) {
        const m = k.metadata ?? {};
        if (m.v !== null && !VERDICTS.includes(m.v)) continue;
        out.set(k.name.slice(3), { verdict: m.v, reason: truncate(String(m.r ?? ''), MAX_REASON), at: m.t ?? null, outcome: m.v === 'applied' ? outcomeOf(m.o) : null });
      }
      cursor = data.result_info?.cursor;
      if (!cursor) break;
    }
    return out;
  } catch (err) {
    log(`Could not read your dashboard feedback: ${err.message}`);
    return null;
  }
}

/** A saved outcome ({ k, r, s, n, t } in the store) as kept in data/feedback.json, or null. */
export function outcomeOf(o) {
  if (!o || !OUTCOMES.includes(o.k)) return null;
  const text = (x, max) => truncate(String(x ?? ''), max);
  return { kind: o.k, reason: text(o.r, 80), stage: text(o.s, 80), note: text(o.n, MAX_REASON), at: o.t ?? null };
}

const sameOutcome = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Bring the clicks into data/feedback.json. A role is matched by its dashboard id; one that has left memory
 * since the click (closed long ago) can't be matched and is skipped. Returns the role keys that still need
 * their posting text saved, and counts for the log.
 */
export function applyFeedback(feedback, pulled, state) {
  const byId = new Map(Object.values(state.jobs).map((j) => [jobId(j.key), j]));
  for (const [key, r] of Object.entries(feedback.roles)) if (!byId.has(r.id)) byId.set(r.id, { key, ...r });
  let added = 0;
  let changed = 0;
  let cleared = 0;
  let unmatched = 0;
  for (const [id, f] of pulled ?? []) {
    const job = byId.get(id);
    if (!job) {
      unmatched++;
      continue;
    }
    const prev = feedback.roles[job.key];
    if (!f.verdict) {
      if (prev) {
        delete feedback.roles[job.key];
        cleared++;
      }
      continue;
    }
    const outcome = f.verdict === 'applied' ? f.outcome ?? null : null;
    if (prev && prev.verdict === f.verdict && prev.reason === f.reason && sameOutcome(prev.outcome, outcome)) continue;
    const { outcome: _, ...kept } = prev ?? {};
    feedback.roles[job.key] = {
      ...kept,
      id,
      company: job.company,
      title: job.title,
      location: job.location ?? null,
      url: job.url ?? null,
      verdict: f.verdict,
      reason: f.reason || '',
      at: f.at,
      ...(outcome ? { outcome } : {}),
    };
    prev ? changed++ : added++;
  }
  const needText = Object.keys(feedback.roles).filter((k) => !feedback.roles[k].description && state.jobs[k]);
  return { added, changed, cleared, unmatched, needText };
}

/** Save posting text for judged roles (from today's listing) and the latest score of each. */
export function snapshotFeedback(feedback, state, describe) {
  for (const [key, r] of Object.entries(feedback.roles)) {
    const job = state.jobs[key];
    if (!r.description) {
      const text = describe(key);
      if (text) r.description = truncate(text, MAX_TEXT);
    }
    if (job?.score) r.score = { value: job.score.value, scorer: job.score.scorer, model: job.score.model ?? null, resumeHash: job.score.resumeHash ?? null };
  }
}

/** For the dashboard: { role id: { v, r, t } } for the roles it shows. */
export function pageFeedback(feedback) {
  const out = {};
  for (const r of Object.values(feedback?.roles ?? {})) {
    const o = r.outcome;
    out[r.id] = { v: r.verdict, r: r.reason || '', t: r.at, ...(o ? { o: { k: o.kind, r: o.reason || '', s: o.stage || '', n: o.note || '', t: o.at } } : {}) };
  }
  return out;
}
