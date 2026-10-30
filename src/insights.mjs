// Insights: what your companies' roles keep asking for, and how often your resume shows it.
// Counted from the must-haves each AI score already quotes from the posting (requirement + quote,
// matched yes / partly / no), against a short word list per theme (settings.yml → insights.themes).
// Also where your best-fit roles are by city, and how fast they close. No AI requests, ever.

import { jobId, citiesOf, truncate } from './text.mjs';
import { daysBetween } from './state.mjs';

// The themes counted when settings.yml has none of its own. A word ending in * matches any word
// that starts with it ("migrat*": migrate, migration); any other word or phrase matches as a whole
// word, with or without a plural s. Case never matters.
export const DEFAULT_THEMES = [
  { name: 'Public cloud', words: ['cloud*', 'aws', 'azure', 'gcp', 'google cloud'] },
  { name: 'Hands-on engineering', words: ['hands-on', 'hands on', 'coding', 'programming', 'full-stack', 'full stack', 'frontend', 'backend', 'software development', 'python', '.net', 'golang', 'c++'] },
  { name: 'People leadership', words: ['people lead*', 'people manag*', 'team lead*', 'team manag*', 'leading teams', 'lead teams', 'leading engineering', 'hire', 'hiring', 'mentor*', 'coach*', 'talent', 'engineering manag*', 'line manag*'] },
  { name: 'APIs and integration', words: ['api*', 'integrat*', 'middleware', 'esb', 'swagger', 'openapi', 'restful', 'soap', 'interfaces'] },
  { name: 'Microservices and distributed systems', words: ['microservice*', 'distributed', 'scalab*', 'high availability', 'resilien*'] },
  { name: 'Architecture governance', words: ['governance', 'design authority', 'enterprise architect*', 'togaf', 'standards', 'architecture review*', 'design review*', 'archimate', 'reference architecture*', 'roadmap*'] },
  { name: 'AI and GenAI', words: ['ai', 'genai', 'gen ai', 'generative', 'llm*', 'agentic', 'machine learning', 'ml', 'rag', 'prompt*', 'copilot', 'mlops', 'llmops'] },
  { name: 'Payments', words: ['payment*', 'iso 20022', 'iso20022', 'swift', 'card', 'acquiring', 'acquirer*', 'clearing', 'settlement*', 'upi', 'rtgs', 'neft', 'nach', 'wire transfer*', 'remittance*', 'cross-border'] },
  { name: 'Java and Spring', words: ['java', 'spring*', 'j2ee', 'jvm'] },
  { name: 'Regulation, risk and audit', words: ['regulat*', 'compliance', 'aml', 'kyc', 'sanction*', 'fraud', 'financial crime*', 'audit*', 'risk'] },
  { name: 'Event-driven and messaging', words: ['kafka', 'event-driven', 'event driven', 'streaming', 'messaging', 'mq', 'pub/sub', 'rabbitmq'] },
  { name: 'Solution and target-state design', words: ['solution architect*', 'solution design*', 'target state', 'target-state', 'end-to-end design', 'system design', 'hld', 'lld'] },
  { name: 'Modernisation and migration', words: ['moderni*', 'migrat*', 'legacy', 'transformation*', 're-platform*', 'replatform*', 'decommission*'] },
  { name: 'Agile and product owner', words: ['agile', 'scrum', 'product owner*', 'backlog*', 'user stor*', 'epic', 'kanban'] },
  { name: 'Core banking', words: ['core banking', 'finacle', 't24', 'temenos', 'flexcube', 'casa', 'lending', 'loan', 'deposit', 'retail banking', 'digital banking'] },
  { name: 'Leading leaders and scale', words: ['manager of managers', 'managers of managers', 'multiple teams', 'large organi*', 'budget*', 'p&l', 'global team*'] },
  { name: 'DevOps and CI/CD', words: ['devops', 'devsecops', 'ci/cd', 'continuous integration', 'continuous delivery', 'gitops', 'tdd', 'test-driven'] },
  { name: 'Product management', words: ['product manag*', 'product roadmap*', 'product strateg*', 'product development'] },
  { name: 'Data platforms', words: ['data platform*', 'data engineer*', 'data model*', 'data strategy', 'data architect*', 'snowflake', 'databricks', 'spark', 'etl', 'analytics', 'data lake*', 'data warehous*'] },
  { name: 'Wealth and capital markets', words: ['wealth', 'private bank*', 'asset management', 'asset manager*', 'custody', 'securities', 'capital market*', 'investment bank*', 'trading', 'fund', 'corporate action*'] },
  { name: 'Stakeholders and executives', words: ['stakeholder*', 'influenc*', 'executive*', 'c-suite', 'senior management', 'communicat*', 'board'] },
  { name: 'Kubernetes and infrastructure as code', words: ['kubernetes', 'k8s', 'container*', 'docker', 'terraform', 'iac', 'infrastructure as code', 'openshift', 'helm'] },
  { name: 'Security and IAM', words: ['security', 'iam', 'identity', 'zero trust', 'threat model*', 'cyber*', 'secure by design'] },
  { name: 'Production support and SRE', words: ['sre', 'site reliability', 'production support', 'incident*', 'on-call', 'observability', 'run the bank', 'service operations'] },
  { name: 'Vendors and partners', words: ['vendor*', 'partner*', 'third-party', 'outsourc*'] },
];

const MAX_THEMES = 40;
const MAX_IDS = 12; // open roles listed under a theme on the dashboard
const MIN_CITY_ROLES = 10; // a city needs this many scored roles to get a row
const MAX_CITIES = 8;
const NOT_A_CITY = /^(india|remote|anywhere|multiple locations?|various)$/i;
const WEEK_DAYS = 7;
const MAX_WEEKS = 26; // weekly snapshots kept, for trends

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One word from the list → a pattern: "migrat*" is a prefix, anything else a whole word (plural s allowed). */
function wordPattern(word) {
  const w = String(word).trim().toLowerCase();
  const prefix = w.endsWith('*');
  const body = escapeRe(prefix ? w.slice(0, -1) : w).replace(/\\?[ -]/g, '[ -]?');
  return `(?<![a-z0-9])${body}${prefix ? '' : 's?(?![a-z0-9])'}`;
}

/** settings.yml themes → [{ name, re }]. Bad entries are refused in config.mjs; this only builds. */
export function compileThemes(list) {
  return list.map((t) => ({ name: t.name, re: new RegExp(t.words.map(wordPattern).join('|'), 'i') }));
}

/** Checks settings.yml → insights.themes; returns the clean list or a sentence saying what is wrong. */
export function checkThemes(list) {
  if (!Array.isArray(list) || !list.length) return { error: 'insights.themes must be a list of themes, each with a name and words' };
  if (list.length > MAX_THEMES) return { error: `insights.themes can have at most ${MAX_THEMES} themes` };
  const out = [];
  const names = new Set();
  for (const t of list) {
    const name = String(t?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60) return { error: 'every theme in insights.themes needs a name of at most 60 characters' };
    if (names.has(name.toLowerCase())) return { error: `insights.themes has "${name}" twice` };
    names.add(name.toLowerCase());
    const words = Array.isArray(t.words) ? t.words.map((w) => String(w).trim()).filter((w) => w && w !== '*') : [];
    if (!words.length) return { error: `the theme "${name}" in insights.themes needs a list of words, such as [cloud*, aws, azure]` };
    out.push({ name, words });
  }
  return { themes: out };
}

const scored = (j) => j.score?.scorer === 'ai';
const mustsText = (m) => `${m.requirement ?? ''} ${m.quote ?? ''}`;
const WEIGHT = { yes: 1, partly: 0.5, no: 0 };

/** For each theme: roles asking it, and the yes / partly / no of the must-haves that name it. */
function countThemes(roles, themes) {
  const withMusts = roles.filter((j) => j.score.musts?.length);
  const rows = themes.map((t) => ({ name: t.name, asked: 0, yes: 0, partly: 0, no: 0, keys: [] }));
  for (const j of withMusts) {
    themes.forEach((t, i) => {
      const hits = j.score.musts.filter((m) => t.re.test(mustsText(m)));
      if (!hits.length) return;
      const r = rows[i];
      r.asked++;
      for (const m of hits) if (m.match in WEIGHT) r[m.match]++;
      r.keys.push(j);
    });
  }
  const pct = (n, of) => (of ? Math.round((100 * n) / of) : 0);
  return {
    roles: roles.length,
    withMusts: withMusts.length,
    themes: rows
      .filter((r) => r.asked)
      .map((r) => {
        const judged = r.yes + r.partly + r.no;
        return {
          name: r.name,
          asked: r.asked,
          askedPct: pct(r.asked, withMusts.length),
          matchPct: judged ? Math.round((100 * (r.yes + r.partly * 0.5)) / judged) : null,
          yes: r.yes,
          partly: r.partly,
          no: r.no,
          keys: r.keys.sort((a, b) => b.score.value - a.score.value).map((j) => j.key),
        };
      })
      .sort((a, b) => b.asked - a.asked || a.name.localeCompare(b.name)),
  };
}

/** Scored roles and best-fit (show_from+) roles per city, for cities with enough roles to say anything. */
function cityRows(roles, floor) {
  const by = new Map();
  for (const j of roles) {
    for (const c of citiesOf(j.location).filter((c) => !NOT_A_CITY.test(c))) {
      const r = by.get(c) ?? { city: c, scored: 0, fit: 0 };
      r.scored++;
      if (j.score.value >= floor) r.fit++;
      by.set(c, r);
    }
  }
  return [...by.values()]
    .filter((r) => r.scored >= MIN_CITY_ROLES)
    .map((r) => ({ ...r, fitPct: Math.round((100 * r.fit) / r.scored) }))
    .sort((a, b) => b.fit - a.fit || b.scored - a.scored || a.city.localeCompare(b.city))
    .slice(0, MAX_CITIES);
}

/** How long best-fit roles stayed up: days from Axia first seeing them to their close. */
function closing(fit) {
  const days = fit.filter((j) => j.status === 'closed' && j.closedOn && j.firstSeen).map((j) => Math.max(0, daysBetween(j.firstSeen, j.closedOn))).sort((a, b) => a - b);
  if (!days.length) return { closed: 0, of: fit.length };
  const mid = days.length >> 1;
  const median = days.length % 2 ? days[mid] : Math.round((days[mid - 1] + days[mid]) / 2);
  return { closed: days.length, of: fit.length, medianDays: median, withinWeek: days.filter((d) => d <= WEEK_DAYS).length, longest: days.at(-1) };
}

/** Everything the Insights tab shows, worked out from memory. null when turned off or nothing is scored yet. */
export function insightsView(state, settings) {
  if (settings.insights?.enabled === false) return null;
  const themes = compileThemes(settings.insights?.themes ?? DEFAULT_THEMES);
  const floor = settings.report.show_from;
  const all = Object.values(state.jobs).filter(scored);
  if (!all.length) return null;
  const fit = all.filter((j) => j.score.value >= floor);
  return {
    floor,
    since: all.reduce((m, j) => (j.firstSeen && j.firstSeen < m ? j.firstSeen : m), all[0].firstSeen ?? null),
    fit: countThemes(fit, themes),
    all: countThemes(all, themes),
    cities: cityRows(all, floor),
    closing: closing(fit),
    weeks: state.insights?.weeks ?? [],
  };
}

/**
 * Once a week, keep a small snapshot of the best-fit theme shares, so a later version can show
 * which asks are rising or fading. Free; at most MAX_WEEKS kept. Returns true when one was added.
 */
export function recordInsights(state, settings, today) {
  const v = insightsView(state, settings);
  if (!v || !v.fit.withMusts) return false;
  const weeks = state.insights?.weeks ?? [];
  const last = weeks.at(-1);
  if (last && daysBetween(last.on, today) < WEEK_DAYS) return false;
  const themes = {};
  for (const t of v.fit.themes) themes[t.name] = [t.askedPct, t.matchPct];
  state.insights = { weeks: [...weeks, { on: today, roles: v.fit.withMusts, themes }].slice(-MAX_WEEKS) };
  return true;
}

/** For the page: role keys become dashboard ids, and only open roles are listed under a theme. */
export function pageInsights(state, settings) {
  const v = insightsView(state, settings);
  if (!v) return null;
  const set = (s) => ({
    roles: s.roles,
    withMusts: s.withMusts,
    themes: s.themes.map(({ keys, ...t }) => ({ ...t, ids: keys.filter((k) => state.jobs[k]?.status === 'open').slice(0, MAX_IDS).map(jobId) })),
  });
  return { ...v, fit: set(v.fit), all: set(v.all) };
}

/**
 * `axia insights`: the theme counts from your memory, printed. Writes nothing.
 */
export async function previewInsights({ dir, log = console.log }) {
  const { resolve } = await import('node:path');
  const { loadSettings } = await import('./config.mjs');
  const { loadState } = await import('./state.mjs');
  const settings = loadSettings(dir);
  const state = loadState(resolve(dir, 'data/jobs.json'));
  const v = insightsView(state, { ...settings, insights: { ...settings.insights, enabled: true } });
  if (!v) return log('No AI-scored roles yet, so there is nothing to count.');
  for (const [label, s] of [[`Roles scored ${v.floor}+`, v.fit], ['All scored roles', v.all]]) {
    log(`\n${label}: ${s.roles} (${s.withMusts} with must-haves)`);
    log('  asked  match  theme');
    for (const t of s.themes) log(`  ${String(t.askedPct).padStart(4)}%  ${t.matchPct == null ? '   –' : String(t.matchPct).padStart(4) + '%'}  ${truncate(t.name, 60)}`);
  }
  if (v.cities.length) {
    log(`\nBy city: roles scored, and how many scored ${v.floor}+`);
    for (const c of v.cities) log(`  ${c.city.padEnd(14)} ${String(c.scored).padStart(5)}  ${String(c.fit).padStart(4)}  (${c.fitPct}%)`);
  }
  const c = v.closing;
  if (c.closed) log(`\n${c.closed} of ${c.of} roles scored ${v.floor}+ have closed: a median of ${c.medianDays} days after Axia first saw them, ${c.withinWeek} within a week.`);
  return v;
}
