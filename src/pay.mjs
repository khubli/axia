// Pay range per role: one small extra answer in the scoring call, never a separate request.
//
// Where a range comes from, most trusted first:
//   posting   the posting states pay; its own words are kept and checked against the posting text
//   table     your pay table (pay.yml) has figures for this employer; the model picks the level that fits
//   estimate  the model's own rough estimate for this kind of role, employer and place
// Each role's request carries only its own employer's lines from pay.yml, so the table can grow
// without making the nightly run heavier, and the score never depends on pay.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ConfigError } from './config.mjs';
import { inText, truncate } from './text.mjs';

export const PAY_SOURCES = ['posting', 'table', 'estimate', 'none'];
const PERIODS = ['year', 'month', 'hour'];
// Bump when PAY_RULES change in a way that should refill pay on roles scored before.
export const PAY_VERSION = 1;

export const PAY_FIELD = {
  type: 'object',
  description: 'The pay this role likely offers, as a range',
  properties: {
    source: { type: 'string', enum: PAY_SOURCES, description: 'posting, table, estimate or none' },
    currency: { type: 'string', description: 'ISO 4217 code of the amounts, such as INR, USD or AED' },
    low: { type: 'number', description: 'Low end, in whole currency units (₹45 lakh is 4500000)' },
    high: { type: 'number', description: 'High end, in whole currency units' },
    period: { type: 'string', enum: PERIODS },
    quote: { type: 'string', description: "The posting's own words for its pay, copied exactly; empty unless source is posting" },
    basis: { type: 'string', description: 'A few words on what the range rests on' },
  },
  required: ['source', 'currency', 'low', 'high', 'period', 'quote', 'basis'],
  additionalProperties: false,
};

export const PAY_RULES = `- pay: the role's likely pay as a range. Decide it separately from the score: it never moves the score.
  - If the posting states pay or a salary range, use it: source "posting", copy the posting's words for it into quote exactly, and give low and high as stated (the same number twice for a single figure) with its period.
  - Otherwise, if the job has <pay-data>, use it: source "table". Pick the job family and the level or levels that fit this role's seniority, take low and high from them, and name them in basis, such as "Software Engineering Manager, L5 to L6".
  - Otherwise give your own rough estimate of total yearly pay for this role at this employer in this place: source "estimate", with basis naming in a few words what it rests on, such as "director level, fintech, Bengaluru". Use source "none" (amounts 0) only when you cannot make a sensible estimate.
  - Amounts are whole numbers in the currency's own units, total pay (base, bonus and stock) unless the posting says otherwise. quote stays empty unless source is "posting".`;

/**
 * Your pay table (settings.yml → scoring.pay, pay.yml by default). Optional: without it every
 * range is from the posting or an estimate.
 *
 *   currency: INR                     # amounts below are in this currency unless a company says otherwise
 *   companies:
 *     Example Bank:
 *       source: Levels.fyi, India, median total pay, read 21 Oct 2026
 *       Software Engineering Manager: { L5: 8700000, L6: 5800000 }
 *       Solution Architect: "45 to 60 lakh"   # free text works too
 *   estimate_floor: 1500000           # optional: an AI estimate whose yearly top is below this is dropped
 */
export function loadPayGuide(settings, dir) {
  const file = settings.scoring.pay;
  if (!file) return empty();
  const path = resolve(dir, file);
  if (!existsSync(path)) return empty();
  const text = readFileSync(path, 'utf8');
  let raw;
  try {
    raw = parse(text) ?? {};
  } catch (err) {
    throw new ConfigError(`${file} is not valid YAML: ${err.message}`);
  }
  if (raw.companies != null && (typeof raw.companies !== 'object' || Array.isArray(raw.companies))) {
    throw new ConfigError(`${file}: companies must be a list of employer names, each with its job families (see docs/configuration.md#payyml)`);
  }
  const currency = String(raw.currency ?? 'INR').toUpperCase();
  const estimateFloor = raw.estimate_floor == null ? 0 : Number(raw.estimate_floor);
  if (!Number.isFinite(estimateFloor) || estimateFloor < 0) {
    throw new ConfigError(`${file}: estimate_floor must be a yearly amount in ${currency}, such as 1500000, not "${raw.estimate_floor}"`);
  }
  const companies = new Map();
  for (const [name, rows] of Object.entries(raw.companies ?? {})) {
    if (!rows || typeof rows !== 'object') continue;
    const { source, currency: own, ...families } = rows;
    companies.set(name.toLowerCase(), { source: source ? String(source) : '', currency: String(own ?? currency).toUpperCase(), families });
  }
  // Changes to the table refill pay on roles scored before (a catch-up pass compares this).
  // The floor is left out: it only drops bad estimates (dropImplausiblePay), so it never needs a refill.
  const tableText = text.replace(/^estimate_floor:.*(\r?\n|$)/m, '');
  const rev = createHash('sha256').update(`${PAY_VERSION}\n${tableText}`).digest('hex').slice(0, 12);
  return { companies, rev, currency, estimateFloor };
}

const empty = () => ({ companies: new Map(), rev: String(PAY_VERSION), currency: '', estimateFloor: 0 });

/** The <pay-data> lines for one job, or '' when the table has nothing for its employer. */
export function payContext(job, guide) {
  const c = guide?.companies?.get(String(job.company).toLowerCase());
  if (!c) return '';
  const lines = Object.entries(c.families)
    .map(([family, v]) => {
      if (v && typeof v === 'object') {
        const levels = Object.entries(v).filter(([, n]) => Number.isFinite(Number(n)) && Number(n) > 0);
        return levels.length ? `${family}: ${levels.map(([lvl, n]) => `${lvl} ${money(Number(n), c.currency)}`).join(', ')}` : null;
      }
      return v != null && String(v).trim() ? `${family}: ${String(v).trim()}` : null;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return `<pay-data currency="${c.currency}"${c.source ? ` source="${c.source.replace(/"/g, "'")}"` : ''}>\n${lines.join('\n')}\n</pay-data>`;
}

/** Short amounts for the request: ₹58.2L, ₹1.3Cr, $185k. */
function money(n, currency) {
  if (currency === 'INR') return n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)}Cr` : `₹${+(n / 1e5).toFixed(1)}L`;
  return `${n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : n} ${currency}`;
}

/**
 * The model's pay answer, checked: a "posting" figure whose quote isn't in the posting is kept only
 * as an estimate, and a range that makes no sense becomes "none". Returns undefined when the model
 * gave no pay answer at all (an older scorer), so the role simply has no pay field.
 */
export function cleanPay(pay, description, guide) {
  if (!pay || typeof pay !== 'object') return undefined;
  const none = { source: 'none' };
  let source = PAY_SOURCES.includes(pay.source) ? pay.source : 'estimate';
  if (source === 'none') return none;
  let low = Math.round(Number(pay.low));
  let high = Math.round(Number(pay.high));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return none;
  if (low > high) [low, high] = [high, low];
  if (low <= 0 && high > 0) low = high;
  if (high <= 0 || high > low * 20) return none;
  const currency = String(pay.currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return none;
  const period = PERIODS.includes(pay.period) ? pay.period : 'year';
  let quote = '';
  let basis = truncate(String(pay.basis ?? '').replace(/\s+/g, ' ').trim(), 120);
  if (source === 'posting') {
    if (inText(pay.quote, description)) quote = truncate(String(pay.quote).replace(/\s+/g, ' ').trim(), 220);
    else {
      source = 'estimate';
      basis = basis || 'pay the model read in the posting, not found word for word';
    }
  }
  const clean = { source, currency, low, high, period, ...(quote ? { quote } : {}), ...(basis ? { basis } : {}) };
  return implausible(clean, guide) ? none : clean;
}

/**
 * An AI estimate that can't be right: the model's stand-in values (basis "placeholder"), or a yearly
 * range topping out below estimate_floor in pay.yml, such as ₹5–8 lakh for a VP (a dropped zero).
 * Pay stated on the posting or taken from your table is never second-guessed.
 */
function implausible(pay, guide) {
  if (pay?.source !== 'estimate') return false;
  if (/\b(placeholder|tbd)\b/i.test(pay.basis ?? '')) return true;
  const floor = guide?.estimateFloor ?? 0;
  return floor > 0 && pay.currency === guide.currency && pay.period === 'year' && pay.high < floor;
}

/**
 * Pay already saved on roles that fails the same check (saved before the check, or before you set
 * estimate_floor) becomes "none", without asking the model again. Returns how many changed.
 */
export function dropImplausiblePay(jobs, guide) {
  let dropped = 0;
  for (const job of jobs) {
    const pay = job.score?.pay;
    if (!pay || !implausible(pay, guide)) continue;
    job.score.pay = { source: 'none', ...(pay.rev ? { rev: pay.rev } : {}) };
    dropped++;
  }
  return dropped;
}

/**
 * Pay as a catch-up field (catchup.mjs): roles scored before pay was asked for, or before your pay
 * table last changed. Each job carries its own employer's <pay-data>, as in scoring.
 */
export function payField(guide) {
  return {
    name: 'pay',
    schema: PAY_FIELD,
    rules: PAY_RULES,
    guide: '',
    context: (job) => payContext(job, guide),
    clean: (out, job) => cleanPay(out, job.description, guide),
    rev: guide.rev,
    example: '{"source":"estimate","currency":"INR","low":0,"high":0,"period":"year","quote":"","basis":""}',
  };
}
