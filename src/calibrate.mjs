// Score the roles you have judged with the current resume + criteria.md, and show where the AI disagrees with you.
// Judged roles come from two places:
//   calibration/roles.yml  roles you wrote up by hand (a 1-5 score and Apply or Skip, with the posting saved as a file)
//   data/feedback.json     your calls on the dashboard (Applied or Shortlist = Apply, Not for me = Skip), saved by each run
// Re-run after editing criteria.md, before trusting the change.
//
//   axia calibrate --dir <your settings folder>                     (uses the same provider as your daily run)
//   AXIA_SCORER=claude-code axia calibrate --dir <your folder>       (uses your logged-in Claude Code)

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ROOT, loadSettings, loadResume, loadCriteria } from './config.mjs';
import { makeScorer, PARTS } from './score.mjs';
import { loadFeedback, decisionOf, LABEL } from './feedback.mjs';

/** A judged role agrees with a score when Apply scored a good match, or Skip scored below one. */
export const agrees = (decision, score, good) => (score === null || score === undefined ? false : decision === 'Apply' ? score >= good : score < good);

/**
 * The good-match line from 1 to 100 that the most judged roles agree with. A tie keeps the line nearest
 * today's. null with no scored role.
 */
export function bestCutoff(rows, good) {
  const scored = rows.filter((r) => r.ai !== null && r.ai !== undefined);
  if (!scored.length) return null;
  let best = null;
  for (let c = 1; c <= 100; c++) {
    const agree = scored.filter((r) => agrees(r.decision, r.ai, c)).length;
    if (!best || agree > best.agree || (agree === best.agree && Math.abs(c - good) < Math.abs(best.cutoff - good))) best = { cutoff: c, agree, of: scored.length };
  }
  return best;
}

/** How spread out scores are: how many different values, and how often the most common one came up. */
export function scoreSpread(values) {
  const v = values.filter((x) => x !== null && x !== undefined);
  if (!v.length) return null;
  const counts = new Map();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  const [top, topCount] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return { distinct: counts.size, of: v.length, top, topCount };
}

/**
 * Every judged role with its posting text: yours from calibration/roles.yml first, then your dashboard calls,
 * most recent first (at most `maxCalls`). Calls whose posting text was never saved are left out.
 */
export function judgedRoles({ dir, feedback = loadFeedback(dir), maxCalls = Infinity }) {
  const out = [];
  const file = resolve(dir, 'calibration/roles.yml');
  if (existsSync(file)) {
    for (const [i, r] of (parse(readFileSync(file, 'utf8')) ?? []).entries()) {
      out.push({
        key: `cal:${i}`,
        source: 'yours',
        company: r.company,
        title: r.title,
        location: r.location,
        description: readFileSync(resolve(dir, 'calibration', r.file), 'utf8'),
        decision: r.decision,
        call: r.decision,
        reason: r.reason ?? '',
        yourScore: Math.round(r.your_score * 20), // 1-5 → 0-100
        score: null,
      });
    }
  }
  const calls = Object.entries(feedback.roles)
    .filter(([, r]) => r.description)
    .sort((a, b) => String(b[1].at ?? '').localeCompare(String(a[1].at ?? '')))
    .slice(0, maxCalls);
  for (const [key, r] of calls) {
    out.push({
      key: `fb:${key}`,
      source: 'dashboard',
      company: r.company,
      title: r.title,
      location: r.location,
      description: r.description,
      decision: decisionOf(r.verdict),
      call: LABEL[r.verdict],
      reason: r.reason ?? '',
      yourScore: null,
      score: r.score ?? null,
    });
  }
  return out;
}

export async function calibrate({ dir = ROOT, env = process.env, log = console.log, scorerOverrides = {} } = {}) {
  const settings = loadSettings(dir);
  const scorer = makeScorer({ env, settings, resume: loadResume(settings, dir), criteria: loadCriteria(settings, dir), ...scorerOverrides });
  if (!scorer) throw new Error('No AI provider: set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or OPENROUTER_API_KEY (or AXIA_SCORER=claude-code where Claude Code is logged in).');

  const roles = judgedRoles({ dir });
  if (roles.length === 0) throw new Error('No judged roles yet: mark roles on the dashboard (Applied, Shortlist, Not for me), or list some in calibration/roles.yml.');
  log(`Scoring ${roles.length} judged roles with ${scorer.engine}, model ${scorer.model}…\n`);
  const { scores, stoppedBecause } = await scorer.scoreAll(roles, { log });
  if (stoppedBecause) throw new Error(`Scoring stopped: ${stoppedBecause}`);

  const good = settings.report.good_match;
  const rows = roles.map((r) => {
    const s = scores.get(r.key);
    const ai = s?.value ?? null;
    const before = r.score?.scorer === 'ai' ? r.score.value : null;
    return { title: `${r.company} — ${r.title}`, source: r.source, decision: r.decision, call: r.call, yours: r.yourScore, ai, before, parts: s?.parts ?? null, hardStop: s?.hardStop === true, agrees: agrees(r.decision, ai, good), summary: s?.summary ?? '(not scored)', gaps: s?.gaps ?? [] };
  });

  const partsText = (r) => (r.parts ? `  [${PARTS.map((k) => `${k} ${r.parts[k]}`).join(' · ')}${r.hardStop ? ' · hard stop' : ''}]` : '');
  for (const r of rows) {
    log(`${r.agrees ? '✓' : '✗'} ${String(r.ai ?? '–').padStart(3)}  (you: ${r.call}${r.yours !== null ? ` ${r.yours}` : ''}${r.before !== null ? `; scored ${r.before} before` : ''})  ${r.title}${partsText(r)}`);
    if (!r.agrees) log(`        ${r.summary}\n        gaps: ${r.gaps.join('; ')}`);
  }
  log('');
  for (const [source, label] of [['yours', 'calibration/roles.yml'], ['dashboard', 'your dashboard calls']]) {
    const part = rows.filter((r) => r.source === source);
    if (part.length) log(`Agreement, ${label}: ${part.filter((r) => r.agrees).length}/${part.length}`);
  }
  log(`Agreement in all: ${rows.filter((r) => r.agrees).length}/${rows.length} on Apply (≥${good}) vs Skip`);
  const withYours = rows.filter((r) => r.ai !== null && r.yours !== null);
  if (withYours.length) log(`Average distance from your 1-5 scores (calibration/roles.yml): ${(withYours.reduce((n, r) => n + Math.abs(r.ai - r.yours), 0) / withYours.length).toFixed(0)} points`);
  const applyMin = Math.min(...rows.filter((r) => r.decision === 'Apply' && r.ai !== null).map((r) => r.ai));
  const skipMax = Math.max(...rows.filter((r) => r.decision === 'Skip' && r.ai !== null).map((r) => r.ai));
  if (Number.isFinite(skipMax) && Number.isFinite(applyMin)) log(`Every Apply above every Skip: ${applyMin > skipMax ? 'yes' : 'no'} (lowest Apply ${applyMin}, highest Skip ${skipMax})`);
  const best = bestCutoff(rows, good);
  if (best) log(`The good-match line that agrees most with your calls: ${best.cutoff} (${best.agree}/${best.of}; today's ${good}: ${rows.filter((r) => r.agrees).length}/${rows.length})${best.cutoff === good ? '' : '. To use it, set report.good_match (and notify.min_score) in settings.yml'}`);
  const spread = scoreSpread(rows.map((r) => r.ai));
  if (spread) log(`Spread: ${spread.distinct} different scores among ${spread.of}; the most common, ${spread.top}, was given ${spread.topCount} time(s)`);
  return rows;
}
