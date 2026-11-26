// Job-alert emails: roles a job site emails you about, as one more way in beside the careers
// sites. Today that is LinkedIn's job alerts and its "jobs similar to" emails. Axia never opens
// LinkedIn itself: it reads only those emails, in your own mailbox (mail.mjs, read-only).
//
// Each run reads the emails since the last run and remembers every role in them in
// data/jobs.json (`alerts`). A role then counts as listed, like a role on a careers site,
// until no email has named it for `job_alerts.days` days. An alert has no posting text, so
// the role is scored from its title, employer and place.

import { readMailbox } from './mail.mjs';
import { normalize, citiesOf } from './text.mjs';
import { daysBetween } from './state.mjs';

export const LINKEDIN_SENDERS = ['jobalerts-noreply@linkedin.com', 'jobs-noreply@linkedin.com'];
export const VIA = 'linkedin-alert';
/** Every role from an alert is listed on this pseudo-board, so its key is `linkedin:alert:<LinkedIn job id>`. */
export const ALERT_BOARD = { url: 'https://www.linkedin.com/jobs/', source: { type: 'linkedin' }, params: { scope: 'alert' } };
export const alertKey = (id) => `${ALERT_BOARD.source.type}:${ALERT_BOARD.params.scope}:${id}`;

const OVERLAP_DAYS = 2; // re-read the last two days each run, so a late or slow email is never missed

// Lines in a LinkedIn email that are never a role's title, employer or place.
const NOT_A_FIELD = [
  /:\/\//, /-{5,}/,
  /^your job alert for\b/i, /^jobs similar to\b/i, /^new jobs similar to\b/i, /^your application was sent\b/i,
  /^applied on\b/i, /^now, take these next steps\b/i, /^view similar jobs\b/i, /^see all jobs\b/i, /^top job picks\b/i,
  /^recommended for you\b/i, /^jobs you may be interested in\b/i,
];
// Lines under a role that say something about it, not where it is.
const EXTRA = /\b(connections?|alumni|alum|actively (hiring|recruiting)|apply with resume|easy apply|early applicant|promoted|applicants)\b|^[₹$€£]/i;

/**
 * The roles in one LinkedIn email's plain text: [{ id, title, company, location, url }].
 * Each role is a card of lines (title, employer, place, then notes such as "2 connections")
 * ending in "View job: https://www.linkedin.com/comm/jobs/view/<id>/…". Cards are split by dashed lines.
 */
export function parseLinkedIn(text) {
  const out = [];
  const seen = new Set();
  let card = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const view = line.match(/^View job:\s*(\S+)/i);
    if (view) {
      const id = view[1].match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i)?.[1];
      const fields = card.filter((l) => l && !NOT_A_FIELD.some((re) => re.test(l)));
      card = [];
      if (!id || seen.has(id) || fields.length < 2) continue;
      const [title, company, place] = fields;
      seen.add(id);
      out.push({ id, title, company, location: place && !EXTRA.test(place) ? place : null, url: `https://www.linkedin.com/jobs/view/${id}/` });
      continue;
    }
    if (/^-{5,}/.test(line)) card = [];
    else card.push(line);
  }
  return out;
}

const parserFor = (from) => (/@linkedin\.com$/i.test(String(from ?? '')) ? parseLinkedIn : null);

/** Your settings and secrets for reading alerts, or null when they are off. IMAP_* first, else the SMTP_* email secrets. */
export function alertsConfig(settings, env) {
  const a = settings.job_alerts;
  if (!a?.enabled) return null;
  const user = String(env.IMAP_USER || env.SMTP_USER || '').trim();
  const pass = String(env.IMAP_PASSWORD || env.SMTP_PASSWORD || '').replace(/\s+/g, '');
  return { ...a, user, pass, senders: a.linkedin ? LINKEDIN_SENDERS : [] };
}

const isoDay = (iso) => String(iso ?? '').slice(0, 10);
const minusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

/**
 * Read the new alert emails and update `state.alerts`: { readOn, roles: { [id]: role + firstSeen, lastSeen } }.
 * Roles no email has named for `days` days are forgotten. A mailbox that can't be read leaves the
 * remembered roles as they were (they still close `days` after their last email).
 * @returns {{ on, emails, found, roles: object[], error }}
 */
export async function readAlerts({ settings, env, state, today, log = () => {}, readMail = readMailbox }) {
  const cfg = alertsConfig(settings, env);
  if (!cfg) return { on: false, emails: 0, found: 0, roles: [], error: null };
  const store = (state.alerts ??= { readOn: null, roles: {} });
  store.roles ??= {};
  let emails = 0;
  let found = 0;
  let error = null;
  if (!cfg.user || !cfg.pass) {
    error = 'no mailbox sign-in: add the IMAP_USER and IMAP_PASSWORD secrets (docs/configuration.md#job-alert-emails)';
  } else {
    const since = store.readOn ? minusDays(store.readOn, OVERLAP_DAYS) : minusDays(today, cfg.days);
    try {
      const mail = await readMail({ host: cfg.host, port: cfg.port, user: cfg.user, pass: cfg.pass, mailbox: cfg.mailbox, senders: cfg.senders, since });
      for (const m of mail) {
        const parse = parserFor(m.from);
        if (!parse) continue;
        emails++;
        const day = isoDay(m.date) || today;
        for (const r of parse(m.text)) {
          found++;
          const prev = store.roles[r.id];
          store.roles[r.id] = { ...prev, ...r, firstSeen: prev?.firstSeen && prev.firstSeen < day ? prev.firstSeen : day, lastSeen: prev?.lastSeen && prev.lastSeen > day ? prev.lastSeen : day };
        }
      }
      store.readOn = today;
    } catch (err) {
      error = err.message;
    }
  }
  for (const [id, r] of Object.entries(store.roles)) if (daysBetween(r.lastSeen, today) > cfg.days) delete store.roles[id];
  const roles = Object.values(store.roles);
  if (error) log(`  ✗ ${'Job-alert emails'.padEnd(32)} could not read: ${error}${roles.length ? ` (keeping the ${roles.length} role(s) from earlier emails)` : ''}`);
  else log(`  ✓ ${'Job-alert emails'.padEnd(32)} ${String(roles.length).padStart(5)} roles from the last ${cfg.days} days  (${emails} new email(s) read)`);
  return { on: true, emails, found, roles, error };
}

/** A name compared loosely: no accents, case or punctuation ("Société Générale" is "societe generale"). */
export const fold = (s) => normalize(String(s ?? '').normalize('NFD').replace(/\p{M}+/gu, '')).replace(/[^\p{L}\p{N}& ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Which company in companies.yml an alert's employer is, if any. Either name may carry more words than
 * the other ("Contoso Pay India" and "Contoso Pay"; "Woodgrove" and "Woodgrove Bank"), and spaces may
 * differ ("FabrikamCapital"), as long as the shorter name is 6 letters or more, so "Cred" is never
 * "CreditX". The longest match wins. `strict` allows only the alert's name to be longer (for ignore).
 */
export function trackedCompany(companies, employer, { strict = false } = {}) {
  const e = fold(employer);
  const eTight = e.replace(/ /g, '');
  let best = null;
  let bestLen = 0;
  for (const c of companies) {
    const n = fold(c.name);
    if (!n) continue;
    const nTight = n.replace(/ /g, '');
    const longEnough = Math.min(eTight.length, nTight.length) >= 6;
    const hit = e === n || e.startsWith(`${n} `) || (!strict && longEnough && (n.startsWith(`${e} `) || eTight.startsWith(nTight) || nTight.startsWith(eTight)));
    if (hit && n.length > bestLen) [best, bestLen] = [c, n.length];
  }
  return best;
}

/** Employers you never want roles from (job_alerts.ignore): the same name, or the name followed by more words. */
export function ignored(settings, employer) {
  return trackedCompany((settings.job_alerts?.ignore ?? []).map((name) => ({ name })), employer, { strict: true }) !== null;
}

/** A title compared loosely, to spot the same role on a company's own site. */
export const sameTitle = (a, b) => fold(a) === fold(b);

/**
 * One role per employer and title. Job sites repost a role under a new id every few days, and list one
 * opening once per city, and an email has no posting text to tell two openings apart, so alerts that
 * agree on employer and title are one role, listed in all their cities. Of each group, `prefer(entry)`
 * (higher first) picks the one kept, so a role keeps its id, score and your call; it takes the link of
 * the newest email. A role you made a call on is never folded away.
 * @param {Array<{company: string, role: object}>} entries
 * @returns {{ keep: Array<{company, role}>, copies: Map<string, string> }} copies: folded id → kept id
 */
export function collapseAlertRoles(entries, { prefer = () => 0, called = () => false } = {}) {
  const groups = new Map();
  for (const e of entries) {
    const id = `${fold(e.company)}|${fold(e.role.title)}`;
    groups.set(id, [...(groups.get(id) ?? []), e]);
  }
  const keep = [];
  const copies = new Map();
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => prefer(b.role) - prefer(a.role) || String(a.role.firstSeen ?? '').localeCompare(String(b.role.firstSeen ?? '')) || String(a.role.id).localeCompare(String(b.role.id)));
    const newest = [...group].sort((a, b) => String(b.role.lastSeen ?? '').localeCompare(String(a.role.lastSeen ?? '')) || String(b.role.id).localeCompare(String(a.role.id)))[0];
    const [first, ...rest] = ranked;
    const folded = [first, ...rest.filter((e) => !called(e.role))];
    keep.push({ ...first, role: { ...first.role, url: newest.role.url, location: placesOf(folded.map((e) => e.role.location)) } });
    for (const e of rest) {
      if (called(e.role)) keep.push(e);
      else copies.set(e.role.id, first.role.id);
    }
  }
  return { keep, copies };
}

/**
 * Several places as one location ("Pune, Maharashtra, India; Bengaluru, Karnataka, India"): one per
 * city, in the order given. A place that is only a country ("India") is left out when a city in it is listed.
 */
export function placesOf(locations) {
  const parts = locations.flatMap((l) => String(l ?? '').split(';')).map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const where = citiesOf(p).map(fold).join('+') || fold(p);
    if (seen.has(where)) continue;
    if (!p.includes(',') && parts.some((o) => o.includes(',') && fold(o.split(',').at(-1)) === fold(p))) continue;
    seen.add(where);
    out.push(p);
  }
  return out.join('; ') || null;
}
