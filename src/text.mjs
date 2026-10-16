// Small text helpers shared by the sources, the scorer and the renderers.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML job description → readable plain text (keeps paragraph and bullet breaks). */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // Greenhouse double-encodes: the HTML itself arrives entity-escaped.
  if (/&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const normalize = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Share of distinct words two texts have in common, from 0 to 1. Two copies of one job ad score
 * close to 1; different jobs from the same employer, which share its boilerplate, stay far below.
 */
export function similarity(a, b) {
  const words = (s) => new Set(normalize(s).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 2));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Escape text for a GitHub-flavoured Markdown table cell. */
export function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

/** YYYY-MM-DD in the given IANA time zone. */
export function isoDate(date = new Date(), timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Best-effort parse of whatever date shape a job board returns → YYYY-MM-DD or null. */
export function toDay(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A role's key as a URL-safe id, used for dashboard links (#id) from messages. */
export function jobId(key) {
  return String(key).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
