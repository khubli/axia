// The hosted dashboard: one self-contained page (data embedded) plus its icons,
// written to .axia/site/ for `axia deploy` to publish. Nothing here is committed.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewModel } from './render.mjs';
import { jobId, citiesOf } from './text.mjs';
export { citiesOf };
import { daysBetween } from './state.mjs';
import { feedbackEnabled, pageFeedback } from './feedback.mjs';
import { tailorEnabled, tailorApi, pageTailor } from './tailor.mjs';
import { gapsView } from './gaps.mjs';
import { pageInsights } from './insights.mjs';
import { pageTodo } from './todo.mjs';
import { MOVE_POINTS } from './changes.mjs';
import { reasonOf } from './heat.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'dashboard');
const ICONS = ['icon.svg', 'icon-32.png', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const FONTS = readdirSync(join(ASSETS, 'fonts')).filter((f) => f.endsWith('.woff2')).sort();
const CLOSED_SHOWN_DAYS = 7;
// Calls that mean "I'm pursuing this": those roles are kept on the Your roles tab after they close.
const KEPT_CALLS = ['applied', 'shortlist'];

const modelName = (m) => (m ? m.replace(/^claude-/, '').replace(/-\d.*$/, '').replace(/^\w/, (c) => c.toUpperCase()) : null);

/** "IST", "BST", "EDT"…: the first English locale that knows a name for the zone, else "GMT+1"-style. */
export function tzLabel(timeZone, at) {
  const names = ['en-GB', 'en-IN', 'en-US', 'en-AU'].map(
    (locale) => new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value,
  );
  return names.find((n) => n && !/^(GMT|UTC)[+−-]/.test(n)) ?? names[0] ?? timeZone;
}

/** Everything the page shows, as one JSON object. */
export function siteData(view, { minScore, demo = false }) {
  const { state, summary, settings } = view;
  const v = viewModel(view);
  const today = summary.today;
  // Roles you marked Applied or Shortlist stay on the page after they close, for the Your roles tab.
  const calls = view.feedback?.roles ?? {};
  const kept = (key) => KEPT_CALLS.includes(calls[key]?.verdict);
  const jobs = Object.values(state.jobs)
    .filter((j) => j.status === 'open' || (j.closedOn && daysBetween(j.closedOn, today) < CLOSED_SHOWN_DAYS) || kept(j.key))
    .map((j) => {
      const ai = j.score?.scorer === 'ai';
      return {
        id: jobId(j.key),
        company: j.company,
        title: String(j.title).replace(/\s+/g, ' ').trim(),
        location: j.location || null,
        cities: citiesOf(j.location),
        url: j.url,
        postedAt: j.postedAt || null,
        firstSeen: j.firstSeen,
        secondLook: j.secondLook || null,
        status: j.status,
        closedOn: j.closedOn || null,
        ai,
        score: j.score?.value ?? null,
        summary: ai ? j.score.summary : null,
        strengths: ai ? j.score.strengths ?? [] : [],
        gaps: ai ? j.score.gaps ?? [] : [],
        musts: ai ? j.score.musts ?? [] : [],
        level: ai ? levelView(j.score.level) : null,
        pay: ai && j.score.pay?.source && j.score.pay.source !== 'none' ? j.score.pay : null,
        model: ai ? modelName(j.score.model) : null,
        resumeRev: ai ? String(j.score.resumeHash ?? '').slice(0, 6) : null,
        scoredOn: j.score?.scoredOn ?? null,
      };
    });
  // Marked roles Axia has already forgotten (closed more than 45 days ago) come from data/feedback.json.
  for (const [key, r] of Object.entries(calls)) {
    if (!kept(key) || state.jobs[key]) continue;
    const ai = r.score?.scorer === 'ai';
    jobs.push({
      id: r.id, company: r.company, title: String(r.title).replace(/\s+/g, ' ').trim(), location: r.location || null, cities: citiesOf(r.location),
      url: r.url, postedAt: null, firstSeen: null, secondLook: null, status: 'closed', closedOn: null,
      ai, score: r.score?.value ?? null, summary: null, strengths: [], gaps: [], level: ai ? levelView(r.score.level) : null,
      model: ai ? modelName(r.score.model) : null, resumeRev: ai ? String(r.score.resumeHash ?? '').slice(0, 6) : null, scoredOn: null,
    });
  }
  return {
    runAt: summary.runAt,
    today,
    closedShownDays: CLOSED_SHOWN_DAYS,
    demo,
    timeZone: settings.report.timezone,
    tz: tzLabel(settings.report.timezone, summary.runAt),
    goodMatch: settings.report.good_match,
    showFrom: settings.report.show_from,
    notifyMin: minScore,
    aiPerDay: settings.scoring.max_ai_scores_per_run,
    ai: { enabled: Boolean(summary.ai.enabled), pending: summary.ai.pending ?? 0, stoppedBecause: summary.ai.stoppedBecause ?? null },
    listed: summary.counts.listed,
    companies: v.companies.map((c) => ({ name: c.company, url: c.url, status: c.status, error: c.error ?? null, listed: c.listed, lastReadOk: state.companies?.[c.company]?.lastReadOk ?? null })),
    jobs,
    nearMisses: summary.nearMisses ?? null,
    // Your calls on roles. With `api`, the buttons save to your Cloudflare account; otherwise (the demo) only in this browser.
    feedback: { api: !demo && feedbackEnabled(settings), entries: pageFeedback(view.feedback) },
    // The reasons and stages you can pick for an Applied role you heard back on (settings.yml → outcomes).
    outcomes: { rejected: settings.outcomes?.rejected ?? [], turnedDown: settings.outcomes?.turned_down ?? [], stages: settings.outcomes?.stages ?? [] },
    // Tailor buttons (settings.yml → tailor), null when off. Requests go to the same store as your calls.
    tailor: tailorEnabled(settings) ? { api: !demo && tailorApi(settings), entries: pageTailor(view.tailor) } : null,
    // Stretch roles from your own research (moonshots.json), on their own tab; null means no tab.
    // Gaps that keep coming up across your close calls (gaps.mjs); null until the first roll-up.
    gaps: pageGaps(state, settings),
    // What your companies' roles keep asking for, where your best-fit roles are, how fast they close (insights.mjs).
    insights: pageInsights(state, settings),
    // Your to-do list (todo.yml and items added on the dashboard) with the ticks and notes you made; null when off.
    // With `api`, ticks save to your Cloudflare account like your calls; otherwise (the demo) only in this browser.
    todo: view.todo ? pageTodo(view.todo.items, view.todo.ticks, { api: !demo && feedbackEnabled(settings) }) : null,
    // What the last run changed (changes.mjs); null before the first run that records it.
    brief: pageBrief(summary.changes, state),
    // Recent layoffs from your layoffs.yml, by company name: a label only, never part of the score.
    layoffs: view.layoffs ?? {},
    layoffMonths: settings.layoffs?.months ?? 6,
    // Hiring heat per company (heat.mjs) and this week's companies to put effort into; null when off.
    heat: view.heat ? pageHeat(view.heat) : null,
    moonshots: view.moonshots ? (view.moonshots.problem ? { problem: view.moonshots.problem } : { ...view.moonshots.report, dropped: undefined }) : null,
  };
}

function pageBrief(changes, state) {
  if (!changes) return null;
  const ids = (keys) => keys.filter((k) => state.jobs[k]).map(jobId);
  return {
    line: changes.line,
    since: changes.since,
    new: ids(changes.new),
    scored: ids(changes.scored),
    movePoints: MOVE_POINTS,
    moved: changes.moved.filter((m) => state.jobs[m.key]).map((m) => ({ id: jobId(m.key), from: m.from })),
    closed: ids(changes.closed),
    reopened: ids(changes.reopened),
    notified: ids(changes.notified),
    companies: changes.companies,
    pending: changes.pending,
    // Recent runs, one line each, newest (this run) first.
    history: state.history ?? [],
  };
}

function pageHeat(heat) {
  const companies = {};
  for (const [name, v] of Object.entries(heat.companies)) companies[name] = { points: v.points, level: v.level, reason: reasonOf(v), rank: v.rank, signals: v.signals, layoffNews: Boolean(v.layoffNews) };
  return { companies, effort: heat.effort, scannedOn: heat.scannedOn, x: heat.x, xProblem: heat.xProblem };
}

/** The role's level against yours, for the page: { vs, note } without the guide version. */
const levelView = (level) => (level?.vs ? { vs: level.vs, note: level.note ?? null } : null);

function pageGaps(state, settings) {
  const g = gapsView(state, settings);
  return g && { ...g, themes: g.themes.map((t) => ({ theme: t.theme, ids: t.keys.map(jobId) })) };
}

/** The page with its data embedded. `<` is escaped so no value can close the script tag. */
export function renderSite(data) {
  // U+2028/2029 are escaped as well: valid in JSON, but some script parsers read them as line breaks.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return readFileSync(join(ASSETS, 'template.html'), 'utf8').replace('/*__AXIA_DATA__*/null', () => json);
}

// Colours match the page, so the status bar and splash screen blend into the app.
const MANIFEST = {
  id: './',
  name: 'Axia',
  short_name: 'Axia',
  description: 'Open roles at your companies, scored against your resume.',
  start_url: './',
  scope: './',
  display: 'standalone',
  display_override: ['standalone'],
  orientation: 'any',
  background_color: '#F3F5F8',
  theme_color: '#F3F5F8',
  categories: ['productivity', 'business'],
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};

// Fresh data on every visit; never indexed, framed or leaked through a referrer.
const HEADERS = `/
  Cache-Control: no-store
/index.html
  Cache-Control: no-store
/version.json
  Cache-Control: no-store
/sw.js
  Cache-Control: no-cache
/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
`;

/** The service worker, versioned by its own code and the files it caches, so any change to them installs a new one. */
export function serviceWorker() {
  const assets = ['manifest.webmanifest', ...ICONS, ...FONTS.map((f) => `fonts/${f}`)];
  const hash = createHash('sha256');
  const source = readFileSync(join(ASSETS, 'sw.js'), 'utf8');
  hash.update(source);
  for (const a of assets) if (a !== 'manifest.webmanifest') hash.update(readFileSync(join(ASSETS, a)));
  hash.update(JSON.stringify(MANIFEST));
  return source.replace('__AXIA_VERSION__', hash.digest('hex').slice(0, 12)).replace('__AXIA_ASSETS__', JSON.stringify(assets));
}

/** Write the publishable site to `outDir` (replacing what was there). `runAt` lets an open app spot newer results. */
export function writeSite(outDir, html, { runAt = null } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html);
  writeFileSync(join(outDir, 'manifest.webmanifest'), JSON.stringify(MANIFEST, null, 2));
  writeFileSync(join(outDir, 'sw.js'), serviceWorker());
  writeFileSync(join(outDir, 'version.json'), JSON.stringify({ runAt }));
  writeFileSync(join(outDir, '_headers'), HEADERS);
  writeFileSync(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  for (const icon of ICONS) copyFileSync(join(ASSETS, icon), join(outDir, icon));
  mkdirSync(join(outDir, 'fonts'));
  for (const font of FONTS) copyFileSync(join(ASSETS, 'fonts', font), join(outDir, 'fonts', font));
}

export function buildSite(view, outDir, { minScore, demo = false }) {
  writeSite(outDir, renderSite(siteData(view, { minScore, demo })), { runAt: view.summary.runAt });
}

/** Published in place of the dashboard if it ever turns out to be public: no data at all. */
export function placeholderHtml(host) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Axia</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#F3F5F8;color:#131821;display:grid;place-items:center;min-height:100vh;padding:0 16px}main{max-width:34rem}h1{font-size:22px}</style></head>
<body><main><img src="icon.svg" width="44" height="44" alt="Axia"><h1>This dashboard is not protected yet</h1><p>Axia found that <b>${host.replace(/[<>&"]/g, '')}</b> opened without a login, so it published this page instead of your data.</p><p>Add a Cloudflare Access application for this address, then run the workflow again. See docs/setup.md in the Axia repository.</p></main></body></html>`;
}
