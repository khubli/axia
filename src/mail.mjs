// Your own mailbox, read-only, over IMAP (for job-alert emails, alerts.mjs). No library: a few
// IMAP commands over TLS, and just enough MIME to get an email's plain text.
//
// The mailbox is opened with EXAMINE, so nothing is marked read, moved or deleted. Only emails
// from the senders you name are fetched, and only their text is kept.

import tls from 'node:tls';
import { htmlToText } from './text.mjs';

export class MailError extends Error {}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_EMAILS = 200; // per run; the newest are kept

/** An IMAP quoted string. */
const q = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** 2026-11-18 → 18-Nov-2026 (IMAP's date). */
const imapDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}-${MONTHS[m - 1]}-${y}`;
};

/** IMAP's INTERNALDATE (" 5-Nov-2026 05:51:53 +0530") → ISO time, or null. */
export function internalDate(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  const month = m ? MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) : -1;
  if (month < 0) return null;
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return new Date(Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +m[6]) - offset * 60000).toISOString();
}

function defaultConnect({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * A line-and-literal reader over a socket: IMAP sends lines, and some carry `{n}` followed by n raw bytes.
 * Every response is an `{ text, literals }` item: the line with its literals cut out, and the literals' bytes.
 */
function reader(socket, timeoutMs) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let failure = null;
  const pump = () => {
    if (!waiting) return;
    if (failure) {
      const w = waiting;
      waiting = null;
      return w.reject(failure);
    }
    if (waiting.bytes != null) {
      if (buf.length < waiting.bytes) return;
      const out = buf.subarray(0, waiting.bytes);
      buf = buf.subarray(waiting.bytes);
      const w = waiting;
      waiting = null;
      return w.resolve(Buffer.from(out));
    }
    const at = buf.indexOf('\r\n');
    if (at < 0) return;
    const line = buf.subarray(0, at).toString('utf8');
    buf = buf.subarray(at + 2);
    const w = waiting;
    waiting = null;
    w.resolve(line);
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  const fail = (err) => {
    failure ??= err;
    pump();
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new MailError('the mail server closed the connection')));
  socket.setTimeout?.(timeoutMs, () => {
    fail(new MailError(`no answer from the mail server in ${Math.round(timeoutMs / 1000)}s`));
    socket.destroy();
  });
  const next = (bytes) => new Promise((resolve, reject) => {
    waiting = { bytes, resolve, reject };
    pump();
  });
  return {
    async item() {
      let text = '';
      const literals = [];
      for (;;) {
        const line = await next();
        const lit = line.match(/\{(\d+)\}$/);
        if (!lit) return { text: text + line, literals };
        text += line.slice(0, -lit[0].length) + `{${literals.length}}`;
        literals.push(await next(Number(lit[1])));
      }
    },
  };
}

/**
 * Open a session: `command(text)` sends one command and returns its untagged answers.
 * A NO or BAD answer throws a MailError with the server's words.
 */
async function session({ host, port, user, pass, connect, timeoutMs }) {
  const socket = await connect({ host, port });
  const r = reader(socket, timeoutMs);
  const greeting = await r.item();
  if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new MailError(`unexpected greeting from ${host}: ${greeting.text.slice(0, 80)}`);
  let n = 0;
  const command = async (text, { hide = false } = {}) => {
    const tag = `A${++n}`;
    socket.write(`${tag} ${text}\r\n`);
    const untagged = [];
    for (;;) {
      const it = await r.item();
      if (it.text.startsWith(`${tag} `)) {
        const status = it.text.slice(tag.length + 1);
        if (!/^OK/i.test(status)) throw new MailError(`${hide ? text.split(' ')[0] : text.slice(0, 60)}: ${status.replace(/^(NO|BAD)\s*/i, '').slice(0, 160) || status}`);
        return untagged;
      }
      if (it.text.startsWith('*')) untagged.push(it);
    }
  };
  await command(`LOGIN ${q(user)} ${q(pass)}`, { hide: true });
  return {
    command,
    async close() {
      try {
        await command('LOGOUT');
      } catch {
        // the server may hang up first
      }
      socket.end?.();
    },
  };
}

/** The mailbox to read: the one you named, else the one flagged \All (Gmail's All Mail, in any language), else INBOX. */
async function pickMailbox(s, wanted) {
  if (wanted) return wanted;
  const lists = await s.command('LIST "" "*"');
  for (const it of lists) {
    const m = it.text.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i);
    if (!m || !/\\All\b/i.test(m[1])) continue;
    let name = m[2].trim();
    const lit = name.match(/^\{(\d+)\}$/);
    if (lit) name = it.literals[Number(lit[1])].toString('utf8');
    else if (name.startsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    return name;
  }
  return 'INBOX';
}

/**
 * The emails from `senders` received on or after `since` (YYYY-MM-DD), newest last:
 * [{ uid, date (ISO), from, subject, text }]. `connect` stands in for the TLS socket in tests.
 */
export async function readMailbox({ host, port = 993, user, pass, mailbox = '', senders, since, connect = defaultConnect, timeoutMs = 60000 }) {
  if (!senders?.length) return [];
  const s = await session({ host, port, user, pass, connect, timeoutMs });
  try {
    const box = await pickMailbox(s, mailbox);
    await s.command(`EXAMINE ${q(box)}`);
    const from = senders.map((x) => `FROM ${q(x)}`);
    const anyFrom = from.slice(1).reduce((acc, f) => `OR ${acc} ${f}`, from[0]);
    const found = await s.command(`UID SEARCH SINCE ${imapDate(since)} ${anyFrom}`);
    const uids = found.flatMap((it) => (it.text.match(/^\* SEARCH\s*(.*)$/i)?.[1] ?? '').split(/\s+/)).filter((x) => /^\d+$/.test(x)).map(Number);
    const out = [];
    for (const uid of uids.sort((a, b) => a - b).slice(-MAX_EMAILS)) {
      const [it] = (await s.command(`UID FETCH ${uid} (UID INTERNALDATE BODY.PEEK[])`)).filter((x) => /FETCH/i.test(x.text) && x.literals.length);
      if (!it) continue;
      const when = it.text.match(/INTERNALDATE "([^"]+)"/i)?.[1];
      const email = parseEmail(it.literals[0]);
      out.push({ uid, date: internalDate(when) ?? email.date, from: email.from, subject: email.subject, text: email.text });
    }
    return out;
  } finally {
    await s.close();
  }
}

// ── MIME: just enough to find an email's text ───────────────────────────────

function headersOf(block) {
  const out = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] ??= line.slice(at + 1).trim();
  }
  return out;
}

function param(value, name) {
  const m = String(value ?? '').match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  return m ? m[1] ?? m[2] : null;
}

function decodeBody(body, encoding, charset) {
  const enc = String(encoding ?? '').toLowerCase().trim();
  let bytes;
  if (enc === 'base64') bytes = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  else if (enc === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '');
    const parts = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        parts.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else parts.push(s.charCodeAt(i) & 0xff);
    }
    bytes = Buffer.from(parts);
  } else bytes = Buffer.from(body, 'latin1');
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** RFC 2047 words in a header ("=?UTF-8?Q?...?="). */
function decodeWords(s) {
  return String(s ?? '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=\s*(?==\?)?/gi, (_, cs, kind, text) =>
    kind.toLowerCase() === 'b' ? decodeBody(text, 'base64', cs) : decodeBody(text.replace(/_/g, ' '), 'quoted-printable', cs),
  );
}

/** The text/plain and text/html parts of one MIME entity, as latin1 strings (one char per byte). */
function textParts(entity, found = { plain: null, html: null }) {
  const split = entity.search(/\r?\n\r?\n/);
  const head = headersOf(split < 0 ? entity : entity.slice(0, split));
  const body = split < 0 ? '' : entity.slice(split).replace(/^\r?\n\r?\n/, '');
  const type = String(head['content-type'] ?? 'text/plain').split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(head['content-type'], 'boundary');
    if (!boundary) return found;
    const pieces = body.split(`--${boundary}`).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      textParts(piece.replace(/^\r?\n/, ''), found);
    }
    return found;
  }
  const disposition = String(head['content-disposition'] ?? '').toLowerCase();
  if (disposition.startsWith('attachment')) return found;
  const text = () => decodeBody(body, head['content-transfer-encoding'], param(head['content-type'], 'charset'));
  if (type === 'text/plain' && found.plain == null) found.plain = text();
  if (type === 'text/html' && found.html == null) found.html = text();
  return found;
}

/** One raw email (Buffer or string) → { from, subject, date, text }. The text is the plain part, or the HTML part as text. */
export function parseEmail(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const split = s.search(/\r?\n\r?\n/);
  const head = headersOf(split < 0 ? s : s.slice(0, split));
  const parts = textParts(s);
  const date = head.date ? new Date(head.date) : null;
  return {
    from: (String(head.from ?? '').match(/<([^>]+)>/)?.[1] ?? String(head.from ?? '')).trim().toLowerCase(),
    subject: decodeWords(head.subject).trim(),
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    text: (parts.plain ?? (parts.html ? htmlToText(parts.html) : '')).replace(/\r\n/g, '\n'),
  };
}
