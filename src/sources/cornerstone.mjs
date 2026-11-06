// Cornerstone OnDemand career sites (<company>.csod.com/ux/ats/careersite/<n>/home?c=<company>),
// such as the World Bank Group's. The site's page carries a short-lived public token and the
// address of Cornerstone's search service; the search then gives every open role with its
// description, 100 a request, so no posting reads are needed. `?country=in` on the address
// (the site's own country filter) carries over.

import { htmlToText } from '../text.mjs';

export const type = 'cornerstone';

const PAGE = 100;
const MAX_JOBS = 5000;
const regions = new Intl.DisplayNames(['en'], { type: 'region' });

export function match(url) {
  const host = url.hostname.toLowerCase();
  const m = host.match(/^([a-z0-9-]+)\.csod\.com$/);
  const site = url.pathname.match(/\/ux\/ats\/careersite\/(\d+)(\/|$)/i);
  if (!m || !site) return null;
  const corp = url.searchParams.get('c') || m[1];
  const countries = url.searchParams.getAll('country').flatMap((c) => c.split(',')).map((c) => c.trim().toLowerCase()).filter(Boolean);
  return { host, corp, site: Number(site[1]), countries, scope: `${host}:${site[1]}` };
}

/** The csod.context object the page sets up: its token and the search service's address. */
export function contextOf(html) {
  const m = String(html).match(/csod\.context\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    const c = JSON.parse(m[1]);
    return c?.token ? { token: c.token, api: String(c.endpoints?.cloud || 'https://us.api.csod.com/').replace(/\/?$/, '/') } : null;
  } catch {
    return null;
  }
}

/** "11/5/2026" (the site's US date) → "2026-11-05". */
export function usDay(s) {
  const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const iso = String(s ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

/** [{city: "Chennai", country: "IN"}, {country: "SG"}] → "Chennai, India; Singapore". */
function place(locations) {
  const country = (c) => {
    try {
      return c ? regions.of(String(c).toUpperCase()) : '';
    } catch {
      return String(c);
    }
  };
  const all = (locations ?? []).map((l) => [l?.city, country(l?.country)].filter(Boolean).join(', ')).filter(Boolean);
  return all.length ? [...new Set(all)].join('; ') : null;
}

const textOf = (s) => (/<\/?[a-z][^>]*>/i.test(s) ? htmlToText(s) : s.replace(/[ \t ]+/g, ' ').trim());

export async function list(p, { http }) {
  const home = `https://${p.host}/ux/ats/careersite/${p.site}/home?c=${encodeURIComponent(p.corp)}`;
  const ctx = contextOf(await http.fetchText(home));
  if (!ctx) throw new Error(`no search token on ${p.host}'s career site (is this a Cornerstone career site?)`);
  const search = (n) =>
    http.fetchJson(`${ctx.api}rec-job-search/external/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.token}` },
      body: {
        careerSiteId: p.site, careerSitePageId: p.site, pageNumber: n, pageSize: PAGE, cultureId: 1, searchText: '', cultureName: 'en-US',
        states: [], countryCodes: p.countries, cities: [], placeID: '', radius: null, postingsWithinDays: null,
        customFieldCheckboxKeys: [], customFieldDropdowns: [], customFieldRadios: [],
      },
    });

  const jobs = [];
  const seen = new Set();
  for (let n = 1; (n - 1) * PAGE < MAX_JOBS; n++) {
    const d = (await search(n))?.data;
    if (!Array.isArray(d?.requisitions)) throw new Error(`no job list from Cornerstone for ${p.host}`);
    for (const r of d.requisitions) {
      const id = String(r.requisitionId ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      jobs.push({
        id,
        title: String(r.displayJobTitle ?? '').trim(),
        location: place(r.locations),
        url: `https://${p.host}/ux/ats/careersite/${p.site}/home/requisition/${id}?c=${encodeURIComponent(p.corp)}`,
        postedAt: usDay(r.postingEffectiveDate),
        description: textOf(String(r.externalDescription ?? '')),
      });
    }
    if (d.requisitions.length < PAGE || n * PAGE >= (Number(d.totalCount) || 0)) break;
  }
  return jobs;
}
