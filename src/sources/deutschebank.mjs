// Deutsche Bank's own careers site (careers.db.com). Its search page loads roles from a public
// search API on api-deutschebank.beesite.de, 100 a request, and each role's text from a small
// JSON file. `?country=India` on the address (a country name, or the site's own country id) reads
// only that country's roles; without it every role worldwide is listed.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'deutschebank';

const API = 'https://api-deutschebank.beesite.de';
const SITE = 'https://careers.db.com/professionals/search-roles/#/professional';
const PAGE = 100;
const MAX_PAGES = 40;
const FIELDS = ['PositionID', 'PositionTitle', 'PositionLocation.CityName', 'PositionLocation.CountryName', 'PublicationStartDate'];

export function match(url) {
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'careers.db.com') return null;
  // The site keeps its filters after the # (".../#/professional/results/?country=81"); either place works.
  const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '';
  const country = url.searchParams.get('country') ?? new URLSearchParams(hashQuery).get('country') ?? null;
  return { scope: 'deutschebank', country: country?.trim() || null };
}

/** The site's id for a country, from a name ("India") or an id ("81"). */
async function countryId(country, http) {
  if (!country) return null;
  if (/^\d+$/.test(country)) return country;
  const d = await http.fetchJson(`${API}/lookup/country/lang/2`);
  const hit = (d?.lookup?.items ?? []).find((i) => String(i.label).toLowerCase() === country.toLowerCase());
  if (!hit) throw new Error(`careers.db.com has no country called "${country}"`);
  return String(hit.id);
}

const searchUrl = (country, first) =>
  `${API}/search/?data=${encodeURIComponent(JSON.stringify({
    LanguageCode: 'EN',
    SearchParameters: { FirstItem: first, CountItem: PAGE, MatchedObjectDescriptor: FIELDS, Sort: [{ Criterion: 'PublicationStartDate', Direction: 'DESC' }] },
    SearchCriteria: country ? [{ CriterionName: 'PositionLocation.Country', CriterionValue: [country] }] : [],
  }))}`;

async function search(country, http, first) {
  const d = await http.fetchJson(searchUrl(country, first));
  if (!d?.SearchResult) throw new Error('no search results from careers.db.com');
  return { total: Number(d.SearchResult.SearchResultCountAll) || 0, items: d.SearchResult.SearchResultItems ?? [] };
}

export async function list(p, { http }) {
  const country = await countryId(p.country, http);
  const first = await search(country, http, 1);
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE));
  const rest = await http.mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => 1 + (i + 1) * PAGE), 4, (n) => search(country, http, n));
  const jobs = [];
  const seen = new Set();
  for (const page of [first, ...rest]) {
    for (const item of page.items) {
      const d = item.MatchedObjectDescriptor ?? {};
      const id = String(d.PositionID ?? item.MatchedObjectId ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const places = (d.PositionLocation ?? []).map((l) => [l.CityName, l.CountryName].filter(Boolean).join(', ')).filter(Boolean);
      jobs.push({
        id,
        title: String(d.PositionTitle ?? '').replace(/\s+/g, ' ').trim(),
        location: places.length ? [...new Set(places)].join('; ') : null,
        url: `${SITE}/job/${encodeURIComponent(id)}`,
        postedAt: toDay(d.PublicationStartDate) ?? null,
      });
    }
  }
  return jobs;
}

export async function detail(_p, job, { http }) {
  const d = await http.fetchJson(`${API}/jobhtml/${encodeURIComponent(job.id)}.json`);
  return { description: htmlToText(String(d?.html ?? '')) };
}
