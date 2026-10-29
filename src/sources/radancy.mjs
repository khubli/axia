// Radancy (TalentBrew) career sites, on the employer's own domain such as schwabjobs.com.
// The address can't tell them apart from any other site, so companies.yml names the
// platform: `platform: radancy`.
//
// The configured address is one of the site's own search pages, for example the page for a
// location (www.schwabjobs.com/search-jobs/India/33995/2/1269750/22/79/50/2). That page says
// which search it shows (keywords, location, location path); the same search is then asked of
// the site's results endpoint, 100 roles a request. A posting's text and date are read from its
// own page (schema.org JobPosting) only when a role is about to be scored.

import { decodeEntities, htmlToText, toDay } from '../text.mjs';

export const type = 'radancy';

const PAGE = 100;
const MAX_PAGES = 50;

export function match(url, { platform } = {}) {
  if (platform !== type) return null;
  return { origin: url.origin, page: url.href, scope: url.host.toLowerCase() };
}

/** The search a page shows, from the data-* attributes of its results section. */
export function searchOf(html) {
  const section = html.match(/<section\b[^>]*\bid="search-results"[^>]*>/i)?.[0];
  if (!section) return null;
  const attr = (name) => decodeEntities(section.match(new RegExp(`\\bdata-${name}="([^"]*)"`, 'i'))?.[1] ?? '');
  return {
    keywords: attr('keywords'),
    location: attr('location'),
    locationType: attr('location-type'),
    locationPath: attr('location-path'),
    organizationIds: attr('organization-ids'),
  };
}

function resultsUrl(p, search, page) {
  const q = new URLSearchParams({
    ActiveFacetID: '0',
    CurrentPage: String(page),
    RecordsPerPage: String(PAGE),
    Distance: '50',
    RadiusUnitType: '0',
    Keywords: search.keywords,
    Location: search.location,
    ShowRadius: 'False',
    IsPagination: 'False',
    FacetType: '0',
    SearchResultsModuleName: 'Search Results',
    SearchFiltersModuleName: 'Search Filters',
    SortCriteria: '0',
    SortDirection: '0',
    SearchType: '5',
    LocationType: search.locationType,
    LocationPath: search.locationPath,
    OrganizationIds: search.organizationIds,
  });
  return `${p.origin}/search-jobs/results?${q}`;
}

/** The roles in one results list, and the total it reports. */
export function parseResults(html, p) {
  const total = Number(html.match(/\bdata-total-results="(\d+)"/i)?.[1] ?? NaN);
  const jobs = [];
  for (const m of html.matchAll(/<a\b[^>]*href="(\/job\/[^"]*)"[^>]*\bdata-job-id="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href, id, inner] = m;
    const h2 = inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    // Some titles start with zero-width spaces pasted from the ATS.
    const title = htmlToText(h2 ? h2[1] : '').replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const loc = inner.match(/class="[^"]*job-location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    jobs.push({
      id,
      title,
      location: loc ? htmlToText(loc[1]).replace(/\s+/g, ' ').trim() || null : null,
      url: new URL(href.replace(/&amp;/g, '&'), `${p.origin}/`).href,
      postedAt: null, // the list gives no posting date; the job page does
    });
  }
  return { total: Number.isFinite(total) ? total : null, jobs };
}

async function fetchResults(p, http, search, page) {
  const d = await http.fetchJson(resultsUrl(p, search, page), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (typeof d?.results !== 'string') throw new Error(`no results list from ${new URL(p.origin).host} (is this a Radancy career site?)`);
  return parseResults(d.results, p);
}

export async function list(p, { http }) {
  const search = searchOf(await http.fetchText(p.page));
  if (!search) throw new Error('no search results section on the Radancy search page');
  const first = await fetchResults(p, http, search, 1);
  const pages = Math.min(MAX_PAGES, Math.ceil((first.total ?? first.jobs.length) / PAGE));
  const rest = await http.mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 4, (n) =>
    fetchResults(p, http, search, n),
  );
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

export async function detail(p, job, { http }) {
  const html = await http.fetchText(job.url);
  for (const m of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d;
    try {
      d = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const posting = [d].flat().find((x) => x?.['@type'] === 'JobPosting');
    if (!posting) continue;
    const text = [posting.description, posting.qualifications, posting.responsibilities]
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => htmlToText(x).trim())
      .filter(Boolean)
      .join('\n\n');
    const place = [posting.jobLocation].flat()[0]?.address;
    const location = place ? [place.addressLocality, place.addressRegion, place.addressCountry].filter(Boolean).join(', ') : null;
    return { description: text, postedAt: toDay(posting.datePosted), location: location || null };
  }
  throw new Error('no JobPosting data on the Radancy job page');
}
