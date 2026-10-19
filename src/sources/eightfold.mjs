// Eightfold career sites: <company>.eightfold.ai, or the employer's own domain such as
// portal.careers.hsbc.com (then companies.yml says `platform: eightfold`).
// Two APIs exist; the older one (/api/apply/v2) is tried first, the newer one (/api/pcsx)
// second. `?location=India` on the address narrows the search, and `?domain=` names the
// site's company domain when it isn't the address's own (paypal.eightfold.ai → paypal.com).

import { htmlToText } from '../text.mjs';

export const type = 'eightfold';

const MAX_JOBS = 5000;

export function match(url, { platform } = {}) {
  const host = url.hostname.toLowerCase();
  const hosted = host.endsWith('.eightfold.ai');
  if (!hosted && platform !== type) return null;
  const domain = url.searchParams.get('domain') || (hosted ? `${host.split('.')[0]}.com` : host.split('.').slice(-2).join('.'));
  return { origin: url.origin, domain, location: url.searchParams.get('location') ?? '', query: url.searchParams.get('query') ?? '', scope: `${host}:${domain}` };
}

const ts = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString().slice(0, 10) : null);

function v2Url(p, start) {
  const q = new URLSearchParams({ domain: p.domain, start: String(start), num: '10', sort_by: 'timestamp' });
  if (p.location) q.set('location', p.location);
  if (p.query) q.set('query', p.query);
  return `${p.origin}/api/apply/v2/jobs?${q}`;
}

function pcsxUrl(p, start) {
  const q = new URLSearchParams({ domain: p.domain, query: p.query, location: p.location, start: String(start), sort_by: 'timestamp' });
  return `${p.origin}/api/pcsx/search?${q}`;
}

/** One page from either API as { total, positions } in the older API's field names; null when that API isn't on. */
async function page(p, http, api, start) {
  if (api === 'v2') {
    const d = await http.fetchJson(v2Url(p, start));
    return Array.isArray(d?.positions) ? { total: Number(d.count) || 0, positions: d.positions } : null;
  }
  const d = (await http.fetchJson(pcsxUrl(p, start)))?.data;
  if (!Array.isArray(d?.positions)) return null;
  return {
    total: Number(d.count) || 0,
    positions: d.positions.map((x) => ({ id: x.id, name: x.name, locations: x.locations, location: x.location, t_create: x.postedTs ?? x.creationTs })),
  };
}

export async function list(p, { http }) {
  let api = 'v2';
  let first = await page(p, http, 'v2', 0).catch(() => null);
  if (!first) {
    api = 'pcsx';
    first = await page(p, http, 'pcsx', 0);
    if (!first) throw new Error(`no job list from ${new URL(p.origin).host} (check the domain: ${p.domain})`);
  }
  const size = first.positions.length;
  const total = Math.min(MAX_JOBS, first.total);
  const starts = [];
  for (let s = size; size && s < total; s += size) starts.push(s);
  const rest = await http.mapLimit(starts, 4, async (s) => {
    const r = await page(p, http, api, s);
    if (!r) throw new Error(`a later page from ${new URL(p.origin).host} had no job list`);
    return r;
  });
  const jobs = [];
  const seen = new Set();
  for (const r of [first, ...rest]) {
    for (const x of r.positions) {
      const id = String(x.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const places = (x.locations?.length ? x.locations : [x.location]).filter(Boolean);
      jobs.push({
        id,
        title: x.name,
        location: places.length ? places.join('; ') : null,
        url: `${p.origin}/careers/job/${id}`,
        postedAt: ts(x.t_create),
      });
    }
  }
  return jobs;
}

export async function detail(p, job, { http }) {
  const d = await http.fetchJson(`${p.origin}/api/apply/v2/jobs/${job.id}?domain=${encodeURIComponent(p.domain)}`);
  return { description: htmlToText(d.job_description ?? '') };
}
