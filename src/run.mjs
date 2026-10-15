// The whole daily job in one pass:
//   read every company's job board → keep titles/locations you want →
//   score new roles against your resume → tell you about new good matches →
//   write the memory, the GitHub page and the dashboard site.
//
//   axia run              normal daily run
//   axia run --dry-run    read + filter + keyword-score only; writes and sends nothing
//   axia run --no-notify  everything except sending messages
//   axia run --company Stripe --company "Example Bank"   only these companies
//   axia run --rescore    re-score every open role with AI (respects the per-run cap)

import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as http from './http.mjs';
import { mapLimit } from './http.mjs';
import { ROOT, ConfigError, loadSettings, loadCompanies, loadResume, loadCriteria } from './config.mjs';
import { makeFilters } from './filter.mjs';
import { loadState, saveState, closeAndPrune, STATE_VERSION } from './state.mjs';
import { makeScorer, keywordScore, resumeHash } from './score.mjs';
import { renderMarkdown } from './render.mjs';
import { buildSite } from './site.mjs';
import { notifyMinScore, seedNotified, trackProblems, planMessages, deliver, applyDelivery } from './notify.mjs';
import { isoDate, normalize } from './text.mjs';

const KEYWORD_DETAIL_BUDGET = 150; // detail fetches for keyword scoring when AI is off

// `scorerOverrides` lets tests stand in for the Claude API client or the `claude` CLI.
export async function run(argv = process.argv.slice(2), env = process.env, { dir = ROOT, now = new Date(), log = console.log, scorerOverrides = {} } = {}) {
  const { values: args } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'no-notify': { type: 'boolean', default: false },
      rescore: { type: 'boolean', default: false },
      company: { type: 'string', multiple: true, default: [] },
      'max-ai': { type: 'string' },
    },
  });
  const dryRun = args['dry-run'];

  const settings = loadSettings(dir);
  const companies = loadCompanies(dir);
  const resume = loadResume(settings, dir);
  const statePath = resolve(dir, 'data/jobs.json');
  const state = loadState(statePath);
  const firstRun = !state.lastRun;
  const today = isoDate(now, settings.report.timezone);
  const runAt = now.toISOString();
  const filters = makeFilters(settings);
  const criteria = loadCriteria(settings, dir);
  const hash = resumeHash(resume, criteria);
  const ctx = { http, today };

  const wanted = new Set(args.company.map((c) => c.toLowerCase()));
  const selected = companies.filter((c) => c.enabled && (wanted.size === 0 || wanted.has(c.name.toLowerCase())));
  if (wanted.size && selected.length === 0) throw new ConfigError(`No company in companies.yml matches ${args.company.join(', ')}`);

  // ── 1. Read every board ───────────────────────────────────────────────────
  const boards = selected.flatMap((company) => company.boards.map((board) => ({ company: company.name, board })));
  const reads = await mapLimit(boards, 4, async ({ company, board }) => {
    if (!board.source) return { company, url: board.url, status: 'manual', jobs: [] };
    const t0 = Date.now();
    try {
      const jobs = await board.source.list(board.params, ctx);
      log(`  ✓ ${company.padEnd(32)} ${String(jobs.length).padStart(5)} open roles  (${board.source.type}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return { company, url: board.url, source: board.source.type, status: 'ok', jobs, board };
    } catch (err) {
      log(`  ✗ ${company.padEnd(32)} could not read: ${err.message}`);
      return { company, url: board.url, source: board.source.type, status: 'failed', error: err.message, jobs: [] };
    }
  });

  // A company counts as read only if all its boards were; otherwise its roles are never marked closed today.
  const okCompanies = new Set(selected.map((c) => c.name).filter((name) => reads.filter((r) => r.company === name).every((r) => r.status !== 'failed')));

  // ── 2. Keep the titles you want (one entry per role, even if on two boards) ─
  const listedKeys = new Set();
  const candidates = new Map();
  for (const read of reads) {
    for (const job of read.jobs) {
      const key = `${read.board.source.type}:${read.board.params.scope}:${job.id}`;
      listedKeys.add(key);
      if (candidates.has(key)) continue;
      const t = filters.title(job.title);
      if (t.ok) candidates.set(key, { key, company: read.company, board: read.board, job, titleMatch: t.matched, listedLocation: job.location });
    }
  }

  // ── 3. New roles listed without a location ("3 Locations") → read the posting ─
  const unknownLoc = [...candidates.values()].filter((c) => !c.job.location && !state.jobs[c.key] && !state.skipped[c.key]?.location && c.board.source.detail);
  await mapLimit(unknownLoc, 4, (c) => enrich(c, ctx));

  // ── 4. Keep the places you want; merge into memory ─────────────────────────
  // Settings may have changed since the last run: first drop remembered roles that no longer pass.
  for (const job of Object.values(state.jobs)) {
    const where = filters.location(job.location);
    if (!filters.title(job.title).ok || !where.ok) {
      if (filters.title(job.title).ok) state.skipped[job.key] = { company: job.company, title: job.title, location: job.location, reason: where.reason };
      delete state.jobs[job.key];
    }
  }
  // The same title posted several times in the same place (some boards do this) is one role to you.
  const signature = (company, title, location) => `${company}|${normalize(title)}|${normalize(location)}`;
  const openBySignature = new Map(Object.values(state.jobs).filter((j) => j.status === 'open').map((j) => [signature(j.company, j.title, j.location), j.key]));

  const newKeys = new Set();
  let duplicates = 0;
  for (const c of candidates.values()) {
    const existing = state.jobs[c.key];
    const location = c.job.location ?? existing?.location ?? state.skipped[c.key]?.location ?? null;
    const where = filters.location(location);
    if (!where.ok) {
      // Only remember the ones whose location took a posting read to learn; the rest are re-checked for free.
      if (!c.listedLocation) state.skipped[c.key] = { company: c.company, title: c.job.title, location, reason: where.reason };
      delete state.jobs[c.key];
      continue;
    }
    delete state.skipped[c.key];
    if (existing) {
      Object.assign(existing, { title: c.job.title, url: c.job.url, location, status: 'open', titleMatch: c.titleMatch });
      if (!existing.postedAt && c.job.postedAt) existing.postedAt = c.job.postedAt;
      delete existing.closedOn;
      delete existing.closedReason;
      continue;
    }
    const sig = signature(c.company, c.job.title, location);
    const twin = openBySignature.get(sig);
    if (twin && listedKeys.has(twin)) {
      duplicates++;
      candidates.delete(c.key);
      continue;
    }
    if (twin) {
      // The posting we remembered is gone but its duplicate is still listed: the role
      // carries on under the duplicate's id, with its score and history.
      const job = state.jobs[twin];
      delete state.jobs[twin];
      state.jobs[c.key] = Object.assign(job, { key: c.key, title: c.job.title, url: c.job.url, location, status: 'open', titleMatch: c.titleMatch });
      openBySignature.set(sig, c.key);
      continue;
    }
    openBySignature.set(sig, c.key);
    state.jobs[c.key] = {
      key: c.key,
      company: c.company,
      title: c.job.title,
      location,
      url: c.job.url,
      postedAt: c.job.postedAt ?? null,
      firstSeen: today,
      firstSeenRun: runAt,
      status: 'open',
      titleMatch: c.titleMatch,
      score: null,
    };
    newKeys.add(c.key);
  }
  const openBefore = new Set(Object.values(state.jobs).filter((j) => j.status === 'open').map((j) => j.key));
  const watched = new Set(companies.filter((c) => c.enabled).map((c) => c.name));
  closeAndPrune(state, { seenKeys: listedKeys, okCompanies, watched, today });
  const closedToday = [...openBefore].filter((k) => state.jobs[k]?.status === 'closed');

  // Coming from a version that sent a daily digest: the good matches scored before
  // today were in it. Done before scoring, so a role first scored today is still sent.
  const minScore = notifyMinScore(settings, env, log);
  if (state.version < STATE_VERSION) {
    if (!firstRun) {
      const seeded = seedNotified(state, minScore, today);
      if (seeded) log(`Upgraded memory: ${seeded} good match(es) you were already told about will not be sent again.`);
    }
    state.version = STATE_VERSION;
  }

  // ── 5. Score ──────────────────────────────────────────────────────────────
  const open = Object.values(state.jobs).filter((j) => j.status === 'open');
  const aiScorer = dryRun ? null : makeScorer({ env, settings, resume, criteria, ...scorerOverrides });
  const ai = { enabled: Boolean(aiScorer), engine: aiScorer?.engine ?? null, model: aiScorer?.model ?? null, scored: 0, failed: 0, stoppedBecause: null, pending: 0 };

  // Spend the daily AI budget on the most promising roles first: new before
  // re-scores, then by a free estimate from the title (your skill words in it
  // count: "Payment Gateways" beats "Credit Policy"), then newest posting.
  const promise = (j) => j.score?.value ?? keywordScore({ ...j, description: j.title }, settings, j.titleMatch).value;
  const needsAi = open
    .filter((j) => candidates.has(j.key)) // can only read the description of roles listed today
    .filter((j) => args.rescore || !j.score || j.score.scorer !== 'ai' || j.score.resumeHash !== hash)
    .sort((a, b) => rank(a) - rank(b) || promise(b) - promise(a) || String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')));
  const budget = Number(args['max-ai'] ?? settings.scoring.max_ai_scores_per_run);
  const aiQueue = aiScorer ? needsAi.slice(0, budget) : [];
  const keywordQueue = aiScorer ? [] : open.filter((j) => !j.score && candidates.has(j.key)).slice(0, KEYWORD_DETAIL_BUDGET);

  await mapLimit([...aiQueue, ...keywordQueue], 4, (j) => enrich(candidates.get(j.key), ctx));

  if (aiQueue.length) {
    log(`\nScoring ${aiQueue.length} role(s) with ${aiScorer.engine}, model ${aiScorer.model}…`);
    const { scores, failed, stoppedBecause } = await aiScorer.scoreAll(
      aiQueue.map((job) => ({ ...job, description: candidates.get(job.key).job.description })),
      { log },
    );
    for (const job of aiQueue) {
      const s = scores.get(job.key);
      if (s) job.score = { ...s, resumeHash: hash, scoredOn: today };
    }
    Object.assign(ai, { scored: scores.size, failed, stoppedBecause });
  }
  for (const job of open) {
    if (!job.score) {
      const c = candidates.get(job.key);
      job.score = { ...keywordScore({ ...job, description: c?.job.description }, settings, job.titleMatch), scoredOn: today };
    }
  }
  ai.pending = open.filter((j) => j.score?.scorer !== 'ai').length;

  // ── 6. Report ─────────────────────────────────────────────────────────────
  const summary = {
    runAt,
    today,
    firstRun,
    partial: wanted.size > 0,
    companies: reads.map(({ company, url, source, status, error, jobs }) => ({ company, url, source: source ?? null, status, error: error ?? null, listed: jobs.length, lastReadOk: state.companies[company]?.lastReadOk ?? null })),
    counts: {
      listed: reads.reduce((n, r) => n + r.jobs.length, 0),
      open: open.length,
      new: newKeys.size,
      closedToday: closedToday.length,
      duplicates,
    },
    ai,
    newKeys: [...newKeys],
  };
  state.lastRun = { ...summary, newKeys: undefined };
  trackProblems(state, summary, today);


  log(
    `\n${summary.counts.listed} roles read · ${summary.counts.open} match your titles and locations · ${summary.counts.new} new · ${summary.counts.closedToday} closed today` +
      (ai.enabled ? ` · AI scored ${ai.scored}${ai.failed ? `, ${ai.failed} failed` : ''}${ai.pending ? `, ${ai.pending} waiting` : ''}` : ' · AI scoring off (keyword estimates)'),
  );
  if (ai.stoppedBecause) log(`AI scoring stopped early: ${ai.stoppedBecause}`);

  let delivery = [];
  let messages = [];
  if (!dryRun && !args['no-notify']) {
    messages = planMessages({ state, summary, settings, minScore, today });
    delivery = await deliver(messages, env, { log });
    applyDelivery(state, messages, delivery, today);
  }

  const view = { state, summary, settings };
  if (!dryRun) {
    saveState(statePath, state);
    mkdirSync(resolve(dir, 'dashboard'), { recursive: true });
    writeFileSync(resolve(dir, 'dashboard/README.md'), renderMarkdown(view));
    buildSite(view, resolve(dir, '.axia/site'), { minScore });
  }

  const readable = reads.filter((r) => r.status !== 'manual');
  const allFailed = readable.length > 0 && readable.every((r) => r.status === 'failed');
  // A message that reached no channel at all is a failure (it is retried tomorrow).
  const undelivered = messages.filter((m) => delivery.some((d) => d.kind === m.kind) && !delivery.some((d) => d.kind === m.kind && d.ok));
  const reason = allFailed ? 'No company job board could be read.' : undelivered.length ? `Could not deliver: ${undelivered.map((m) => m.subject).join('; ')}` : null;
  return { summary, messages, delivery, reason, exitCode: reason ? 1 : 0 };
}

// New roles first, then roles with only a keyword estimate, then stale AI scores.
function rank(job) {
  if (!job.score) return 0;
  if (job.score.scorer !== 'ai') return 1;
  return 2;
}

async function enrich(c, ctx) {
  if (!c || c.job.description || c.enriched || !c.board.source.detail) return;
  c.enriched = true;
  try {
    const d = await c.board.source.detail(c.board.params, c.job, ctx);
    c.job.description = d.description || c.job.description;
    if (!c.job.location && d.location) c.job.location = d.location;
    if (!c.job.postedAt && d.postedAt) c.job.postedAt = d.postedAt;
  } catch {
    // The posting may have just closed, or the board refused this one read.
    // Scoring falls back to title + location; nothing else depends on it.
  }
}
