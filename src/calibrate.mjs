// Score the roles you have already judged (calibration/roles.yml) with the
// current resume + criteria.md, and show where the AI disagrees with you.
// Re-run after editing criteria.md, before trusting the change.
//
//   axia calibrate --dir <your settings folder>                     (uses the same provider as your daily run)
//   AXIA_SCORER=claude-code axia calibrate --dir <your folder>       (uses your logged-in Claude Code)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ROOT, loadSettings, loadResume, loadCriteria } from './config.mjs';
import { makeScorer } from './score.mjs';

export async function calibrate({ dir = ROOT, env = process.env, log = console.log, scorerOverrides = {} } = {}) {
  const settings = loadSettings(dir);
  const scorer = makeScorer({ env, settings, resume: loadResume(settings, dir), criteria: loadCriteria(settings, dir), ...scorerOverrides });
  if (!scorer) throw new Error('No AI provider: set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or OPENROUTER_API_KEY (or AXIA_SCORER=claude-code where Claude Code is logged in).');

  const roles = parse(readFileSync(resolve(dir, 'calibration/roles.yml'), 'utf8'));
  const jobs = roles.map((r, i) => ({
    key: `cal:${i}`,
    company: r.company,
    title: r.title,
    location: r.location,
    description: readFileSync(resolve(dir, 'calibration', r.file), 'utf8'),
  }));

  log(`Scoring ${jobs.length} calibration roles with ${scorer.engine}, model ${scorer.model}…\n`);
  const { scores, stoppedBecause } = await scorer.scoreAll(jobs, { log });
  if (stoppedBecause) throw new Error(`Scoring stopped: ${stoppedBecause}`);

  const good = settings.report.good_match;
  const rows = roles.map((r, i) => {
    const s = scores.get(`cal:${i}`);
    const yours = Math.round(r.your_score * 20); // 1-5 → 0-100
    const ai = s?.value ?? null;
    const agrees = ai === null ? false : r.decision === 'Apply' ? ai >= good : ai < good;
    return { title: `${r.company} — ${r.title}`, decision: r.decision, yours, ai, agrees, summary: s?.summary ?? '(not scored)', gaps: s?.gaps ?? [] };
  });

  for (const r of rows) {
    log(`${r.agrees ? '✓' : '✗'} ${String(r.ai ?? '–').padStart(3)}  (you: ${r.decision} ${r.yours})  ${r.title}`);
    if (!r.agrees) log(`        ${r.summary}\n        gaps: ${r.gaps.join('; ')}`);
  }
  const scored = rows.filter((r) => r.ai !== null);
  const meanGap = scored.reduce((n, r) => n + Math.abs(r.ai - r.yours), 0) / Math.max(1, scored.length);
  const applyMin = Math.min(...rows.filter((r) => r.decision === 'Apply' && r.ai !== null).map((r) => r.ai));
  const skipMax = Math.max(...rows.filter((r) => r.decision === 'Skip' && r.ai !== null).map((r) => r.ai));
  log(`\nAgreement: ${rows.filter((r) => r.agrees).length}/${rows.length} on Apply (≥${good}) vs Skip · average distance from your score: ${meanGap.toFixed(0)} points`);
  if (Number.isFinite(skipMax)) log(`Every Apply above every Skip: ${applyMin > skipMax ? 'yes' : 'no'} (lowest Apply ${applyMin}, highest Skip ${skipMax})`);
  return rows;
}
