// Career sites whose search loads roles from jobsapi-google.m-cloud.io (a jobs API many employer
// career sites use, run by Radancy; Vanguard's is one). The site's own page names the company
// ("var cws_opts = {"org":"companies/…","api":…}"), then the API gives every open role with its
// description and opening date, 100 a request. The site sits on the employer's own domain, so
// companies.yml names it with `platform: cws`.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'cws';

const PAGE = 100;
const MAX_PAGES = 50;

export function match(url, { platform } = {}) {
  if (platform !== type) return null;
  return { page: url.href, scope: url.host.toLowerCase().replace(/^www\./, '') };
}

/** The company and API the page's search uses, from its cws_opts. */
export function optionsOf(html) {
  const m = html.match(/var\s+cws_opts\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  let o;
  try {
    o = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!o.org || !o.api) return null;
  return { org: String(o.org), api: String(o.api).replace(/\/?$/, '/') };
}

function place(j) {
  const main = [j.primary_city, j.primary_state, j.primary_country].filter(Boolean).join(', ');
  let more = [];
  try {
    more = (typeof j.addtnl_locations === 'string' ? JSON.parse(j.addtnl_locations) : j.addtnl_locations ?? [])
      .map((l) => [l.city, l.state, l.country].filter(Boolean).join(', '));
  } catch {}
  const all = [...new Set([main, ...more].filter(Boolean))];
  return all.length ? all.join('; ') : null;
}

export async function list(p, { http }) {
  const opts = optionsOf(await http.fetchText(p.page));
  if (!opts) throw new Error(`no job search settings (cws_opts) on ${new URL(p.page).host}`);
  const search = (offset) => http.fetchJson(`${opts.api}job/search?pageSize=${PAGE}&offset=${offset}&companyName=${encodeURIComponent(opts.org)}`);
  const first = await search(0);
  if (!Array.isArray(first?.searchResults)) throw new Error(`no job list from ${new URL(opts.api).host}`);
  const pages = Math.min(MAX_PAGES, Math.ceil((Number(first.totalHits) || 0) / PAGE));
  const rest = await http.mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * PAGE), 4, search);
  const jobs = [];
  const seen = new Set();
  for (const page of [first, ...rest]) {
    for (const r of page?.searchResults ?? []) {
      const j = r.job ?? {};
      const id = String(j.id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      jobs.push({
        id,
        title: String(j.title ?? '').replace(/\s+/g, ' ').trim(),
        location: place(j),
        url: String(j.url || new URL(`/job/${id}`, p.page).href).replace(/^http:\/\//, 'https://'),
        postedAt: toDay(j.open_date) ?? null,
        description: htmlToText(String(j.description ?? '')),
      });
    }
  }
  return jobs;
}
