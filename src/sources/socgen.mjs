// Société Générale's own career site (careers.societegenerale.com). Its search page asks the site
// for a short-lived anonymous token (with the CSRF token written into the page), then sends the
// search through the site's own proxy to the group's search service. Each result carries the
// full description, so no role needs a second request. Filter by place with the site's own
// address: "?refinementList[jobLocation][0]=IND" (IND is India; city ids also work).

import { htmlToText } from '../text.mjs';

export const type = 'socgen';

const ORIGIN = 'https://careers.societegenerale.com';
const SEARCH = 'https://api.socgen.com/business-support/it-for-it-support/cognitive-service-knowledge/api/v1/search-profile';
const PAGE = 100;
const MAX_PAGES = 30; // 3,000 roles: more than the whole group lists worldwide

export function match(url) {
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'careers.societegenerale.com') return null;
  const locations = [];
  for (const [k, v] of url.searchParams) if (/^refinementList\[jobLocation\]/.test(k) && v) locations.push(...v.split(','));
  return { locations, scope: 'societegenerale' };
}

/** The CSRF token the search page hands its own scripts. */
export function csrfToken(html) {
  const m = html.match(/<script[^>]*data-drupal-selector="drupal-settings-json"[^>]*>([\s\S]*?)<\/script>/);
  let token;
  try {
    token = m && JSON.parse(m[1])?.csrfToken;
  } catch {
    token = null;
  }
  if (!token) throw new Error('no search token in the Société Générale careers page');
  return token;
}

export async function list(p, { http }) {
  const csrf = csrfToken(await http.fetchText(`${ORIGIN}/en/search`));
  const auth = await http.fetchJson(`${ORIGIN}/sg-careers-offers/get-token`, { headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf } });
  if (!auth?.token) throw new Error('no search token from the Société Générale careers site');

  const advanced = [{ type: 'simple', name: 'sourcestr6', op: 'eq', value: 'job' }];
  if (p.locations?.length) advanced.push({ type: 'multi', name: 'sourcecsv1', op: 'eq', values: p.locations });
  const fetchPage = (page) =>
    http.fetchJson(`${ORIGIN}/search-proxy.php`, {
      method: 'POST',
      headers: { 'X-Proxy-URL': SEARCH, 'Authorization-API': `Bearer ${auth.token}` },
      body: {
        profile: 'ces_profile_sgcareers',
        query: { advanced, skipCount: PAGE, skipFrom: page * PAGE, sort: 'sourcedatetime1.desc' },
        lang: 'en',
        responseType: 'SearchResult',
      },
    });

  const first = await fetchPage(0);
  if (!Array.isArray(first?.Result?.Docs)) throw new Error('no search results from the Société Générale careers site');
  const pages = Math.min(MAX_PAGES, Math.ceil((Number(first.TotalCount) || 0) / PAGE));
  const rest = await http.mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 1), 2, fetchPage);

  const jobs = [];
  const seen = new Set();
  for (const data of [first, ...rest]) {
    for (const d of data?.Result?.Docs ?? []) {
      // "26000KKV-en": the reference plus the language it is written in. A role posted in English
      // and French is one role; two roles can also share a reference with different titles.
      const ref = String(d.sourcestr4 ?? '').trim();
      const title = String(d.title ?? '').replace(/\s+/g, ' ').trim();
      const key = `${ref}|${title.toLowerCase()}`;
      if (!ref || seen.has(key) || (d.sourcestr6 && d.sourcestr6 !== 'job')) continue;
      seen.add(key);
      const id = String(d.sourcestr12 ?? ref).trim() || ref;
      jobs.push({
        id,
        title,
        location: String(d.sourcestr7 ?? '').trim() || null,
        url: d.url1 || `${ORIGIN}/en/job-offers/${encodeURIComponent(id)}`,
        postedAt: String(d.sourcedatetime1 ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null, // "2026-11-11 13:00:00"
        description: htmlToText(String(d.sourcevarchar2 ?? '')),
      });
    }
  }
  return jobs;
}
