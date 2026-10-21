// What changed in one run: memory before the run compared with memory after it.
// Plain bookkeeping, no AI request, so the brief costs nothing to write.
//
//   new       roles seen for the first time
//   scored    roles the AI scored for the first time
//   moved     roles re-scored by MOVE_POINTS or more, or into another band
//   closed    roles that closed (no longer listed, board unreadable for a week, company removed)
//   reopened  closed roles listed again
//   notified  good matches sent to you in this run
//   companies boards that broke or came back, companies added or removed
//   pending   roles waiting for an AI score, before and after the run

export const MOVE_POINTS = 10;
export const HISTORY_RUNS = 14;

/** The parts of memory the brief compares, taken before the run changes anything. */
export function snapshot(state) {
  const jobs = {};
  for (const j of Object.values(state.jobs)) {
    jobs[j.key] = { status: j.status, ai: j.score?.scorer === 'ai', value: j.score?.value ?? null, notifiedOn: j.notifiedOn ?? null };
  }
  return {
    runAt: state.lastRun?.runAt ?? null,
    jobs,
    companies: companyStatus(state.lastRun?.companies ?? []),
    pending: state.lastRun?.ai?.pending ?? null,
  };
}

/** One status per company (a company can have several boards): failed if any board failed. */
function companyStatus(reads) {
  const out = {};
  for (const r of reads) {
    if (out[r.company] === 'failed') continue;
    out[r.company] = r.status === 'failed' ? 'failed' : out[r.company] === 'ok' ? 'ok' : r.status;
  }
  return out;
}

const band = (value, settings) => (value >= settings.report.good_match ? 'good' : value >= settings.report.show_from ? 'look' : 'low');

/**
 * @param before    snapshot(state) from the start of the run
 * @param state     memory after scoring and messages
 * @param newKeys   roles first seen in this run
 * @param closedKeys roles closed in this run
 * @param scoredKeys roles the AI scored in this run
 */
export function runChanges({ before, state, summary, settings, newKeys, closedKeys, scoredKeys }) {
  const scored = [];
  const moved = [];
  for (const key of scoredKeys) {
    const j = state.jobs[key];
    if (j?.score?.scorer !== 'ai') continue;
    const was = before.jobs[key];
    if (!was?.ai) scored.push(key);
    else if (Math.abs(j.score.value - was.value) >= MOVE_POINTS || band(j.score.value, settings) !== band(was.value, settings)) moved.push({ key, from: was.value });
  }
  const reopened = [];
  const notified = [];
  for (const j of Object.values(state.jobs)) {
    const was = before.jobs[j.key];
    if (was?.status === 'closed' && j.status === 'open') reopened.push(j.key);
    if (j.notifiedOn && j.notifiedOn !== was?.notifiedOn) notified.push(j.key);
  }

  const now = companyStatus(summary.companies);
  const had = before.companies;
  const known = Object.keys(had).length > 0;
  const companies = {
    // Newly unreadable: it was read last time, or it is new and could not be read at all.
    unreadable: Object.keys(now).filter((c) => now[c] === 'failed' && had[c] !== 'failed'),
    stillUnreadable: Object.keys(now).filter((c) => now[c] === 'failed' && had[c] === 'failed'),
    recovered: Object.keys(now).filter((c) => now[c] === 'ok' && had[c] === 'failed'),
    added: known ? Object.keys(now).filter((c) => !(c in had)) : [],
    removed: known && !summary.partial ? Object.keys(had).filter((c) => !(c in now)) : [],
  };

  return {
    since: before.runAt,
    new: [...newKeys],
    scored,
    moved,
    closed: [...closedKeys],
    reopened,
    notified,
    companies,
    pending: { before: before.pending, now: summary.ai.enabled ? summary.ai.pending : null },
  };
}

/** One line per run, newest first, kept for HISTORY_RUNS runs: how the radar moved night to night. */
export function addHistory(history = [], { summary, changes, state, settings }) {
  const bands = { good: 0, look: 0 };
  for (const key of changes.scored) {
    const b = band(state.jobs[key].score.value, settings);
    if (b in bands) bands[b]++;
  }
  const entry = {
    runAt: summary.runAt,
    today: summary.today,
    ...(summary.partial ? { partial: true } : {}),
    new: changes.new.length,
    closed: changes.closed.length,
    scored: changes.scored.length,
    good: bands.good,
    look: bands.look,
    pending: changes.pending.now,
  };
  return [entry, ...history.filter((h) => h.runAt !== entry.runAt)].slice(0, HISTORY_RUNS);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The brief in one or two plain sentences, from a template:
 * "12 new roles and 5 closed. Claude scored 40 for the first time: 2 good matches and 3 worth a look. 931 still waiting, about 24 nights at 40 a night."
 */
export function briefLine({ changes, state, settings, firstRun = false, aiPerRun }) {
  if (firstRun) return `First run: ${plural(changes.new.length, 'role')} found in your titles and places.`;
  const parts = [];
  const n = changes.new.length;
  const c = changes.closed.length;
  if (n || c) parts.push(n && c ? `${plural(n, 'new role')} and ${c} closed.` : n ? `${plural(n, 'new role')}.` : `${plural(c, 'role')} closed.`);
  if (changes.reopened.length) parts.push(`${plural(changes.reopened.length, 'closed role')} listed again.`);

  const s = changes.scored.length;
  if (s) {
    const bands = { good: 0, look: 0 };
    for (const key of changes.scored) {
      const b = band(state.jobs[key].score.value, settings);
      if (b in bands) bands[b]++;
    }
    const hits = [bands.good && plural(bands.good, 'good match', 'good matches'), bands.look && `${bands.look} worth a look`].filter(Boolean);
    parts.push(`Scored ${plural(s, 'role')} for the first time${hits.length ? `: ${hits.join(' and ')}` : `, none of them ${settings.report.show_from} or more`}.`);
  }
  if (changes.moved.length) parts.push(`${plural(changes.moved.length, 're-scored role')} moved ${MOVE_POINTS}+ points or into another band.`);
  if (changes.notified.length) parts.push(`${plural(changes.notified.length, 'good match', 'good matches')} sent to you.`);

  const { unreadable, recovered } = changes.companies;
  if (unreadable.length) parts.push(`${listNames(unreadable)} could not be read.`);
  if (recovered.length) parts.push(`${listNames(recovered)} ${recovered.length === 1 ? 'is' : 'are'} readable again.`);

  const waiting = changes.pending.now;
  if (waiting) {
    const nights = aiPerRun ? Math.ceil(waiting / aiPerRun) : null;
    parts.push(`${waiting} still waiting for a score${nights ? `, about ${plural(nights, 'night')} at ${aiPerRun} a night` : ''}.`);
  }
  return parts.length ? parts.join(' ') : 'Nothing changed: no new or closed roles, and nothing new scored.';
}

function listNames(names) {
  if (names.length <= 3) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
