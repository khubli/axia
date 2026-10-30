// Memory between runs: every matching role ever seen, whether it is still
// open, and its score. Plain JSON in git, so history is browsable and a bad
// run can be undone with `git revert`.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CLOSED_KEEP_DAYS = 45;
// A company whose board can't be read is frozen, not closed: a failed read is
// not proof a role closed. But never forever: after this many days without a
// successful read its roles are closed too.
export const UNREAD_CLOSE_DAYS = 7;

// 2: roles remember when you were told about them (notifiedOn); problems and the weekly note are tracked.
export const STATE_VERSION = 2;

export function emptyState() {
  // titleChecks: the second look's verdict per employer + title, so each title is asked about once.
  // gaps: the weekly themes of gaps that keep coming up (gaps.mjs).
  // history: one line per recent run, newest first (changes.mjs).
  // insights: weekly snapshots of what your best-fit roles ask for (insights.mjs).
  return { version: STATE_VERSION, lastRun: null, jobs: {}, skipped: {}, companies: {}, problems: {}, lastWeekly: null, titleChecks: {}, gaps: null, history: [], insights: null };
}

export function loadState(path) {
  if (!existsSync(path)) return emptyState();
  const s = JSON.parse(readFileSync(path, 'utf8'));
  return { ...emptyState(), ...s, version: s.version ?? 1, jobs: s.jobs ?? {}, skipped: s.skipped ?? {}, companies: s.companies ?? {}, problems: s.problems ?? {}, titleChecks: s.titleChecks ?? {}, history: s.history ?? [] };
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  // Sorted keys keep the git diff small and stable from day to day.
  const sorted = { ...state, jobs: sortKeys(state.jobs), skipped: sortKeys(state.skipped), titleChecks: sortKeys(state.titleChecks ?? {}) };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(sorted, null, 1) + '\n');
  renameSync(tmp, path); // never leave a half-written file behind
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/**
 * Decide which open roles are no longer open. A role closes when:
 *   - its company's board was read today and the role is no longer listed;
 *   - its company could not be read for UNREAD_CLOSE_DAYS days in a row;
 *   - its company was removed from companies.yml or paused (enabled: false).
 * Closed roles leave the dashboard and are forgotten after CLOSED_KEEP_DAYS.
 *
 * @param {Set<string>} seenKeys    every role key listed today (before any filter)
 * @param {Set<string>} okCompanies companies whose boards were all read today
 * @param {Set<string>} watched     every enabled company in companies.yml
 */
export function closeAndPrune(state, { seenKeys, okCompanies, watched, today }) {
  for (const name of okCompanies) state.companies[name] = { ...state.companies[name], lastReadOk: today };
  for (const name of Object.keys(state.companies)) if (!watched.has(name)) delete state.companies[name];

  const close = (job, reason) => {
    job.status = 'closed';
    job.closedOn = today;
    job.closedReason = reason;
  };
  for (const job of Object.values(state.jobs)) {
    if (job.status === 'open') {
      const lastOk = state.companies[job.company]?.lastReadOk;
      if (!watched.has(job.company)) close(job, 'company removed or paused in companies.yml');
      else if (okCompanies.has(job.company) && !seenKeys.has(job.key)) close(job, 'no longer listed');
      else if (lastOk && daysBetween(lastOk, today) >= UNREAD_CLOSE_DAYS) close(job, `job board unreadable since ${lastOk}`);
    }
    if (job.status === 'closed' && job.closedOn && daysBetween(job.closedOn, today) > CLOSED_KEEP_DAYS) delete state.jobs[job.key];
  }
  // Out-of-area roles are remembered only while they are still listed.
  for (const [key, s] of Object.entries(state.skipped)) {
    if (!watched.has(s.company) || (okCompanies.has(s.company) && !seenKeys.has(key))) delete state.skipped[key];
  }
}
