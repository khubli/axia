// Messages are for things worth interrupting you for; the dashboard is for everything else.
// At most one message per run, with up to three parts:
//   matches  — a role's first AI score reaches your threshold. Each role is sent once, ever.
//   problems — a company unreadable for 3 days, or AI scoring failing two runs running. Once per streak.
//   weekly   — a short check-in on your chosen weekday (sent silently), so silence never hides a broken run.
// A broken run sends its own alert from the workflow (sendAlert).
// Telegram and/or email, whichever has credentials. Missing credentials mean "not configured", never a crash.

import nodemailer from 'nodemailer';
import { daysBetween } from './state.mjs';
import { escapeHtml, truncate, jobId, decodeEntities } from './text.mjs';
import { citiesOf } from './site.mjs';
import { gapsView } from './gaps.mjs';
import { effortLine } from './heat.mjs';

const MAX_ITEMS = 8;
const UNREAD_ALERT_DAYS = 2; // first failure + 2 more days = the third day in a row
const AI_ALERT_DAYS = 1; // failing on two runs in a row

/** Your alert threshold: the NOTIFY_MIN_SCORE variable if set, else notify.min_score in settings.yml. */
export function notifyMinScore(settings, env = {}, log = console.log) {
  const raw = env.NOTIFY_MIN_SCORE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return settings.notify.min_score;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 100) return n;
  log(`NOTIFY_MIN_SCORE is "${raw}", not a whole number from 0 to 100; using ${settings.notify.min_score} from settings.yml.`);
  return settings.notify.min_score;
}

const plural = (n, one, many = `${one}es`) => `${n} ${n === 1 ? one : many}`;

const isMatch = (job, min) => job.status === 'open' && job.score?.scorer === 'ai' && job.score.value >= min;

/**
 * Upgrading from a version that sent a daily digest: you have already seen
 * today's good matches there, so they are not sent again as new.
 */
export function seedNotified(state, minScore, today) {
  let n = 0;
  for (const job of Object.values(state.jobs)) {
    if (isMatch(job, minScore) && !job.notifiedOn) (job.notifiedOn = today), n++;
  }
  return n;
}

/** Update state.problems from today's run. Returns nothing; planMessages reads it. */
export function trackProblems(state, summary, today) {
  const current = {};
  const byCompany = new Map();
  for (const c of summary.companies) {
    if (c.status !== 'failed') continue;
    if (!byCompany.has(c.company)) byCompany.set(c.company, c);
  }
  for (const [company, c] of byCompany) current[`read:${company}`] = { kind: 'read', company, detail: truncate(c.error ?? 'unknown error', 120) };
  if (summary.ai.stoppedBecause) current.ai = { kind: 'ai', detail: truncate(summary.ai.stoppedBecause, 200) };
  if (summary.partial) {
    // A run limited to some companies says nothing about the others: only add, never clear.
    for (const [key, p] of Object.entries(current)) state.problems[key] = { ...p, since: state.problems[key]?.since ?? today, lastSeen: today, notifiedOn: state.problems[key]?.notifiedOn ?? null };
    return;
  }
  for (const key of Object.keys(state.problems)) if (!current[key]) delete state.problems[key];
  for (const [key, p] of Object.entries(current)) {
    const prev = state.problems[key];
    state.problems[key] = { ...p, since: prev?.since ?? today, lastSeen: today, notifiedOn: prev?.notifiedOn ?? null };
  }
}

const weekdayOf = (day) => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${day}T12:00:00Z`).getUTCDay()];

const cityOf = (location) => citiesOf(location).join(', ') || null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Shorten at a word boundary, so a message never ends mid-word. */
export function clip(text, n) {
  const s = String(text ?? '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const at = s[n - 1] === ' ' ? cut.length : cut.lastIndexOf(' '); // the cut may already end on a whole word
  return `${(at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

// "This is a strong match: a payments VP role…" → "A payments VP role…": the message already says it's a match.
export function tidySummary(text) {
  const t = String(text ?? '').trim().replace(/^(this is|this looks like|it is|this role is)\s+(an?\s+)?[\w\s-]{0,24}?\b(match|fit)\b\s*[:,.;–—-]\s*/i, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const TELEGRAM_LIMIT = 4000;

/**
 * Decide what to send today: at most ONE message per run, with up to three parts
 * (new good matches, problems, the weekly note). Pure: reads state, changes nothing.
 * @returns {Array<{kind: 'digest', parts: string[], subject: string, html: string, silent: boolean, keys: string[], problemKeys: string[], weekly: boolean}>}
 */
export function planMessages({ state, summary, settings, minScore, today, heat = null }) {
  const dash = settings.dashboard.url;
  const a = (href, text) => `<a href="${escapeHtml(href)}">${text}</a>`;
  const open = Object.values(state.jobs).filter((j) => j.status === 'open');
  const { good_match: good, show_from: floor } = settings.report;

  // ── New good matches ──
  const matches = open.filter((j) => isMatch(j, minScore) && !j.notifiedOn).sort((x, y) => y.score.value - x.score.value);
  const item = (j) => {
    const title = escapeHtml(clip(j.title, 110));
    const level = { up: 'Step up', same: 'Same level', down: 'Step down' }[j.score.level?.vs];
    const meta = [j.company, cityOf(j.location), j.postedAt ? `posted ${dayLabel(j.postedAt)}` : null, level].filter(Boolean).join(' · ');
    const gap = j.score.gaps?.[0];
    return [
      `<b>${j.score.value}</b> · ${dash ? a(`${dash}/#${jobId(j.key)}`, title) : a(j.url, title)}`,
      escapeHtml(meta),
      escapeHtml(clip(tidySummary(j.score.summary), 200)),
      gap ? `<i>Watch: ${escapeHtml(clip(gap, 110))}</i>` : null,
      dash ? a(j.url, 'Posting ↗') : null,
    ].filter(Boolean).join('\n');
  };

  // ── Problems worth your attention ──
  const due = Object.entries(state.problems).filter(([, p]) => !p.notifiedOn && daysBetween(p.since, today) >= (p.kind === 'ai' ? AI_ALERT_DAYS : UNREAD_ALERT_DAYS));
  const unreadable = due.filter(([, p]) => p.kind === 'read').map(([, p]) => p);
  const aiProblem = due.find(([, p]) => p.kind === 'ai')?.[1];
  // Bounded whatever happens: beyond a few companies, one line names them all, so the
  // section always fits in the message and every problem marked as sent was really shown.
  const problemLines = [
    ...(unreadable.length <= 3
      ? unreadable.map((p) => `⚠️ <b>${escapeHtml(p.company)}</b> unreadable for ${daysBetween(p.since, today) + 1} days (${escapeHtml(truncate(p.detail, 90))}). Its roles stay listed; they close after 7 days without a read.`)
      : [`⚠️ <b>${unreadable.length} companies</b> unreadable for 3 days or more: ${escapeHtml(clip(unreadable.map((p) => p.company).join(', '), 700))}. Their roles stay listed; they close after 7 days without a read.`]),
    ...(aiProblem ? [`⚠️ <b>AI scoring</b> failed on two runs in a row (${escapeHtml(truncate(aiProblem.detail, 120))}). New roles show title estimates meanwhile. Check your AI provider's key or credit; for a Claude subscription, an expired token is renewed with <code>claude setup-token</code> and the <code>CLAUDE_CODE_OAUTH_TOKEN</code> secret.`] : []),
  ];

  // ── Weekly note ──
  const weeklyDue = Boolean(settings.notify.weekly && weekdayOf(today) === settings.notify.weekly && state.lastWeekly !== today);
  let weeklyLines = [];
  if (weeklyDue) {
    const within = (d) => d && daysBetween(d, today) < 7;
    const ai = open.filter((j) => j.score?.scorer === 'ai');
    const companies = new Map();
    for (const c of summary.companies) {
      const prev = companies.get(c.company);
      companies.set(c.company, !prev ? c.status : prev === 'failed' || c.status === 'failed' ? 'failed' : prev);
    }
    const statuses = [...companies.values()];
    const read = statuses.filter((x) => x === 'ok').length;
    const manual = statuses.filter((x) => x === 'manual').length;
    const all = Object.values(state.jobs);
    const problems = Object.values(state.problems);
    const waiting = open.length - ai.length;
    const gaps = gapsView(state, settings);
    weeklyLines = [
      `${problems.length ? '⚠️' : '✓'} ${read} of ${companies.size} companies read today${manual ? `, ${manual} by hand` : ''}${problems.length ? ` · ${plural(problems.length, 'open problem', 'open problems')}` : ''}`,
      `New this week: ${plural(all.filter((j) => within(j.firstSeen)).length, 'role', 'roles')} · ${plural(all.filter((j) => within(j.notifiedOn)).length, 'good match')} · ${all.filter((j) => j.status === 'closed' && within(j.closedOn)).length} closed`,
      `Open now: ${plural(ai.filter((j) => j.score.value >= good).length, 'good match')} (${good}+) · ${ai.filter((j) => j.score.value >= floor && j.score.value < good).length} worth a look · ${open.length} in all`,
      summary.ai.enabled ? (waiting ? `${waiting} waiting for an AI score` : 'Every open role has an AI score') : 'AI scoring is off: scores are title estimates',
      ...(gaps?.themes.length ? [`Gap that comes up most in your ${gaps.min}–${gaps.max} roles: ${gaps.themes[0].theme} (${gaps.themes[0].keys.length} of ${gaps.total})`] : []),
      ...(effortLine(heat) ? [effortLine(heat)] : []),
    ].map(escapeHtml);
  }

  if (!matches.length && !due.length && !weeklyDue) return [];

  const totalGood = open.filter((j) => isMatch(j, minScore)).length;
  const headline = matches.length ? plural(matches.length, 'new good match') : due.length ? 'needs your attention' : `weekly check-in, ${dayLabel(today)}`;
  const compose = (shown) => {
    const sections = [`<b>Axia</b> · ${escapeHtml(headline)}`];
    if (matches.length) {
      sections.push(...matches.slice(0, shown).map(item));
      if (matches.length > shown) sections.push(`…and ${matches.length - shown} more on the dashboard.`);
    }
    if (due.length) sections.push((matches.length ? '<b>Needs attention</b>\n' : '') + problemLines.join('\n'));
    if (weeklyDue) sections.push((matches.length || due.length ? `<b>Weekly check-in</b>\n` : '') + weeklyLines.join('\n'));
    const footer = [matches.length ? `${plural(totalGood, 'good match')} open` : null, dash ? a(dash, 'Open Axia') : null].filter(Boolean).join(' · ');
    if (footer) sections.push(footer);
    return sections.join('\n\n');
  };
  // Shorten the list, never the problems or the weekly note, to stay inside Telegram's limit.
  let shown = Math.min(matches.length, MAX_ITEMS);
  let html = compose(shown);
  while (html.length > TELEGRAM_LIMIT && shown > 1) html = compose(--shown);

  const parts = [matches.length && 'matches', due.length && 'problems', weeklyDue && 'weekly'].filter(Boolean);
  const subject = matches.length
    ? `Axia: ${plural(matches.length, 'new good match')} (${matches.slice(0, 3).map((j) => j.score.value).join(', ')}${matches.length > 3 ? '…' : ''})`
    : due.length
      ? 'Axia needs your attention'
      : `Axia weekly check-in: ${plural(open.filter((j) => j.score?.scorer === 'ai' && j.score.value >= good).length, 'good match')} open`;
  return [{
    kind: 'digest',
    parts,
    subject,
    html,
    // The weekly note alone arrives without a sound; matches and problems are worth one.
    silent: parts.length === 1 && parts[0] === 'weekly',
    keys: matches.map((j) => j.key),
    problemKeys: due.map(([k]) => k),
    weekly: weeklyDue,
  }];
}

/** Record what was delivered, so nothing is sent twice. */
export function applyDelivery(state, messages, results, today) {
  for (const m of messages) {
    if (!results.some((r) => r.kind === m.kind && r.ok)) continue;
    for (const key of m.keys ?? []) if (state.jobs[key]) state.jobs[key].notifiedOn = today;
    for (const key of m.problemKeys ?? []) if (state.problems[key]) state.problems[key].notifiedOn = today;
    if (m.weekly) state.lastWeekly = today;
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

export function channels(env) {
  const list = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) list.push(['telegram', sendTelegram]);
  if (env.SMTP_USER && env.SMTP_PASSWORD) list.push(['email', sendEmail]);
  return list;
}

/** @returns {Array<{kind: string, channel: string, ok: boolean, error?: string}>} */
export async function deliver(messages, env, { log = console.log } = {}) {
  if (messages.length === 0) {
    log('Nothing to send today.');
    return [];
  }
  const list = channels(env);
  if (list.length === 0) {
    log(`${messages.length} message(s) not sent: no delivery configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, and/or SMTP_USER + SMTP_PASSWORD).`);
    return [];
  }
  const results = [];
  for (const m of messages) {
    for (const [channel, send] of list) {
      try {
        await send(m, env);
        log(`Sent "${m.subject}" by ${channel}.`);
        results.push({ kind: m.kind, channel, ok: true });
      } catch (err) {
        log(`Could not send "${m.subject}" by ${channel}: ${err.message}`);
        results.push({ kind: m.kind, channel, ok: false, error: err.message });
      }
    }
  }
  return results;
}

/** Telegram allows 4096 characters; cut at an item boundary, never inside a tag. */
export function fitTelegram(html, limit = 4000) {
  if (html.length <= limit) return html;
  const parts = html.split('\n\n');
  while (parts.length > 2 && parts.join('\n\n').length > limit - 40) parts.splice(parts.length - 2, 1);
  const text = parts.join('\n\n');
  return text.length <= limit ? text : truncate(text.replace(/<[^>]+>/g, ''), limit);
}

async function sendTelegram(m, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: fitTelegram(m.html), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, disable_notification: Boolean(m.silent) }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram: ${body.description ?? `HTTP ${res.status}`}`);
}

/** The Telegram markup as plain text: links become "text (url)". */
export function plainText(html) {
  return decodeEntities(html.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_, href, text) => `${text} (${decodeEntities(href)})`).replace(/<[^>]+>/g, ''));
}

function mailTransport(env) {
  const port = Number(env.SMTP_PORT || 465);
  return nodemailer.createTransport({ host: env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } });
}

async function sendEmail(m, env) {
  await mailTransport(env).sendMail({
    from: `Axia <${env.SMTP_USER}>`,
    to: env.EMAIL_TO || env.SMTP_USER,
    subject: m.subject,
    text: plainText(m.html),
    html: `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#131821;max-width:640px">${m.html.replace(/\n/g, '<br>')}</div>`,
  });
}

/**
 * A one-off alert (a broken run, an unprotected dashboard). Best effort on every configured channel.
 * @param {{title: string, detail?: string, link?: string}} alert
 */
export async function sendAlert({ title, detail = '', link = '', linkText = 'Open the log' }, env, { log = console.log } = {}) {
  const html = [`<b>Axia</b> · ${escapeHtml(title)}`, detail ? escapeHtml(detail) : null, link ? `<a href="${escapeHtml(link)}">${escapeHtml(linkText)}</a>` : null].filter(Boolean).join('\n');
  const m = { kind: 'alert', subject: `Axia: ${title}`, html };
  const list = channels(env);
  if (list.length === 0) log(`Alert not sent (no delivery configured): ${title} ${detail}`);
  for (const [channel, send] of list) {
    try {
      await send(m, env);
      log(`Alert sent by ${channel}.`);
    } catch (err) {
      log(`${channel} alert failed: ${err.message}`);
    }
  }
}
