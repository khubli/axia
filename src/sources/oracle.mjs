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

// The API returns nothing past offset 10,000, so on a site listing more than that (Kotak
// Mahindra Bank lists about 11,600) the older postings are read by posting date as well.
const OFFSET_CAP = PAGE * MAX_PAGES;
const EARLIEST = '2000-01-01';

async function readList(p, http, window = '', { splittable = false } = {}) {
  const jobs = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const finder = `findReqs;siteNumber=${p.site},facetsList=NONE,limit=${PAGE},offset=${page * PAGE},sortBy=POSTING_DATES_DESC${window}`;
    const data = await http.fetchJson(`${rest(p)}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`);
    const item = data.items?.[0] ?? {};
    const reqs = item.requisitionList ?? [];
    if (page === 0) total = item.TotalJobsCount ?? 0;
    if (splittable && total > OFFSET_CAP) return { jobs: [], total }; // the caller splits it instead
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
    // Pages often come back short (Oracle drops some postings after paging), so only an empty
    // page or the end of the count ends the list.
    if (reqs.length === 0 || (page + 1) * PAGE >= (item.TotalJobsCount ?? 0)) break;
  }
  return { jobs, total };
}

const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
const dayString = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/** Every posting from `from` to `to` (whole days), halved until each part fits under the cap. */
async function readDays(p, http, from, to) {
  // A single day over 10,000 can't be split further: its newest 10,000 are read.
  const { jobs, total } = await readList(p, http, `,postingStartDate=${from},postingEndDate=${to}`, { splittable: from !== to });
  if (total <= OFFSET_CAP || from === to) return jobs;
  const mid = Math.floor((dayNumber(from) + dayNumber(to)) / 2);
  return [...(await readDays(p, http, from, dayString(mid))), ...(await readDays(p, http, dayString(mid + 1), to))];
}

export async function list(p, { http }) {
  const { jobs, total } = await readList(p, http);
  if (total <= OFFSET_CAP) return jobs;
  // The newest 10,000 are in; the rest are older. Read everything posted up to the oldest
  // day reached, that day included, since it may have been read only in part.
  const oldest = jobs.map((j) => j.postedAt).filter(Boolean).sort()[0];
  if (!oldest) return jobs;
  const seen = new Set(jobs.map((j) => j.id));
  for (const j of await readDays(p, http, EARLIEST, oldest)) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    jobs.push(j);
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
