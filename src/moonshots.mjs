// Moonshots: a short list of stretch roles you track outside Axia's own pipeline (another tool, a
// scheduled research task, or by hand), shown on its own dashboard tab. They are not read from your
// companies' boards and not scored against your resume; Axia only checks the file and displays it.
//
// The file (settings.yml → moonshots.file, default moonshots.json next to settings.yml) looks like:
//   {
//     "updatedAt": "2026-10-18T15:25:00Z",
//     "summary": "One or two sentences on today's search.",
//     "picks": [{ "label": "Best overall", "role": "<role id>", "note": "why, in a line" }],
//     "roles": [{ "id": "…", "company": "…", "title": "…", "location": "…", "category": "Big Tech",
//                 "status": "new|active|closing|closed", "fit": "high|medium|stretch",
//                 "why": "…", "requirements": ["…"], "gaps": ["…"], "url": "https://…",
//                 "firstSeen": "2026-10-14", "lastVerified": "2026-10-18", "closesOn": "2026-10-27", "note": "…" }],
//     "notes": ["what the search could not check today"]
//   }
// Anything unusable is dropped with a reason; a bad file never stops the daily run.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const STATUSES = ['new', 'closing', 'active', 'closed'];
export const FITS = ['high', 'medium', 'stretch'];
const MAX_ROLES = 80;
const MAX_LIST = 10;
const MAX_TEXT = 800;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (v, max = MAX_TEXT) => {
  if (v == null || typeof v === 'object') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
};
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => text(x, 300)).filter(Boolean).slice(0, MAX_LIST);
const date = (v) => (typeof v === 'string' && DATE.test(v.trim()) ? v.trim() : null);
const link = (v) => {
  try {
    const u = new URL(String(v ?? '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

/** "🔥 ACTIVE", "Closing soon", "NEW" → one of STATUSES (unknown reads as active). */
export function statusOf(v) {
  const s = String(v ?? '').toLowerCase();
  if (/clos(ed|ure)|filled|gone|not found/.test(s)) return /soon/.test(s) ? 'closing' : 'closed';
  if (/closing|soon/.test(s)) return 'closing';
  if (/new/.test(s)) return 'new';
  return 'active';
}

/** "High", "High/Medium", "Stretch (low-Medium)" → the first of FITS it names, or null. */
export function fitOf(v) {
  const s = String(v ?? '').toLowerCase();
  const hits = FITS.map((f) => [f, s.indexOf(f)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  return hits.length ? hits[0][0] : null;
}

/** The file's content → what the dashboard shows, plus what was dropped and why. */
export function normalizeMoonshots(raw, { fallbackUpdatedAt = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected a JSON object with a "roles" list');
  if (!Array.isArray(raw.roles)) throw new Error('"roles" must be a list');
  const dropped = [];
  const roles = [];
  const ids = new Set();
  for (const [i, r] of raw.roles.entries()) {
    if (roles.length >= MAX_ROLES) {
      dropped.push(`${raw.roles.length - MAX_ROLES} roles past the first ${MAX_ROLES}`);
      break;
    }
    const company = text(r?.company, 120), title = text(r?.title, 200);
    if (!company || !title) {
      dropped.push(`role ${i + 1}: needs a company and a title`);
      continue;
    }
    const location = text(r.location, 160);
    let id = slug(text(r.id, 100)) || slug(`${company} ${title} ${location}`);
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    roles.push({
      id,
      company,
      title,
      location: location || null,
      category: text(r.category, 40) || null,
      status: statusOf(r.status),
      fit: fitOf(r.fit),
      fitText: text(r.fit, 60) || null,
      why: text(r.why) || null,
      requirements: list(r.requirements),
      gaps: list(r.gaps),
      url: link(r.url),
      firstSeen: date(r.firstSeen),
      lastVerified: date(r.lastVerified),
      closesOn: date(r.closesOn),
      note: text(r.note, 400) || null,
    });
  }
  const byId = new Set(roles.map((r) => r.id));
  const picks = (Array.isArray(raw.picks) ? raw.picks : [])
    .map((p) => {
      const role = slug(text(p?.role, 100));
      return { label: text(p?.label, 60), role: byId.has(role) ? role : null, note: text(p?.note, 400) || null };
    })
    .filter((p) => p.label && (p.role || p.note))
    .slice(0, 8);
  const at = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? new Date(raw.updatedAt).toISOString() : fallbackUpdatedAt;
  return {
    updatedAt: at,
    summary: text(raw.summary, 1200) || null,
    picks,
    roles,
    notes: list(raw.notes),
    dropped,
  };
}

/**
 * Reads the moonshots file. Returns null when the feature is off or the file isn't there (no tab),
 * { report } when it reads, or { problem } when it can't be used (the tab says why).
 */
export function loadMoonshots(dir, settings, { log = console.log } = {}) {
  const file = settings.moonshots?.file;
  if (!file) return null;
  const path = resolve(dir, file);
  if (!existsSync(path)) return null;
  try {
    const report = normalizeMoonshots(JSON.parse(readFileSync(path, 'utf8')), { fallbackUpdatedAt: statSync(path).mtime.toISOString() });
    log(`Moonshots: ${report.roles.length} role${report.roles.length === 1 ? '' : 's'} from ${file}` + (report.dropped.length ? ` (left out: ${report.dropped.join('; ')})` : ''));
    return { file, report };
  } catch (err) {
    const problem = `${file} could not be read: ${err.message}`;
    log(`::warning::Moonshots: ${problem}. The rest of the run is not affected.`);
    return { file, problem };
  }
}
