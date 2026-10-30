// Reads companies.yml + settings.yml + the resume, and fails with a plain
// sentence (file, line of thought, what to do) when something is wrong.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { detect, PLATFORMS } from './sources/index.mjs';

/** Where your settings live when no --dir is given: the folder you run axia from. */
export const ROOT = process.cwd();

export class ConfigError extends Error {}

export const DEFAULTS = {
  // second_look: titles in your places that your words reject get a look from the model (it can only let roles in).
  titles: { include: [], exclude: [], second_look: true },
  locations: { include: [], keep_unknown: true },
  scoring: { provider: 'auto', model: 'sonnet', effort: 'medium', base_url: '', max_ai_scores_per_run: 40, rescore_on_edit: 'all', batch_size: 8, criteria: 'criteria.md', levels: 'levels.md', pay: 'pay.yml', keywords: [] },
  report: { timezone: 'UTC', good_match: 65, show_from: 50 },
  // Messages: new good matches as they are scored, problems once, and a weekly "still running" note.
  notify: { min_score: 65, weekly: 'monday' },
  // Where the private dashboard is published (Cloudflare). `url` is used for links in messages.
  // feedback: the dashboard's Applied / Shortlist / Not for me buttons save to Cloudflare (needs a private dashboard).
  dashboard: { url: '', worker: 'axia', domain: '', public: false, feedback: true },
  // The weekly review: on this day, your calls are checked against the scores, and a criteria.md change
  // that agrees with them better is proposed as a pull request. false turns it off.
  review: { day: 'sunday', max_roles: 60 },
  // Moonshots: stretch roles you track outside Axia (another tool or a research task writes the file),
  // shown on their own dashboard tab, not scored. No file, no tab. false turns it off.
  moonshots: { file: 'moonshots.json' },
  // Recent layoffs: a heads-up label on companies you list in this file (kept by hand, no AI),
  // shown for `months` calendar months after the announcement. No file, no labels. false turns it off.
  layoffs: { file: 'layoffs.yml', months: 6 },
  // Gaps that keep coming up: once a week, the gaps of open roles scored min_score to max_score,
  // grouped into themes on the dashboard. false turns it off.
  gaps: { min_score: 55, max_score: 89 },
  // Hiring heat per company (heat.mjs): worked out free each run, plus a weekly scan of hiring news
  // (news: true) and, with an X_BEARER_TOKEN, X posts from x_handles and about your x_companies
  // top-ranked companies, at most x_max_posts a week. signals is your own file; days is how long a
  // signal counts. false turns it all off.
  heat: { news: true, signals: 'signals.yml', days: 60, x_handles: [], x_companies: 10, x_max_posts: 40 },
  // Tailor buttons: queue a role or moonshot for a tailored resume and cover letter, made by your own
  // tool outside Axia. Off by default; `tailor: true` turns it on. `done` is the file that tool writes.
  // dispatch: owner/repo whose tailoring workflow (workflow, on branch ref) a click starts at once.
  tailor: { enabled: false, done: 'tailored.json', dispatch: '', workflow: 'tailor.yml', ref: 'main' },
  // What came of an application: the reasons you can pick when you mark an Applied role Rejected
  // (the company said no) or Turned down (you said no), and the stages it can happen at (optional).
  outcomes: {
    rejected: [
      'No reason given', 'Not a match for the role', 'Role closed, on hold or cancelled', 'Went with another candidate',
      'Seen as overqualified', 'Seen as not senior enough', 'Missing skill or domain', 'Pay expectations',
      'Location or notice period', 'No reply', 'Other',
    ],
    turned_down: [
      'Pay below expectations', 'Level or title too low', 'Role differs from the posting', 'Location, relocation or office days',
      'Company or team concerns', 'Took another offer', 'Staying where I am', 'Process too long', 'Other',
    ],
    stages: ['Before any call', 'After the recruiter call', 'After interviews', 'After the final round', 'After an offer'],
  },
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function readYaml(path) {
  if (!existsSync(path)) throw new ConfigError(`Missing ${path}`);
  try {
    return parse(readFileSync(path, 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${err.message}`);
  }
}

export function loadSettings(dir = ROOT) {
  const raw = readYaml(resolve(dir, 'settings.yml'));
  const s = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) s[section] = { ...defaults, ...(raw[section] ?? {}) };
  s.resume = raw.resume ?? 'cv.md';
  if (typeof raw.tailor === 'boolean') s.tailor = { ...DEFAULTS.tailor, enabled: raw.tailor };
  if (typeof s.tailor.enabled !== 'boolean') throw new ConfigError(`settings.yml: tailor.enabled must be true or false without quotes, not "${s.tailor.enabled}"`);
  if (typeof s.tailor.done !== 'string' || !s.tailor.done.trim()) throw new ConfigError(`settings.yml: tailor.done must be a file name (for example tailored.json), not "${s.tailor.done}"`);
  s.tailor.dispatch = String(s.tailor.dispatch || '').trim();
  if (s.tailor.dispatch && !/^[\w.-]+\/[\w.-]+$/.test(s.tailor.dispatch)) throw new ConfigError(`settings.yml: tailor.dispatch must be owner/repository, not "${s.tailor.dispatch}"`);
  if (!/^[\w.-]+\.ya?ml$/.test(String(s.tailor.workflow))) throw new ConfigError(`settings.yml: tailor.workflow must be a workflow file name such as tailor.yml, not "${s.tailor.workflow}"`);
  if (!/^[\w./-]+$/.test(String(s.tailor.ref))) throw new ConfigError(`settings.yml: tailor.ref must be a branch name, not "${s.tailor.ref}"`);
  if (raw.moonshots === false || s.moonshots.file === false) s.moonshots = { file: '' };
  s.gaps.enabled = raw.gaps !== false;
  for (const key of ['min_score', 'max_score']) {
    const n = Number(s.gaps[key]);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new ConfigError(`settings.yml: gaps.${key} must be a whole number from 0 to 100`);
    s.gaps[key] = n;
  }
  if (s.gaps.min_score > s.gaps.max_score) throw new ConfigError('settings.yml: gaps.min_score must not be above gaps.max_score');
  s.heat.enabled = raw.heat !== false;
  if (raw.heat === false) s.heat = { ...DEFAULTS.heat, enabled: false };
  if (typeof s.heat.news !== 'boolean') throw new ConfigError(`settings.yml: heat.news must be true or false without quotes, not "${s.heat.news}"`);
  if (s.heat.signals === false) s.heat.signals = '';
  if (typeof s.heat.signals !== 'string') throw new ConfigError(`settings.yml: heat.signals must be a file name (for example signals.yml) or false, not "${s.heat.signals}"`);
  if (!Array.isArray(s.heat.x_handles)) throw new ConfigError('settings.yml: heat.x_handles must be a list of X handles, such as [narayani07]');
  s.heat.x_handles = s.heat.x_handles.map((h) => String(h).trim().replace(/^@/, '')).filter(Boolean);
  for (const h of s.heat.x_handles) if (!/^\w{1,15}$/.test(h)) throw new ConfigError(`settings.yml: heat.x_handles has "${h}", which is not an X handle (letters, digits and _ only, at most 15)`);
  for (const [key, min, max] of [['days', 1, 365], ['x_companies', 0, 50], ['x_max_posts', 0, 500]]) {
    const n = Number(s.heat[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`settings.yml: heat.${key} must be a whole number from ${min} to ${max}, not "${s.heat[key]}"`);
    s.heat[key] = n;
  }
  if (raw.layoffs === false || s.layoffs.file === false) s.layoffs = { ...DEFAULTS.layoffs, file: '' };
  if (typeof s.layoffs.file !== 'string') throw new ConfigError(`settings.yml: layoffs.file must be a file name (for example layoffs.yml) or false, not "${s.layoffs.file}"`);
  {
    const n = Number(s.layoffs.months);
    if (!Number.isInteger(n) || n < 1 || n > 36) throw new ConfigError(`settings.yml: layoffs.months must be a whole number of months from 1 to 36, not "${s.layoffs.months}"`);
    s.layoffs.months = n;
  }
  if (typeof s.moonshots.file !== 'string') throw new ConfigError(`settings.yml: moonshots.file must be a file name (for example moonshots.json) or false, not "${s.moonshots.file}"`);
  // Older settings kept the dashboard link under report.
  if (!s.dashboard.url && s.dashboard.domain) s.dashboard.url = `https://${s.dashboard.domain}`;
  if (!s.dashboard.url && raw.report?.dashboard_url) s.dashboard.url = raw.report.dashboard_url;
  s.dashboard.url = String(s.dashboard.url || '').replace(/\/+$/, '');
  const weekly = s.notify.weekly;
  if (weekly !== false && !WEEKDAYS.includes(String(weekly).toLowerCase())) throw new ConfigError(`settings.yml: notify.weekly must be a weekday (for example monday) or false, not "${weekly}"`);
  s.notify.weekly = weekly === false ? false : String(weekly).toLowerCase();
  const reviewDay = s.review.day;
  if (reviewDay !== false && !WEEKDAYS.includes(String(reviewDay).toLowerCase())) throw new ConfigError(`settings.yml: review.day must be a weekday (for example sunday) or false, not "${reviewDay}"`);
  s.review.day = reviewDay === false ? false : String(reviewDay).toLowerCase();
  s.review.max_roles = Math.max(1, Number(s.review.max_roles) || 60);
  if (typeof s.dashboard.feedback !== 'boolean') throw new ConfigError(`settings.yml: dashboard.feedback must be true or false without quotes, not "${s.dashboard.feedback}"`);
  if (typeof s.titles.second_look !== 'boolean') throw new ConfigError(`settings.yml: titles.second_look must be true or false without quotes, not "${s.titles.second_look}"`);
  if (typeof s.dashboard.public !== 'boolean') throw new ConfigError(`settings.yml: dashboard.public must be true or false without quotes, not "${s.dashboard.public}"`);
  {
    const v = s.scoring.rescore_on_edit;
    const n = Number(v);
    if (v === false || String(v).toLowerCase() === 'none') s.scoring.rescore_on_edit = 'none';
    else if (v === true || String(v).toLowerCase() === 'all' || n === 0) s.scoring.rescore_on_edit = 'all';
    else if (Number.isInteger(n) && n > 0 && n <= 100) s.scoring.rescore_on_edit = n;
    else throw new ConfigError(`settings.yml: scoring.rescore_on_edit must be all, none or a score from 1 to 100, not "${v}"`);
  }
  for (const key of ['min_score']) {
    const n = Number(s.notify[key]);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new ConfigError(`settings.yml: notify.${key} must be a whole number from 0 to 100`);
    s.notify[key] = n;
  }
  for (const key of ['rejected', 'turned_down', 'stages']) {
    const v = s.outcomes[key];
    if (!Array.isArray(v) || (key !== 'stages' && !v.length)) throw new ConfigError(`settings.yml: outcomes.${key} must be a list${key === 'stages' ? '' : ' with at least one reason'}`);
    const long = v.find((x) => String(x).trim().length > 80);
    if (long) throw new ConfigError(`settings.yml: outcomes.${key} entries must be 80 characters or fewer: "${String(long).slice(0, 40)}…"`);
    s.outcomes[key] = [...new Set(v.map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  }
  for (const [section, key] of [['titles', 'include'], ['titles', 'exclude'], ['locations', 'include'], ['scoring', 'keywords']]) {
    const v = s[section][key] ?? [];
    if (!Array.isArray(v)) throw new ConfigError(`settings.yml: ${section}.${key} must be a list`);
    s[section][key] = v.map(String).filter((x) => x.trim());
  }
  if (s.titles.include.length === 0) throw new ConfigError('settings.yml: titles.include is empty — list at least one job title keyword');
  return s;
}

export function loadCompanies(dir = ROOT) {
  const raw = readYaml(resolve(dir, 'companies.yml'));
  const list = Array.isArray(raw) ? raw : raw.companies;
  if (!Array.isArray(list) || list.length === 0) throw new ConfigError('companies.yml: expected a list of companies (name + url)');
  return list.map((c, i) => {
    if (!c?.name) throw new ConfigError(`companies.yml: entry ${i + 1} has no name`);
    const urls = [c.url].flat().filter(Boolean).map(String);
    if (urls.length === 0) throw new ConfigError(`companies.yml: ${c.name} has no url`);
    const platform = c.platform ? String(c.platform).toLowerCase() : undefined;
    if (platform && !PLATFORMS.includes(platform)) throw new ConfigError(`companies.yml: ${c.name} has platform "${c.platform}"; known platforms: ${PLATFORMS.join(', ')}`);
    if (c.rank != null && !(Number.isInteger(c.rank) && c.rank > 0)) throw new ConfigError(`companies.yml: ${c.name} has rank "${c.rank}"; a rank is a whole number from 1 (your favourite)`);
    return {
      name: String(c.name),
      enabled: c.enabled !== false,
      // For hiring heat: your rank (1 = favourite) and the name the news uses, when it differs.
      ...(c.rank != null ? { rank: c.rank } : {}),
      ...(c.news ? { news: String(c.news) } : {}),
      boards: urls.map((url) => ({ url, ...(detect(url, platform) ?? { source: null, params: null }) })),
    };
  });
}

/** What a good role looks like for you, beyond the resume. Optional, but scoring is much sharper with it. */
export function loadCriteria(settings, dir = ROOT) {
  if (!settings.scoring.criteria) return '';
  const path = resolve(dir, settings.scoring.criteria);
  if (!existsSync(path)) {
    // Scoring still works from the resume alone; say so rather than stop the daily run.
    console.warn(`Note: criteria file not found at ${path} (settings.yml → scoring.criteria); scoring from the resume only.`);
    return '';
  }
  return readFileSync(path, 'utf8').trim();
}

export function loadResume(settings, dir = ROOT) {
  const path = resolve(dir, settings.resume);
  if (!existsSync(path)) throw new ConfigError(`Resume not found at ${path} (settings.yml → resume)`);
  const text = readFileSync(path, 'utf8').trim();
  if (text.length < 200) throw new ConfigError(`Resume at ${path} looks empty`);
  return text;
}
