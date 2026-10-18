// SAP SuccessFactors career sites (Recruiting Marketing), usually on the employer's own
// domain, such as careers.example.com. The address can't tell them apart from any other
// site, so companies.yml names the platform: `platform: successfactors`.
//
// Two kinds exist. Newer sites answer a JSON search API; older ones only serve the search
// page as HTML, 25 roles a page. The API is tried first and the pages are the fallback.
// `?locationsearch=` and `?q=` on the configured address narrow the search, which keeps
// a large employer to a few dozen requests.

import { decodeEntities, htmlToText, toDay } from '../text.mjs';

export const type = 'successfactors';

const MAX_JOBS = 5000;

export function match(url, { platform } = {}) {
  if (platform !== type) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('search');
  const kept = at >= 0 ? parts.slice(0, at) : parts;
  return {
    origin: url.origin,
    base: `/${kept.map((p) => `${p}/`).join('')}`,
    keywords: url.searchParams.get('q') ?? '',
    location: url.searchParams.get('locationsearch') ?? '',
    locale: url.searchParams.get('locale') ?? '',
    scope: url.host.toLowerCase(),
  };
}

export async function list(p, ctx) {
  let first;
  try {
    first = await searchApi(p, ctx.http, 0);
  } catch {
    first = null; // an older site: no API, read the search pages instead
  }
  return first ? listApi(p, ctx.http, first) : listPages(p, ctx.http);
}

// ── Newer sites: the JSON search API ─────────────────────────────────────────

function searchApi(p, http, pageNumber) {
  return http.fetchJson(`${p.origin}/services/recruiting/v1/jobs`, {
    method: 'POST',
    // An older site answers 401 at once; don't spend long on a site that doesn't answer at all.
    ...(pageNumber === 0 ? { retries: 1, timeoutMs: 15000 } : {}),
    body: {
      locale: p.locale || 'en_US',
      pageNumber,
      sortBy: 'date', // with no sort, pages overlap and about a fifth of the roles never show up
      keywords: p.keywords,
      location: p.location,
      facetFilters: {},
      brand: '',
      skills: [],
      categoryId: 0,
      alertId: '',
      rcmCandidateId: '',
    },
  }).then((data) => {
    if (!Array.isArray(data?.jobSearchResult)) throw new Error('no job list in the answer');
    return data;
  });
}

async function listApi(p, http, first) {
  const size = first.jobSearchResult.length;
  const total = Math.min(MAX_JOBS, Number(first.totalJobs) || 0);
  const pages = size ? Math.ceil(total / size) : 0;
  const rest = await http.mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 1), 4, (n) => searchApi(p, http, n));
  const jobs = [];
  const seen = new Set();
  for (const data of [first, ...rest]) {
    for (const { response: r } of data.jobSearchResult) {
      if (!r?.id || seen.has(String(r.id))) continue;
      seen.add(String(r.id));
      const locale = r.supportedLocales?.[0] || p.locale || 'en_US';
      const places = (r.jobLocationShort ?? []).map((l) => String(l).trim()).filter(Boolean);
      jobs.push({
        id: String(r.id),
        title: decodeEntities(r.unifiedStandardTitle ?? ''),
        location: places.length ? places.join('; ') : null,
        url: `${p.origin}/job/${r.unifiedUrlTitle ?? r.urlTitle ?? 'job'}/${r.id}-${locale}`,
        postedAt: null, // the API's dates follow the site's locale (17/09/2026 or 9/17/26); the posting has the real one
      });
    }
  }
  return jobs;
}

// ── Older sites: the HTML search pages ───────────────────────────────────────

function pageUrl(p, startrow) {
  const q = new URLSearchParams({ q: p.keywords, locationsearch: p.location, startrow: String(startrow) });
  if (p.locale) q.set('locale', p.locale);
  return `${p.origin}${p.base}search/?${q}`;
}

/** One search page → its roles and the total the site reports. Throws when the page has no job list at all. */
export function parsePage(html, origin) {
  const total = html.match(/of\s*<b>\s*([\d,.]+)\s*<\/b>/i);
  const rows = html.split(/<tr[^>]*class="data-row[^"]*"/i).slice(1);
  if (!total && rows.length === 0) {
    if (/class="[^"]*searchResultsShell/i.test(html) || /There are currently no open positions/i.test(html)) return { total: 0, jobs: [] };
    throw new Error('no job list on the search page (is this a SuccessFactors career site?)');
  }
  const jobs = [];
  for (const row of rows) {
    const link = row.match(/<a\b[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*>[\s\S]*?<\/a>/i)?.[0];
    if (!link) continue;
    const href = decodeEntities(link.match(/href="([^"]+)"/i)?.[1] ?? '');
    const id = href.match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1];
    if (!id) continue;
    const cell = row.match(/<td[^>]*class="[^"]*colLocation[^"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? row.match(/<span class="jobLocation[^"]*">([\s\S]*?)<\/span>/i)?.[1] ?? '';
    const more = /\bmore\b/i.test(cell);
    const place = htmlToText(cell.replace(/<small[\s\S]*?<\/small>/gi, '')).replace(/\s+/g, ' ').trim();
    const date = row.match(/<span class="jobDate[^"]*">([\s\S]*?)<\/span>/i)?.[1];
    jobs.push({
      id,
      title: htmlToText(link).replace(/\s+/g, ' ').trim(),
      // "Noida, UP, IN +33 more…": leave it unknown so the posting is read for the rest.
      location: more || !place ? null : place,
      url: new URL(href, origin).href,
      postedAt: date ? dayOf(htmlToText(date)) : null,
      ref: { listedPlace: place || null },
    });
  }
  return { total: total ? Number(total[1].replace(/[,.]/g, '')) : jobs.length, jobs };
}

/** "18 Oct 2026" as a calendar day, whatever the machine's time zone. */
function dayOf(text) {
  return toDay(`${text} UTC`) ?? toDay(text);
}

async function listPages(p, http) {
  const first = parsePage(await http.fetchText(pageUrl(p, 0)), p.origin);
  const size = first.jobs.length;
  const total = Math.min(MAX_JOBS, first.total);
  const starts = [];
  for (let s = size; size && s < total; s += size) starts.push(s);
  const rest = await http.mapLimit(starts, 4, async (s) => parsePage(await http.fetchText(pageUrl(p, s)), p.origin));
  const jobs = [];
  const seen = new Set();
  for (const page of [first, ...rest]) {
    for (const j of page.jobs) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      jobs.push(j);
    }
  }
  return jobs;
}

// ── One posting (both kinds share the job page) ──────────────────────────────

/** The inner HTML of the element whose opening tag contains `marker`, nested tags included. */
export function innerOf(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const open = html.lastIndexOf('<', at);
  const name = html.slice(open + 1).match(/^[a-z0-9]+/i)?.[0];
  const startInner = html.indexOf('>', at) + 1;
  if (!name || startInner <= 0) return '';
  const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  tag.lastIndex = startInner;
  let depth = 1;
  for (let m; (m = tag.exec(html)); ) {
    if (m[0].endsWith('/>')) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(startInner, m.index);
  }
  return html.slice(startInner);
}

export function parseJobPage(html) {
  const meta = (prop) => [...html.matchAll(new RegExp(`itemprop="${prop}"\\s+content="([^"]*)"`, 'gi'))].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
  const places = [...new Set(meta('addressLocality'))];
  const countries = [...new Set(meta('addressCountry'))];
  const posted = meta('datePosted')[0];
  return {
    description: htmlToText(innerOf(html, 'itemprop="description"').replace(/\r/g, '')),
    location: places.length ? [places.join('; '), countries.join(', ')].filter(Boolean).join(', ') : undefined,
    postedAt: (posted && toDay(posted)) || undefined, // "Wed Oct 14 00:00:00 UTC 2026"
  };
}

export async function detail(_p, job, { http }) {
  const d = parseJobPage(await http.fetchText(job.url));
  // Some postings don't name their places; the one the list showed beats "unknown".
  if (!d.location && job.ref?.listedPlace) d.location = job.ref.listedPlace;
  return d;
}
