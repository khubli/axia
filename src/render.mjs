// The view model shared by every view of the data, and the plain fallback view:
//   dashboard/README.md — GitHub renders it when you open the folder, so the list is
//   readable in your private repo even before (or without) the hosted dashboard (site.mjs).

import { escapeHtml, mdCell, truncate } from './text.mjs';
import { UNREAD_CLOSE_DAYS } from './state.mjs';

export function viewModel({ state, summary, settings }) {
  const newKeys = new Set(summary.newKeys ?? []);
  const open = Object.values(state.jobs)
    .filter((j) => j.status === 'open')
    .map((j) => ({ ...j, isNew: newKeys.has(j.key) }))
    .sort((a, b) => (b.score?.value ?? -1) - (a.score?.value ?? -1) || String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')));
  const { good_match: good, show_from: floor } = settings.report;
  const aiOn = Boolean(summary.ai?.enabled);
  const ranked = aiOn ? open.filter((j) => j.score?.scorer === 'ai') : open;
  // One row per company (a company can have several boards): failed if any board failed.
  const byCompany = new Map();
  for (const c of summary.companies) {
    const prev = byCompany.get(c.company);
    if (!prev) byCompany.set(c.company, { ...c });
    else {
      prev.listed += c.listed;
      if (c.status === 'failed' || prev.status === 'manual') Object.assign(prev, { status: c.status, error: c.error ?? prev.error, url: c.status === 'manual' ? c.url : prev.url });
    }
  }
  const companies = [...byCompany.values()];
  const failed = companies.filter((c) => c.status === 'failed');
  const manual = companies.filter((c) => c.status === 'manual');
  const matchingByCompany = {};
  for (const j of open) matchingByCompany[j.company] = (matchingByCompany[j.company] ?? 0) + 1;
  return {
    open,
    fresh: open.filter((j) => j.isNew),
    // While AI scoring is on, a keyword estimate never counts as a match: it is
    // listed apart until the AI reads the role. Without AI it's all there is.
    best: ranked.filter((j) => (j.score?.value ?? 0) >= good),
    worth: ranked.filter((j) => (j.score?.value ?? 0) >= floor && (j.score?.value ?? 0) < good),
    below: ranked.filter((j) => (j.score?.value ?? 0) < floor),
    waiting: aiOn ? open.filter((j) => j.score?.scorer !== 'ai') : [],
    companies,
    failed,
    manual,
    readLine: `${companies.filter((c) => c.status === 'ok').length} of ${companies.length} companies read${manual.length ? ` (${manual.length} checked by hand)` : ''}`,
    matchingByCompany,
    good,
    floor,
    updated: formatWhen(summary.runAt, settings.report.timezone),
  };
}

export function formatWhen(iso, timeZone) {
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
}

/** What happens to a failed company's roles, in one sentence. */
export function keptNote(c) {
  return c.lastReadOk
    ? `Its roles are kept as they were (last read ${c.lastReadOk}); after ${UNREAD_CLOSE_DAYS} days without a successful read they are closed.`
    : 'Its roles are kept as they were.';
}

export const scoreLabel = (s) => (s ? (s.scorer === 'ai' ? String(s.value) : `≈${s.value}`) : '–');

export function why(job, n = 160) {
  const s = job.score;
  if (!s) return '';
  if (s.scorer === 'ai') return truncate(s.summary, n);
  return truncate([...s.strengths, ...s.gaps].join('; ') || s.summary, n);
}

// ── Markdown (GitHub) ───────────────────────────────────────────────────────

export function renderMarkdown(view) {
  const { summary, settings } = view;
  const v = viewModel(view);
  const lines = [];

  lines.push(`# Axia: open roles`, '');
  if (settings.dashboard.url) lines.push(`**[Open the dashboard](${settings.dashboard.url})** for search, filters and the reasons behind each score. This page is the plain version.`, '');
  const scoredBy = summary.ai.enabled ? ` by ${summary.ai.engine}, model ${summary.ai.model}` : '';
  lines.push(`_Updated ${v.updated}._ Scored against your resume and criteria${scoredBy}; ${legend(settings)}`, '');
  lines.push(
    `**${summary.counts.new} new** · **${v.open.length}** open roles match your titles and locations · **${v.best.length}** good matches (${v.good}+) · ${v.readLine}`,
    '',
  );
  if (summary.changes?.line) lines.push(`**What changed in this run:** ${summary.changes.line}`, '');

  for (const c of v.failed) lines.push(`> ⚠️ **${c.company}** could not be read today (${c.error}). ${keptNote(c)}`, '');
  if (summary.ai.stoppedBecause) lines.push(`> ⚠️ AI scoring stopped early today: ${summary.ai.stoppedBecause}. Affected roles show a keyword estimate (≈).`, '');
  if (!summary.ai.enabled) lines.push(`> ℹ️ AI scoring is off (no Claude token, Anthropic key or OpenRouter key), so scores are keyword estimates (≈). See the setup guide: https://github.com/khubli/axia/blob/main/docs/setup.md`, '');
  else if (summary.ai.pending) lines.push(`> ℹ️ ${summary.ai.pending} role(s) still show a keyword estimate (≈); up to ${settings.scoring.max_ai_scores_per_run} get an AI score each day.`, '');

  lines.push(`## New since the last run (${v.fresh.length})`, '');
  lines.push(v.fresh.length ? table(v.fresh, { why: true }) : '_Nothing new today._', '');

  lines.push(`## Good matches — ${v.good}+ (${v.best.length})`, '');
  lines.push(v.best.length ? table(v.best, { why: true, firstSeen: true }) : '_None yet._', '');

  lines.push(`<details><summary><b>Worth a look — ${v.floor} to ${v.good - 1} (${v.worth.length})</b></summary>`, '');
  lines.push(v.worth.length ? table(v.worth, { why: true, firstSeen: true }) : '_None._', '', '</details>', '');
  if (v.below.length) lines.push(`_${v.below.length} more open role(s) scored below ${v.floor} are not listed here${settings.dashboard.url ? ' (they are on the dashboard)' : ''}._`, '');
  if (v.waiting.length) {
    lines.push(`<details><summary><b>Waiting for an AI score (${v.waiting.length})</b>, shown with a rough keyword estimate (≈)</summary>`, '');
    lines.push(table(v.waiting, { why: true, firstSeen: true }), '', '</details>', '');
  }

  lines.push(`## Companies`, '');
  lines.push('| Company | Today | Open roles on board | Matching you |', '|---|---|--:|--:|');
  for (const c of v.companies) {
    const status = c.status === 'ok' ? '✅ read' : c.status === 'failed' ? `⚠️ failed — ${mdCell(truncate(c.error, 80))}` : `✋ no public feed — [check manually](${c.url})`;
    lines.push(`| ${mdCell(c.company)} | ${status} | ${c.status === 'manual' ? '–' : c.listed} | ${v.matchingByCompany[c.company] ?? 0} |`);
  }
  lines.push('');
  const nm = summary.nearMisses;
  if (nm?.titlesTotal || nm?.placesTotal) {
    lines.push(`_Left out by your filters in this run: ${nm.titlesTotal} title(s) in your places, and ${nm.placeRoles} role(s) with a title you want in a place outside your list${settings.dashboard.url ? ' (listed on the dashboard\'s Companies tab)' : ''}._`, '');
  }
  lines.push(`_Change the companies in \`companies.yml\` and the titles, locations or scoring in \`settings.yml\`._`, '');
  return lines.join('\n');
}

function legend(settings) {
  const { good_match: good, show_from: floor } = settings.report;
  return `${good}+ good match · ${floor}–${good - 1} worth a look · ≈ keyword estimate.`;
}

function table(jobs, { why: withWhy, firstSeen }) {
  const head = ['Score', 'Role', 'Company', 'Location', 'Posted'];
  if (firstSeen) head.push('Found');
  if (withWhy) head.push('Why');
  const rows = [`| ${head.join(' | ')} |`, `|${head.map((h) => (h === 'Score' ? '--:' : '---')).join('|')}|`];
  for (const j of jobs) {
    const cells = [
      j.score?.scorer === 'ai' ? `**${scoreLabel(j.score)}**` : scoreLabel(j.score),
      `[${mdCell(truncate(j.title, 90))}](${j.url})`,
      mdCell(j.company),
      mdCell(truncate(j.location ?? '—', 40)),
      j.postedAt ?? '—',
    ];
    if (firstSeen) cells.push(j.firstSeen);
    if (withWhy) cells.push(mdCell(why(j)));
    rows.push(`| ${cells.join(' | ')} |`);
  }
  return rows.join('\n');
}
