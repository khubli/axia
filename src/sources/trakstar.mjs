// Trakstar Hire career sites (<company>.hire.trakstar.com, formerly Recruiterbox). The hosted job
// list is a plain page, but Trakstar publishes the same openings as public JSON for job widgets on
// an employer's own site (jsapi.recruiterbox.com), each with its description and office.

import { htmlToText } from '../text.mjs';

export const type = 'trakstar';

const API = 'https://jsapi.recruiterbox.com/v1/openings';
const PAGE = 100;

export function match(url) {
  const host = url.hostname.toLowerCase();
  const m = host.match(/^([a-z0-9-]+)\.hire\.trakstar\.com$/) ?? host.match(/^([a-z0-9-]+)\.recruiterbox\.com$/);
  if (!m || m[1] === 'www' || m[1] === 'app' || m[1] === 'jsapi') return null;
  return { client: m[1], scope: `${m[1]}.hire.trakstar.com` };
}

/** {city: 'Pune', state: 'Maharashtra', country: 'India'} → "Pune, Maharashtra, India". */
const placeOf = (l) => [...new Set([l?.city, l?.state, l?.country].map((s) => String(s ?? '').trim()).filter(Boolean))].join(', ');

export async function list(p, { http }) {
  const jobs = [];
  const seen = new Set();
  for (let offset = 0; ; offset += PAGE) {
    const d = await http.fetchJson(`${API}?client_name=${encodeURIComponent(p.client)}&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(d?.objects)) throw new Error(`no job list for ${p.client} from Trakstar Hire (check the address)`);
    for (const j of d.objects) {
      const id = String(j.id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const place = placeOf(j.location);
      jobs.push({
        id,
        title: String(j.title ?? '').replace(/\s+/g, ' ').trim(),
        location: place || (j.allows_remote ? 'Remote' : null),
        url: j.hosted_url || `https://${p.client}.hire.trakstar.com/jobs/${encodeURIComponent(id)}/`,
        postedAt: null,
        description: htmlToText(String(j.description ?? '')),
      });
    }
    const total = Number(d.meta?.total ?? 0);
    if (!d.objects.length || offset + PAGE >= total) break;
  }
  return jobs;
}
