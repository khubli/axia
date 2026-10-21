// A role's level against yours: a step up, the same level, or a step down.
//
// Titles mislead across employers: one bank's Vice President is another's Director, and a payments
// company's Vice President leads a whole organisation. So the model judges each role from your levels
// guide (levels.md: your level and what it is called at the companies you track) and from the scope
// the posting describes, in the same request that scores the role. It is a label beside the score,
// not part of it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { truncate } from './text.mjs';

export const LEVELS = ['up', 'same', 'down', 'unclear'];

// Bump when LEVEL_RULES change in a way that should re-label roles already on the dashboard.
const PROMPT_VERSION = 1;

export const LEVEL_FIELD = {
  type: 'object',
  description: "The job's level compared with the candidate's current level",
  properties: {
    vs: { type: 'string', enum: LEVELS, description: 'up: above the candidate\'s level; same: the same level; down: below it; unclear: the posting gives nothing to go on' },
    note: { type: 'string', description: "At most 12 words: the equivalent on the candidate's current ladder, and the deciding signal when the title alone doesn't show it" },
  },
  required: ['vs', 'note'],
  additionalProperties: false,
};

export const LEVEL_RULES = `- level: compare the job's level with the candidate's current level (their current title and employer in the resume), using the levels guide when there is one. The same title means different things at different employers, so go by that employer's ladder and by the scope the posting describes (years of experience asked, team or organisation size, who it reports to, regional or global remit, stated pay), not by the title words alone. vs is up, same, down, or unclear when neither the title nor the posting settles it; never guess. note names the equivalent on the candidate's current ladder in a few words (for example "≈ Executive Director at <current employer>; leads 3 teams"). Decide the level separately from the score: it is a label shown beside it, and it does not move the score.`;

/** The model's level answer, or null when it is missing or malformed (older answers have none). */
export function cleanLevel(level) {
  if (!level || !LEVELS.includes(level.vs)) return null;
  const note = truncate(String(level.note ?? '').replace(/\s+/g, ' ').trim(), 100);
  return { vs: level.vs, ...(note ? { note } : {}) };
}

/** Your levels guide (settings.yml → scoring.levels). Optional: without it the model goes by your resume alone. */
export function loadLevels(settings, dir) {
  const file = settings.scoring.levels;
  if (!file) return '';
  const path = resolve(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

/** Which version of your guide (and of these rules) a level was judged with. A change re-labels roles; it never re-scores them. */
export const levelsRev = (levels) => createHash('sha256').update(`${PROMPT_VERSION}\n${levels}`).digest('hex').slice(0, 8);

/** The level as a catch-up field (catchup.mjs): roles scored before levels existed, or before your guide last changed. */
export function levelField(levels) {
  return { name: 'level', schema: LEVEL_FIELD, rules: LEVEL_RULES, guide: levels ? `<levels>\n${levels}\n</levels>` : '', clean: (out) => cleanLevel(out), rev: levelsRev(levels), example: '{"vs":"same","note":""}' };
}
