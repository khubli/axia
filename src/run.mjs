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
import { loadState, saveState, closeAndPrune, daysBetween, STATE_VERSION } from './state.mjs';
import { secondLook } from './secondlook.mjs';
import { makeScorer, keywordScore, resumeHash } from './score.mjs';
import { renderMarkdown } from './render.mjs';
import { buildSite } from './site.mjs';
import { notifyMinScore, seedNotified, trackProblems, planMessages, deliver, applyDelivery } from './notify.mjs';
import { isoDate, normalize, similarity } from './text.mjs';
import { loadFeedback, saveFeedback, pullFeedback, applyFeedback, snapshotFeedback } from './feedback.mjs';
import { loadMoonshots } from './moonshots.mjs';
import { loadLayoffs } from './layoffs.mjs';
import { loadTailor, saveTailor, pullTailor, applyTailor, snapshotTailor, loadDone, tailorEnabled } from './tailor.mjs';
import { rollUpGaps } from './gaps.mjs';
import { snapshot, runChanges, addHistory, briefLine } from './changes.mjs';
import { loadLevels, levelField } from './levels.mjs';
import { catchUp, catchUpQueue } from './catchup.mjs';
import { loadPayGuide, payField, dropImplausiblePay } from './pay.mjs';
import { recordListed, scanSignals, loadSignals, computeHeat } from './heat.mjs';

const KEYWORD_DETAIL_BUDGET = 150; // detail fetches for keyword scoring when AI is off
const SECOND_LOOK_MAX = 1500; // new titles the second look asks about per run; the rest wait for the next run
const TITLE_CHECK_KEEP_DAYS = 45; // a title not listed for this long is forgotten (and asked about again if it returns)
const NEAR_MISS_TITLES = 3000; // titles left out, listed on the Companies tab (the page stays small)
const NEAR_MISS_PLACES = 40; // places outside your list, most roles first
const SAME_JOB = 0.9; // description similarity above which two lookalike postings are one job (copies measure ~1, different jobs ~0.2-0.5)

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
      'second-look-preview': { type: 'boolean', default: false },
    },
  });
  const dryRun = args['dry-run'];
  // A cap on AI scores for this run only (the action's max-ai-scores input); settings.yml keeps the usual one.
  const maxAi = args['max-ai'] === undefined || args['max-ai'].trim() === '' ? undefined : args['max-ai'].trim();
  if (maxAi !== undefined && !/^\d+$/.test(maxAi)) throw new ConfigError(`The AI scores for this run (--max-ai, or the action's max-ai-scores) must be a whole number such as 100, not "${maxAi}".`);

  const settings = loadSettings(dir);
  const companies = loadCompanies(dir);
  const resume = loadResume(settings, dir);
  const statePath = resolve(dir, 'data/jobs.json');
  const state = loadState(statePath);
  const before = snapshot(state); // for the brief of what this run changed
  const firstRun = !state.lastRun;
  const today = isoDate(now, settings.report.timezone);
  const runAt = now.toISOString();
  const filters = makeFilters(settings);
  const criteria = loadCriteria(settings, dir);
  const hash = resumeHash(resume, criteria);
  // Your levels guide is kept out of the hash: editing it re-labels roles (step 5c), never re-scores them.
  const levels = loadLevels(settings, dir);
  // Your pay table is kept out too: only each role's own employer's lines go into its request.
  const payGuide = loadPayGuide(settings, dir);
  const catchUpFields = [levelField(levels), payField(payGuide)];
  const ctx = { http, today };
  const preview = args['second-look-preview'];
  const aiScorer = dryRun ? null : makeScorer({ env, settings, resume, criteria, levels, payGuide, ...scorerOverrides });
  if (preview && !aiScorer?.ask) throw new ConfigError('The second-look preview needs an AI provider (see docs/setup.md, step 3).');

  // A title passes your title words, or the second look let it through on an earlier run.
  const secondLookOn = settings.titles.second_look !== false;
  const titleKey = (company, title) => `${company}|${normalize(title)}`;
  const passesTitle = (company, title) => {
    const t = filters.title(title);
    return t.ok || (secondLookOn && !t.excluded && state.titleChecks[titleKey(company, title)]?.keep === true);
  };

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
  const rejected = new Map(); // in your places (or place not listed), title has none of your words
  const excluded = new Map(); // in your places, title has one of your excluded words (kept only for the near-misses list)
  for (const read of reads) {
    for (const job of read.jobs) {
      const key = `${read.board.source.type}:${read.board.params.scope}:${job.id}`;
      listedKeys.add(key);
      if (candidates.has(key) || rejected.has(key) || excluded.has(key)) continue;
      const t = filters.title(job.title);
      if (t.ok) candidates.set(key, { key, company: read.company, board: read.board, job, titleMatch: t.matched, listedLocation: job.location });
      else if (!job.location || filters.location(job.location).ok) {
        if (t.excluded) excluded.set(key, { key, company: read.company, job, word: t.word });
        else rejected.set(key, { key, company: read.company, board: read.board, job });
      }
    }
  }

  // ── 2b. Second look: titles your words missed, judged by the model ─────────
  // It can only let roles in. Each employer + title is asked about once (again if your resume
  // or criteria change); what it lets through is read and scored in full like any other role.
  const second = { titles: 0, checked: 0, letThrough: 0, roles: 0, stoppedBecause: null };
  if (secondLookOn) {
    const titles = new Map();
    for (const r of rejected.values()) {
      const id = titleKey(r.company, r.job.title);
      if (!titles.has(id)) titles.set(id, { id, company: r.company, title: r.job.title });
      if (state.titleChecks[id]) state.titleChecks[id].seen = today;
    }
    second.titles = titles.size;
    // Unless scoring.rescore_on_edit is all, a resume or criteria edit keeps the verdicts already given; only new titles are asked.
    const asked = (t) => state.titleChecks[t.id] && (settings.scoring.rescore_on_edit !== 'all' || state.titleChecks[t.id].hash === hash);
    const ask = [...titles.values()].filter((t) => preview || !asked(t)).slice(0, preview ? Infinity : SECOND_LOOK_MAX);
    if (aiScorer?.ask && ask.length) {
      log(`\nSecond look: ${ask.length} title(s) your title words rejected, asked of ${aiScorer.engine}…`);
      const { verdicts, stoppedBecause } = await secondLook(aiScorer, ask, { resume, criteria, include: settings.titles.include, exclude: settings.titles.exclude, log });
      for (const [id, v] of verdicts) state.titleChecks[id] = { keep: v.keep, ...(v.why ? { why: v.why } : {}), hash, seen: today };
      Object.assign(second, { checked: verdicts.size, stoppedBecause });
    }
    for (const r of rejected.values()) {
      const v = state.titleChecks[titleKey(r.company, r.job.title)];
      if (!v?.keep) continue;
      candidates.set(r.key, { key: r.key, company: r.company, board: r.board, job: r.job, titleMatch: null, secondLook: v.why ?? 'judged in scope', listedLocation: r.job.location });
      second.roles++;
    }
    second.letThrough = [...titles.keys()].filter((id) => state.titleChecks[id]?.keep).length;
    for (const [id, v] of Object.entries(state.titleChecks)) if (daysBetween(v.seen, today) > TITLE_CHECK_KEEP_DAYS) delete state.titleChecks[id];
    if (second.checked || second.roles) log(`Second look: ${second.letThrough} of ${second.titles} rejected title(s) let through (${second.roles} role(s))${second.stoppedBecause ? `; stopped early: ${second.stoppedBecause}` : ''}.`);
  }
  if (preview) return previewSecondLook({ titles: rejected, state, titleKey, second, log });

  // ── 3. New roles listed without a location ("3 Locations") → read the posting ─
  const unknownLoc = [...candidates.values()].filter((c) => !c.job.location && !state.jobs[c.key] && !state.skipped[c.key]?.location && c.board.source.detail);
  await mapLimit(unknownLoc, 4, (c) => enrich(c, ctx));

  // ── 4. Keep the places you want; merge into memory ─────────────────────────
  // Settings may have changed since the last run: first drop remembered roles that no longer pass.
  for (const job of Object.values(state.jobs)) {
    const where = filters.location(job.location);
    const titleOk = passesTitle(job.company, job.title);
    if (!titleOk || !where.ok) {
      if (titleOk) state.skipped[job.key] = { company: job.company, title: job.title, location: job.location, reason: where.reason };
      delete state.jobs[job.key];
    }
  }
  // One job posted more than once (some boards do this) is one role to you: same title, same place
  // and the same description. Postings that share a title and place but describe different jobs
  // (one bank's three "Engineering Manager" openings in one city) are separate roles, and when the
  // descriptions can't be compared both are kept: a duplicate costs a glance, a hidden role an opportunity.
  const signature = (company, title, location) => `${company}|${normalize(title)}|${normalize(location)}`;
  const openBySignature = new Map();
  for (const j of Object.values(state.jobs)) {
    if (j.status !== 'open') continue;
    const sig = signature(j.company, j.title, j.location);
    openBySignature.set(sig, [...(openBySignature.get(sig) ?? []), j.key]);
  }
  const sameJob = async (a, b) => {
    if (!a || !b) return false;
    await Promise.all([enrich(a, ctx), enrich(b, ctx)]);
    return Boolean(a.job.description && b.job.description) && similarity(a.job.description, b.job.description) >= SAME_JOB;
  };

  const newKeys = new Set();
  const placeMisses = []; // a title you want, in a place outside your list
  let duplicates = 0;
  for (const c of candidates.values()) {
    const existing = state.jobs[c.key];
    const location = c.job.location ?? existing?.location ?? state.skipped[c.key]?.location ?? null;
    const where = filters.location(location);
    if (!where.ok) {
      placeMisses.push({ company: c.company, title: c.job.title, location });
      // Only remember the ones whose location took a posting read to learn; the rest are re-checked for free.
      if (!c.listedLocation) state.skipped[c.key] = { company: c.company, title: c.job.title, location, reason: where.reason };
      delete state.jobs[c.key];
      continue;
    }
    delete state.skipped[c.key];
    if (existing) {
      Object.assign(existing, { title: c.job.title, url: c.job.url, location, status: 'open', titleMatch: c.titleMatch });
      if (c.secondLook) existing.secondLook = c.secondLook;
      else delete existing.secondLook;
      if (!existing.postedAt && c.job.postedAt) existing.postedAt = c.job.postedAt;
      delete existing.closedOn;
      delete existing.closedReason;
      continue;
    }
    const sig = signature(c.company, c.job.title, location);
    const lookalikes = openBySignature.get(sig) ?? [];
    // A copy found on an earlier run stays a copy while the kept posting is listed.
    const original = lookalikes.find((k) => state.jobs[k]?.copies?.includes(c.key));
    if (original && listedKeys.has(original)) {
      duplicates++;
      candidates.delete(c.key);
      continue;
    }
    if (original) {
      // The kept posting was taken down but a copy is still listed: the role carries on under the
      // copy's id, with its score and history.
      const job = state.jobs[original];
      delete state.jobs[original];
      const copies = job.copies.filter((k) => k !== c.key);
      state.jobs[c.key] = Object.assign(job, { key: c.key, title: c.job.title, url: c.job.url, location, status: 'open', titleMatch: c.titleMatch, copies });
      if (!copies.length) delete state.jobs[c.key].copies;
      lookalikes[lookalikes.indexOf(original)] = c.key;
      continue;
    }
    let copyOf = null;
    for (const k of lookalikes) {
      if (listedKeys.has(k) && (await sameJob(candidates.get(k), c))) {
        copyOf = k;
        break;
      }
    }
    if (copyOf) {
      state.jobs[copyOf].copies = [...(state.jobs[copyOf].copies ?? []), c.key];
      duplicates++;
      candidates.delete(c.key);
      continue;
    }
    openBySignature.set(sig, [...lookalikes, c.key]);
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
      ...(c.secondLook ? { secondLook: c.secondLook } : {}),
      score: null,
    };
    newKeys.add(c.key);
  }
  const openBefore = new Set(Object.values(state.jobs).filter((j) => j.status === 'open').map((j) => j.key));
  const watched = new Set(companies.filter((c) => c.enabled).map((c) => c.name));
  closeAndPrune(state, { seenKeys: listedKeys, okCompanies, watched, today });
  // For hiring heat: each company's postings today (all titles), for the four-week trend.
  if (settings.heat.enabled) recordListed(state, reads, today, watched);
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

  // ── 4b. Your calls from the dashboard's buttons ────────────────────────────
  // Copied into data/feedback.json with the posting text, so they outlive the role.
  const feedback = loadFeedback(dir);
  const pulled = dryRun ? null : await pullFeedback({ env, settings, log });
  const fb = applyFeedback(feedback, pulled, state);
  if (fb.added || fb.changed || fb.cleared) log(`Your calls from the dashboard: ${fb.added} new, ${fb.changed} changed, ${fb.cleared} cleared.`);
  await mapLimit(fb.needText.map((k) => candidates.get(k)).filter(Boolean), 4, (c) => enrich(c, ctx));

  // ── 4c. Tailor requests from the dashboard (off unless settings.yml turns them on) ──
  // Queued in data/tailor.json for your own tailoring tool, with the posting text; never scored.
  const moonshots = loadMoonshots(dir, settings, { log });
  const tailor = tailorEnabled(settings) ? loadTailor(dir) : null;
  let tr = null;
  if (tailor) {
    const pulledTailor = dryRun ? null : await pullTailor({ env, settings, log });
    tr = applyTailor(tailor, pulledTailor, { state, moonshots: moonshots?.report?.roles ?? [], done: loadDone(dir, settings, { log }) });
    if (tr.added || tr.cleared || tr.finished) log(`Tailor requests: ${tr.added} new, ${tr.cleared} cancelled, ${tr.finished} done.`);
    const waiting = Object.values(tailor.requests).filter((r) => r.status === 'requested').length;
    if (waiting) log(`Tailor requests waiting for your tool: ${waiting}.`);
    await mapLimit(tr.needText.filter((k) => !fb.needText.includes(k)).map((k) => candidates.get(k)).filter(Boolean), 4, (c) => enrich(c, ctx));
  }

  // ── 5. Score ──────────────────────────────────────────────────────────────
  const open = Object.values(state.jobs).filter((j) => j.status === 'open');
  const ai = { enabled: Boolean(aiScorer), engine: aiScorer?.engine ?? null, model: aiScorer?.model ?? null, scored: 0, failed: 0, stoppedBecause: null, pending: 0 };

  // Spend the daily AI budget on the most promising roles first: roles you
  // shortlisted while they waited, then new before re-scores, then by a free
  // estimate from the title (your skill words in it count: "Payment Gateways"
  // beats "Credit Policy"), then newest posting. The estimate is worked out
  // again each run, so a settings.yml edit also moves roles already waiting.
  const shortlisted = (j) => (feedback.roles[j.key]?.verdict === 'shortlist' && j.score?.scorer !== 'ai' ? 0 : 1);
  const fromTitle = (j) => keywordScore({ ...j, description: j.title }, settings, j.titleMatch).value;
  const promise = (j) => (j.score?.scorer === 'ai' ? j.score.value : Math.max(j.score?.value ?? 0, fromTitle(j)));
  // What a resume or criteria edit re-scores (scoring.rescore_on_edit): all open roles, none (only roles
  // scored from now on use the edit), or roles scoring that number or more plus those you marked Applied or Shortlist.
  const onEdit = settings.scoring.rescore_on_edit;
  const worthRescore = (j) => onEdit === 'all' || (onEdit !== 'none' && (j.score.value >= onEdit || ['applied', 'shortlist'].includes(feedback.roles[j.key]?.verdict)));
  const needsAi = open
    .filter((j) => candidates.has(j.key)) // can only read the description of roles listed today
    .filter((j) => args.rescore || !j.score || j.score.scorer !== 'ai' || (j.score.resumeHash !== hash && worthRescore(j)))
    .sort((a, b) => shortlisted(a) - shortlisted(b) || rank(a) - rank(b) || promise(b) - promise(a) || String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')));
  const budget = maxAi !== undefined ? Number(maxAi) : settings.scoring.max_ai_scores_per_run;
  if (maxAi !== undefined && aiScorer) log(`This run scores up to ${budget} role(s) with AI (settings.yml: ${settings.scoring.max_ai_scores_per_run}).`);
  const aiQueue = aiScorer ? needsAi.slice(0, budget) : [];
  const scoredKeys = new Set();
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
      if (!s) continue;
      for (const f of catchUpFields) if (s[f.name]) s[f.name] = { ...s[f.name], rev: f.rev };
      job.score = { ...s, resumeHash: hash, scoredOn: today };
      scoredKeys.add(job.key);
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

  // ── 5c. Catch-up: the level and pay on roles scored before they existed (or before levels.md or pay.yml changed) ──
  // Only roles worth showing, a few dozen per run, without re-scoring them.
  if (aiScorer?.ask && !ai.stoppedBecause) {
    const calls = feedback.roles ?? {};
    const queue = catchUpQueue({
      open,
      fields: catchUpFields,
      listedToday: (key) => candidates.has(key),
      scoredToday: new Set(aiQueue.map((j) => j.key)),
      showFrom: settings.report.show_from,
      kept: (key) => ['applied', 'shortlist'].includes(calls[key]?.verdict),
    });
    // Each batch is asked only for the fields its roles are missing (catchup.mjs); named here for the log.
    const missing = catchUpFields.filter((f) => queue.some((j) => j.score?.[f.name]?.rev !== f.rev)).map((f) => f.name);
    if (queue.length) {
      await mapLimit(queue, 4, (j) => enrich(candidates.get(j.key), ctx));
      log(`\nCatch-up: ${missing.join(' and ')} for ${queue.length} role(s) scored before it was asked for…`);
      const { answers, failed, stoppedBecause } = await catchUp({
        scorer: aiScorer,
        jobs: queue.map((job) => ({ ...job, description: candidates.get(job.key).job.description })),
        resume,
        fields: catchUpFields,
        batchSize: Math.max(1, Number(settings.scoring.batch_size) || 8),
        log,
      });
      for (const job of queue) if (answers.has(job.key)) Object.assign(job.score, answers.get(job.key));
      ai.caughtUp = answers.size;
      log(`Catch-up: ${answers.size} filled in${failed ? `, ${failed} failed` : ''}${stoppedBecause ? `; stopped early: ${stoppedBecause}` : ''}.`);
    }
  }
  // Pay saved before a bad-estimate check existed (or before estimate_floor was set) is checked again here, free.
  const payDropped = dropImplausiblePay(Object.values(state.jobs), payGuide);
  if (payDropped) log(`Pay: ${payDropped} AI estimate(s) that can't be right now show no pay.`);
  snapshotFeedback(feedback, state, (key) => candidates.get(key)?.job.description);
  if (tailor) snapshotTailor(tailor, (key) => candidates.get(key)?.job.description ?? feedback.roles[key]?.description);

  // ── 5b. Gaps that keep coming up: once a week, when your close calls have changed ──
  if (aiScorer) await rollUpGaps({ state, settings, scorer: aiScorer, today, log });

  // ── 5d. Hiring heat: once a week, this week's hiring news (and X posts) checked by one model call ──
  if (aiScorer && !wanted.size) await scanSignals({ state, settings, companies, scorer: aiScorer, env, http, today, now, log });

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
    secondLook: second,
    ai,
    feedback: { judged: Object.keys(feedback.roles).length, read: pulled !== null },
    tailor: tailor ? { waiting: Object.values(tailor.requests).filter((r) => r.status === 'requested').length } : null,
    newKeys: [...newKeys],
    nearMisses: nearMisses({ rejected, excluded, placeMisses, titleChecks: state.titleChecks, titleKey, secondLookOn }),
  };
  // The near-misses list is for the dashboard only: kept out of memory so jobs.json doesn't churn every day.
  state.lastRun = { ...summary, newKeys: undefined, nearMisses: undefined };
  trackProblems(state, summary, today);


  log(
    `\n${summary.counts.listed} roles read · ${summary.counts.open} match your titles and locations · ${summary.counts.new} new · ${summary.counts.closedToday} closed today` +
      (ai.enabled ? ` · AI scored ${ai.scored}${ai.failed ? `, ${ai.failed} failed` : ''}${ai.pending ? `, ${ai.pending} waiting` : ''}` : ' · AI scoring off (keyword estimates)'),
  );
  if (ai.stoppedBecause) log(`AI scoring stopped early: ${ai.stoppedBecause}`);

  // Recent layoffs (layoffs.yml, kept by hand): a label only, read fresh each run so old news drops off.
  const companyNames = companies.map((c) => c.name);
  const layoffs = loadLayoffs(dir, settings, { companies: companyNames, today, log });
  // Hiring heat per company: free, from this memory, your signals.yml and the weekly scan's signals.
  const heat = computeHeat({ state, settings, companies, layoffs: layoffs ?? {}, signals: loadSignals(dir, settings, { companies: companyNames, today, log }), today });

  let delivery = [];
  let messages = [];
  if (!dryRun && !args['no-notify']) {
    messages = planMessages({ state, summary, settings, minScore, today, heat });
    delivery = await deliver(messages, env, { log });
    applyDelivery(state, messages, delivery, today);
  }

  // ── 7. What changed, for the brief at the top of the dashboard (no AI involved) ──
  const changes = runChanges({ before, state, summary, settings, newKeys, closedKeys: closedToday, scoredKeys });
  summary.changes = { ...changes, line: briefLine({ changes, state, settings, firstRun, aiPerRun: settings.scoring.max_ai_scores_per_run }) };
  state.lastRun.changes = summary.changes;
  state.history = addHistory(state.history, { summary, changes, state, settings });

  const view = { state, summary, settings, feedback, tailor, moonshots, layoffs, heat };
  if (!dryRun) {
    saveState(statePath, state);
    saveFeedback(dir, feedback);
    if (tailor) saveTailor(dir, tailor);
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

/**
 * What your filters left out this run, for spot checks on the dashboard's Companies tab:
 *   titles — roles in your places whose title has none of your words (and the second look didn't let in),
 *            or one of your excluded words; one entry per employer + title
 *   places — roles with a title you want, in a place outside your list, grouped by place
 */
export function nearMisses({ rejected, excluded, placeMisses, titleChecks, titleKey, secondLookOn }) {
  const titles = new Map();
  const add = (r, why) => {
    const id = titleKey(r.company, r.job.title);
    if (!titles.has(id)) titles.set(id, { company: r.company, title: String(r.job.title ?? '').replace(/\s+/g, ' ').trim(), url: r.job.url ?? null, roles: 0, ...why });
    titles.get(id).roles++;
  };
  for (const r of rejected.values()) {
    const v = titleChecks[titleKey(r.company, r.job.title)];
    if (secondLookOn && v?.keep) continue; // let in: it is on the dashboard
    add(r, { why: !secondLookOn ? 'words' : v ? 'second-look' : 'unchecked' });
  }
  for (const r of excluded.values()) add(r, { why: 'excluded', word: r.word });
  const order = { 'second-look': 0, unchecked: 0, words: 0, excluded: 1 };
  const titleList = [...titles.values()].sort((a, b) => a.company.localeCompare(b.company) || order[a.why] - order[b.why] || a.title.localeCompare(b.title));

  const places = new Map();
  for (const m of placeMisses) {
    const place = String(m.location ?? '').replace(/\s+/g, ' ').trim() || '(no location given)';
    if (!places.has(place)) places.set(place, { place, roles: 0, example: `${m.title} · ${m.company}` });
    places.get(place).roles++;
  }
  const placeList = [...places.values()].sort((a, b) => b.roles - a.roles || a.place.localeCompare(b.place));

  return {
    titles: titleList.slice(0, NEAR_MISS_TITLES),
    titlesTotal: titleList.length,
    places: placeList.slice(0, NEAR_MISS_PLACES),
    placesTotal: placeList.length,
    placeRoles: placeMisses.length,
  };
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

/** `axia second-look`: what the second look would let through today, from every rejected title. Writes nothing. */
function previewSecondLook({ titles, state, titleKey, second, log }) {
  const byCompany = new Map();
  for (const r of titles.values()) {
    const id = titleKey(r.company, r.job.title);
    const v = state.titleChecks[id];
    if (!byCompany.has(r.company)) byCompany.set(r.company, new Map());
    const list = byCompany.get(r.company);
    if (!list.has(id)) list.set(id, { title: r.job.title, keep: v?.keep === true, why: v?.why ?? '', roles: 0 });
    list.get(id).roles++;
  }
  const all = [...byCompany.values()].flatMap((m) => [...m.values()]);
  const kept = all.filter((t) => t.keep);
  log(`\nSecond look preview: ${all.length} distinct title(s) in your places that your title words reject (${titles.size} role(s)).`);
  log(`It would let through ${kept.length} title(s), ${kept.reduce((n, t) => n + t.roles, 0)} role(s):`);
  for (const [company, list] of byCompany) {
    const k = [...list.values()].filter((t) => t.keep);
    if (!k.length) continue;
    log(`\n  ${company}`);
    for (const t of k.sort((a, b) => a.title.localeCompare(b.title))) log(`    + ${t.title}${t.roles > 1 ? ` (×${t.roles})` : ''} — ${t.why}`);
  }
  log(`\nLeft out: ${all.length - kept.length} title(s):`);
  for (const [company, list] of byCompany) {
    const out = [...list.values()].filter((t) => !t.keep);
    if (out.length) log(`  ${company}: ${out.map((t) => t.title + (t.roles > 1 ? ` (×${t.roles})` : '')).sort().join(' · ')}`);
  }
  if (second.stoppedBecause) log(`\nStopped early: ${second.stoppedBecause}`);
  return { summary: { secondLook: second }, preview: { titles: all.length, letThrough: kept.length }, messages: [], delivery: [], reason: second.stoppedBecause ? `Second look stopped early: ${second.stoppedBecause}` : null, exitCode: second.stoppedBecause ? 1 : 0 };
}
