// Oracle Recruiting Cloud (Candidate Experience sites on *.oraclecloud.com, or *.oraclecloud.eu in the EU).
// Public REST endpoints behind the career site; no login needed.

import { htmlToText, toDay } from '../text.mjs';

const PAGE = 200;
const MAX_PAGES = 50; // 10,000 postings, as far as the API pages

export const type = 'oracle';

export function match(url) {
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.oraclecloud.com') && !host.endsWith('.oraclecloud.eu')) return null;
  const m = url.pathname.match(/\/CandidateExperience\/([a-z-]+)\/sites\/([^/]+)/i);
  if (!m) return null;
  return { host, lang: m[1], site: m[2], scope: `${host}:${m[2]}` };
}

const rest = (p) => `https://${p.host}/hcmRestApi/resources/latest`;

// The API returns nothing past offset 10,000, so a site listing more than that (Kotak
// Mahindra Bank lists about 11,600) also has each job category read on its own.
const OFFSET_CAP = PAGE * MAX_PAGES;

async function readList(p, http, facet = '') {
  const jobs = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const finder = `findReqs;siteNumber=${p.site},facetsList=NONE,limit=${PAGE},offset=${page * PAGE},sortBy=POSTING_DATES_DESC${facet}`;
    const data = await http.fetchJson(`${rest(p)}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`);
    const item = data.items?.[0] ?? {};
    const reqs = item.requisitionList ?? [];
    if (page === 0) total = item.TotalJobsCount ?? 0;
    for (const r of reqs) {
      const secondary = (r.secondaryLocations ?? []).map((l) => l.Name).filter(Boolean);
      jobs.push({
        id: String(r.Id),
        title: r.Title,
        location: [r.PrimaryLocation, ...secondary].filter(Boolean).join('; ') || null,
        url: `https://${p.host}/hcmUI/CandidateExperience/${p.lang}/sites/${p.site}/job/${r.Id}`,
        postedAt: toDay(r.PostedDate),
      });
    }
    if (reqs.length < PAGE || (page + 1) * PAGE >= (item.TotalJobsCount ?? 0)) break;
  }
  return { jobs, total };
}

export async function list(p, { http }) {
  const { jobs, total } = await readList(p, http);
  if (total <= OFFSET_CAP) return jobs;
  // Each category is under 10,000, so between them they reach the oldest postings too.
  // A posting with no category is read only if it is among the newest 10,000.
  const finder = `findReqs;siteNumber=${p.site},facetsList=CATEGORIES,limit=1`;
  const data = await http.fetchJson(`${rest(p)}/recruitingCEJobRequisitions?onlyData=true&expand=categoriesFacet&finder=${encodeURIComponent(finder)}`);
  const seen = new Set(jobs.map((j) => j.id));
  for (const c of data.items?.[0]?.categoriesFacet ?? []) {
    if (!c.Id || !c.TotalCount) continue;
    const { jobs: more } = await readList(p, http, `,selectedCategoriesFacet=${c.Id}`);
    for (const j of more) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      jobs.push(j);
    }
  }
  return jobs;
}

export async function detail(p, job, { http }) {
  const finder = `ById;Id="${job.id}",siteNumber=${p.site}`;
  const data = await http.fetchJson(`${rest(p)}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${encodeURIComponent(finder)}`);
  const d = data.items?.[0] ?? {};
  const parts = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr].filter(Boolean).map(htmlToText);
  return { description: parts.join('\n\n') };
}
