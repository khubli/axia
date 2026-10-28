// Recent layoffs: a heads-up label on companies that have announced job cuts, from a short file you
// keep by hand (settings.yml → layoffs.file, layoffs.yml by default). Axia never searches the news
// itself, so the label costs no AI calls. It never changes a score and never hides a role.
//
// The file looks like:
//   layoffs:
//     - company: Example Bank          # as named in companies.yml
//       announced: 2026-10-22          # or just the month, 2026-10
//       where: global                  # india, global, or a place such as UK or US
//       size: about 5,000 jobs (5%)    # optional, in your words
//       note: mostly UK retail         # optional
//       link: https://news.example/…   # the report you read
//
// A label shows for `layoffs.months` (6 by default) calendar months after the month it was
// announced, then drops off by itself. Anything unusable is skipped with a reason in the run log;
// a bad file never stops the run.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const MONTH = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const MAX_TEXT = 300;

const text = (v, max = MAX_TEXT) => {
  if (v == null || typeof v === 'object') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
};
const link = (v) => {
  try {
    const u = new URL(String(v ?? '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};
// YAML reads an unquoted 2026-10-22 as a Date; keep it as the text you wrote.
const dateText = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : text(v, 20));
const monthIndex = (y, m) => y * 12 + (m - 1);

/** "2026-10-22" or "2026-10" → { date, month index }, or null when it isn't a real date. */
export function announcedOf(v) {
  const hit = MONTH.exec(dateText(v));
  if (!hit) return null;
  const [, y, m, d] = hit.map(Number);
  if (m < 1 || m > 12 || (d && (d < 1 || d > 31))) return null;
  return { date: dateText(v), month: monthIndex(y, m) };
}

/** india for cuts in India; elsewhere for global or other places (the page words it as you wrote it). */
export const scopeOf = (where) => (/india/i.test(String(where ?? '')) ? 'india' : 'elsewhere');

/**
 * The file's content → { byCompany, dropped, expired }. `companies` are your company names
 * (companies.yml), `today` is YYYY-MM-DD in your time zone, `months` how long a label lasts.
 */
export function normalizeLayoffs(raw, { companies = [], today, months = 6 }) {
  const list = Array.isArray(raw) ? raw : raw?.layoffs;
  if (list == null) return { byCompany: {}, dropped: [], expired: 0 };
  if (!Array.isArray(list)) throw new Error('"layoffs" must be a list');
  const names = new Map(companies.map((n) => [String(n).toLowerCase(), String(n)]));
  const [ty, tm] = String(today).split('-').map(Number);
  const now = monthIndex(ty, tm);
  const byCompany = {};
  const dropped = [];
  let expired = 0;
  for (const [i, e] of list.entries()) {
    const label = `entry ${i + 1}${e?.company ? ` (${text(e.company, 60)})` : ''}`;
    const company = names.get(text(e?.company, 120).toLowerCase());
    if (!company) {
      dropped.push(e?.company ? `${label}: not one of your companies in companies.yml` : `${label}: needs a company`);
      continue;
    }
    const when = announcedOf(e.announced);
    if (!when) {
      dropped.push(`${label}: announced must be a date such as 2026-10-22 or a month such as 2026-10`);
      continue;
    }
    if (when.month > now) {
      dropped.push(`${label}: announced ${when.date} is in the future`);
      continue;
    }
    if (now - when.month >= months) {
      expired++;
      continue;
    }
    const where = text(e.where, 60) || 'global';
    (byCompany[company] ??= []).push({
      announced: when.date,
      where,
      india: scopeOf(where) === 'india',
      size: text(e.size, 120) || null,
      note: text(e.note) || null,
      link: link(e.link),
    });
  }
  // Newest first, so the label names the latest news.
  for (const rows of Object.values(byCompany)) rows.sort((a, b) => b.announced.localeCompare(a.announced));
  return { byCompany, dropped, expired };
}

/**
 * Reads the layoffs file. Returns null when the feature is off or the file isn't there (no labels).
 */
export function loadLayoffs(dir, settings, { companies = [], today, log = console.log } = {}) {
  const file = settings.layoffs?.file;
  if (!file) return null;
  const path = resolve(dir, file);
  if (!existsSync(path)) return null;
  try {
    const r = normalizeLayoffs(parse(readFileSync(path, 'utf8')) ?? {}, { companies, today, months: settings.layoffs.months });
    const n = Object.keys(r.byCompany).length;
    log(`Layoffs: ${n} compan${n === 1 ? 'y' : 'ies'} labelled from ${file}` +
      (r.expired ? `, ${r.expired} older than ${settings.layoffs.months} months left off` : '') +
      (r.dropped.length ? ` (skipped: ${r.dropped.join('; ')})` : ''));
    return r.byCompany;
  } catch (err) {
    log(`::warning::Layoffs: ${file} could not be read: ${err.message}. No layoff labels this run; the rest of the run is not affected.`);
    return null;
  }
}
