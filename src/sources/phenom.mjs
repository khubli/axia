// Phenom career sites, on the employer's own domain such as careers.allianz.com. The address
// can't tell them apart from any other site, so companies.yml names the platform: `platform: phenom`.
//
// Phenom pages load their roles from a public POST /widgets endpoint (no login). The site's
// country and language come from the address (/global/en/…). Query terms on the address
// filter the search the way the site's own filters do: `?country=India` reads only the
// roles the site places in India; `?keywords=` adds search words.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'phenom';

const PAGE = 100;
const MAX_JOBS = 5000;
// Address terms that are paging, sorting or tracking on a copied search page, not filters.
const NOT_FILTERS = new Set(['keywords', 'from', 's', 'sortBy', 'page', 'rk', 'utm_source', 'utm_medium', 'utm_campaign']);

export function match(url, { platform } = {}) {
  if (platform !== type) return null;
  // /global/en/search-results → country "global", language "en"; a site without them is /us/en.
  const [first, second] = url.pathname.split('/').filter(Boolean);
  const localised = /^[a-z]{2}$/i.test(second ?? '') && /^[a-z]{2,8}$/i.test(first ?? '');
  const country = localised ? first.toLowerCase() : 'us';
  const lang = localised ? second.toLowerCase() : 'en';
  const filters = {};
  for (const [k, v] of url.searchParams) {
    if (!NOT_FILTERS.has(k) && v) (filters[k] ??= []).push(v);
  }
  return { origin: url.origin, country, lang, keywords: url.searchParams.get('keywords') ?? '', filters, scope: url.host.toLowerCase() };
}

function widgets(p, http, body, opts = {}) {
  return http.fetchJson(`${p.origin}/widgets`, {
    method: 'POST',
    body: { lang: `${p.lang}_${p.country}`, deviceType: 'desktop', country: p.country, siteType: 'external', ...body },
    ...opts,
  });
}

async function search(p, http, from) {
  const data = await widgets(p, http, {
    ddoKey: 'refineSearch',
    sortBy: 'Most recent', // a fixed order, so pages don't overlap
    from,
    size: PAGE,
    jobs: true,
    counts: false,
    all_fields: [],
    keywords: p.keywords,
    global: true,
    selected_fields: p.filters,
  });
  const r = data?.refineSearch;
  if (!Array.isArray(r?.data?.jobs)) throw new Error(`no job list from ${new URL(p.origin).host} (is this a Phenom career site?)`);
  return { total: Number(r.totalHits) || 0, jobs: r.data.jobs };
}

// "Senior Technical Architect_2966", "DevOps Architect_ 3245": some employers end titles with a requisition code.
const cleanTitle = (t) => String(t ?? '').replace(/\s*_\s*[A-Z]?-?\d+\s*$/i, '').trim();

/** One role as listed: every place it is offered, else the single location, else unknown. */
function place(j) {
  const many = (j.multi_location ?? []).map((l) => (typeof l === 'string' ? l : l?.location ?? '')).map((s) => String(s).trim()).filter(Boolean);
  if (many.length) return many.join('; ');
  return j.location || j.cityStateCountry || null;
}

export async function list(p, { http }) {
  const first = await search(p, http, 0);
  const total = Math.min(MAX_JOBS, first.total);
  const size = first.jobs.length;
  const starts = [];
  for (let s = size; size && s < total; s += size) starts.push(s);
  const rest = await http.mapLimit(starts, 4, (s) => search(p, http, s));
  const jobs = [];
  const seen = new Set();
  for (const page of [first, ...rest]) {
    for (const j of page.jobs) {
      const id = String(j.jobSeqNo ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      jobs.push({
        id,
        title: cleanTitle(j.title),
        location: place(j),
        url: `${p.origin}/${p.country}/${p.lang}/job/${encodeURIComponent(id)}`,
        postedAt: toDay(j.postedDate),
      });
    }
  }
  return jobs;
}

export async function detail(p, job, { http }) {
  const data = await widgets(p, http, { ddoKey: 'jobDetail', jobSeqNo: job.id });
  const j = data?.jobDetail?.data?.job ?? {};
  return { description: htmlToText(String(j.description ?? '').replace(/\r/g, '')) };
}
