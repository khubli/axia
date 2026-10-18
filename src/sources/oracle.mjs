// Oracle Recruiting Cloud (Candidate Experience sites on *.oraclecloud.com, or *.oraclecloud.eu in the EU).
// Public REST endpoints behind the career site; no login needed.

import { htmlToText, toDay } from '../text.mjs';

const PAGE = 200;
const MAX_PAGES = 50; // 10,000 postings; one bank lists over 7,000

export const type = 'oracle';

export function match(url) {
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.oraclecloud.com') && !host.endsWith('.oraclecloud.eu')) return null;
  const m = url.pathname.match(/\/CandidateExperience\/([a-z-]+)\/sites\/([^/]+)/i);
  if (!m) return null;
  return { host, lang: m[1], site: m[2], scope: `${host}:${m[2]}` };
}

const rest = (p) => `https://${p.host}/hcmRestApi/resources/latest`;

export async function list(p, { http }) {
  const jobs = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const finder = `findReqs;siteNumber=${p.site},facetsList=NONE,limit=${PAGE},offset=${page * PAGE},sortBy=POSTING_DATES_DESC`;
    const data = await http.fetchJson(`${rest(p)}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`);
    const item = data.items?.[0] ?? {};
    const reqs = item.requisitionList ?? [];
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
  return jobs;
}

export async function detail(p, job, { http }) {
  const finder = `ById;Id="${job.id}",siteNumber=${p.site}`;
  const data = await http.fetchJson(`${rest(p)}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${encodeURIComponent(finder)}`);
  const d = data.items?.[0] ?? {};
  const parts = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr].filter(Boolean).map(htmlToText);
  return { description: parts.join('\n\n') };
}
