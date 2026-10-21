// Reads companies.yml + settings.yml + the resume, and fails with a plain
// sentence (file, line of thought, what to do) when something is wrong.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { detect, PLATFORMS } from './sources/index.mjs';

/** Where your settings live when no --dir is given: the folder you run axia from. */
export const ROOT = process.cwd();

export class ConfigError extends Error {}

const DEFAULTS = {
  // second_look: titles in your places that your words reject get a look from the model (it can only let roles in).
  titles: { include: [], exclude: [], second_look: true },
  locations: { include: [], keep_unknown: true },
  scoring: { provider: 'auto', model: 'sonnet', effort: 'medium', base_url: '', max_ai_scores_per_run: 40, batch_size: 8, criteria: 'criteria.md', levels: 'levels.md', pay: 'pay.yml', keywords: [] },
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
  // Gaps that keep coming up: once a week, the gaps of open roles scored min_score to max_score,
  // grouped into themes on the dashboard. false turns it off.
  gaps: { min_score: 55, max_score: 89 },
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
  if (raw.moonshots === false || s.moonshots.file === false) s.moonshots = { file: '' };
  s.gaps.enabled = raw.gaps !== false;
  for (const key of ['min_score', 'max_score']) {
    const n = Number(s.gaps[key]);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new ConfigError(`settings.yml: gaps.${key} must be a whole number from 0 to 100`);
    s.gaps[key] = n;
  }
  if (s.gaps.min_score > s.gaps.max_score) throw new ConfigError('settings.yml: gaps.min_score must not be above gaps.max_score');
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
  for (const key of ['min_score']) {
    const n = Number(s.notify[key]);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new ConfigError(`settings.yml: notify.${key} must be a whole number from 0 to 100`);
    s.notify[key] = n;
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
    return {
      name: String(c.name),
      enabled: c.enabled !== false,
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
