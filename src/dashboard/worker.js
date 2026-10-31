// The dashboard Worker: serves the published page, and saves your calls on roles
// (Applied, Shortlist, Not for me) from its buttons to a KV namespace, with what came of
// an application (Rejected or Turned down, a reason from your list, the stage and a note).
//
//   GET  /api/feedback   every saved call: { entries: { <role id>: { v, r, t, o? } } }
//   POST /api/feedback   { id, verdict: 'applied' | 'shortlist' | 'not-for-me' | null, reason,
//                          outcome: { kind: 'rejected' | 'turned-down', reason, stage, note } | null }
//                        An outcome is kept only on an Applied call; o is { k, r, s, n, t }.
//   GET  /api/todo       every to-do tick: { entries: { <item id>: { d, n, t, a?, p?, x? } } }
//   POST /api/todo       { id, done: true | false, note }   (your list in todo.yml)
//                        + { task, priority, removed } for an item added on the dashboard
//   GET  /api/tailor     every Tailor request: { entries: { <role id>: { on, n, t } } }
//   POST /api/tailor     { id, on: true | false, note }   (only when settings.yml turns tailor on)
//                        With TAILOR_REPO and TAILOR_TOKEN set (tailor.dispatch), a request also starts
//                        that repository's tailoring workflow at once (workflow_dispatch of TAILOR_WORKFLOW
//                        on TAILOR_REF, inputs id, note, at). The token needs only Actions: read and write.
//
// Cloudflare Access sits in front of the whole address, so only you reach this. As a second
// guard, a request that did not come through Access (no Access token) is refused, and a write
// must come from the dashboard's own page.

const VERDICTS = ['applied', 'shortlist', 'not-for-me'];
const OUTCOMES = ['rejected', 'turned-down'];
const MAX_REASON = 240;
const MAX_LABEL = 80; // a reason or stage from your lists in settings.yml

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });

const viaAccess = (request) => Boolean(request.headers.get('cf-access-jwt-assertion') || /(^|;\s*)CF_Authorization=/.test(request.headers.get('cookie') ?? ''));

/** Start the tailoring workflow for one request. False when not set up or GitHub refused; the nightly run still queues it. */
async function dispatch(env, payload) {
  if (!env.TAILOR_REPO || !env.TAILOR_TOKEN) return false;
  try {
    const workflow = encodeURIComponent(env.TAILOR_WORKFLOW || 'tailor.yml');
    const res = await fetch(`https://api.github.com/repos/${env.TAILOR_REPO}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TAILOR_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'axia-dashboard', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: env.TAILOR_REF || 'main', inputs: { id: payload.id, note: payload.note || '', at: payload.at || '' } }),
    });
    return res.status === 204 || res.status === 200;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const kind = { '/api/feedback': 'fb', '/api/tailor': 'tr', '/api/todo': 'td' }[url.pathname];
    if (!kind) return json({ error: 'not found' }, 404);
    if (!viaAccess(request)) return json({ error: 'sign in first' }, 403);
    if (!env.FEEDBACK) return json({ error: 'feedback storage is not set up' }, 503);

    if (request.method === 'GET') {
      const entries = {};
      let cursor;
      for (let page = 0; page < 50; page++) {
        const list = await env.FEEDBACK.list({ prefix: `${kind}:`, cursor });
        for (const k of list.keys) if (k.metadata) entries[k.name.slice(3)] = k.metadata;
        if (list.list_complete || !list.cursor) break;
        cursor = list.cursor;
      }
      return json({ entries });
    }

    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
      if (!(request.headers.get('content-type') ?? '').includes('application/json')) return json({ error: 'send JSON' }, 415);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'not JSON' }, 400);
      }
      const id = String(body?.id ?? '');
      if (!/^[A-Za-z0-9-]{1,200}$/.test(id)) return json({ error: 'bad id' }, 400);
      if (kind === 'td') {
        if (typeof body.done !== 'boolean') return json({ error: 'done must be true or false' }, 400);
        let note = String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
        // An item added on the dashboard carries its own words and priority; removing one keeps a marker.
        const task = String(body.task ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (body.task != null && !task) return json({ error: 'the item needs some words' }, 400);
        const added = task ? { a: task, p: ['now', 'next', 'later'].includes(body.priority) ? body.priority : 'now', ...(body.removed === true ? { x: true } : {}) } : {};
        const entry = () => ({ d: body.done, n: note, t: new Date().toISOString(), ...added });
        while (new TextEncoder().encode(JSON.stringify(entry())).length > 1000) note = note.slice(0, -10);
        const e = entry();
        await env.FEEDBACK.put(`td:${id}`, JSON.stringify(e), { metadata: e });
        return json({ ok: true, entry: e });
      }
      if (kind === 'tr') {
        if (typeof body.on !== 'boolean') return json({ error: 'on must be true or false' }, 400);
        let note = String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
        const entry = () => ({ on: body.on, n: note, t: new Date().toISOString() });
        while (new TextEncoder().encode(JSON.stringify(entry())).length > 1000) note = note.slice(0, -10);
        const e = entry();
        await env.FEEDBACK.put(`tr:${id}`, JSON.stringify(e), { metadata: e });
        const started = e.on ? await dispatch(env, { id, note: e.n, at: e.t }) : false;
        return json({ ok: true, entry: e, started });
      }
      const verdict = body.verdict ?? null;
      if (verdict !== null && !VERDICTS.includes(verdict)) return json({ error: 'bad verdict' }, 400);
      const clean = (x, max) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      let reason = clean(body.reason, MAX_REASON);
      const oc = body.outcome ?? null;
      if (oc !== null && (typeof oc !== 'object' || !OUTCOMES.includes(oc.kind))) return json({ error: 'bad outcome' }, 400);
      if (oc && verdict !== 'applied') return json({ error: 'an outcome needs an Applied call' }, 400);
      const at = new Date().toISOString();
      const o = oc ? { k: oc.kind, r: clean(oc.reason, MAX_LABEL), s: clean(oc.stage, MAX_LABEL), n: clean(oc.note, MAX_REASON), t: clean(oc.at, 40) || at } : null;
      // KV metadata holds at most 1024 bytes; the call lives there so one list reads them all.
      const entry = () => ({ v: verdict, r: reason, t: at, ...(o ? { o } : {}) });
      const size = () => new TextEncoder().encode(JSON.stringify(entry())).length;
      while (size() > 1000 && o?.n) o.n = o.n.slice(0, -10);
      while (size() > 1000 && reason) reason = reason.slice(0, -10);
      const e = entry();
      // A cleared call is kept as verdict null, so the next run knows to drop it.
      await env.FEEDBACK.put(`fb:${id}`, JSON.stringify(e), { metadata: e });
      return json({ ok: true, entry: e });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
