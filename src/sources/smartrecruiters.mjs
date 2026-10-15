// SmartRecruiters (jobs.smartrecruiters.com/<company>). Listing has no description; one detail call per
// role we actually score.

import { htmlToText, toDay } from '../text.mjs';

const PAGE = 100;
const MAX_PAGES = 30;

export const type = 'smartrecruiters';

export function match(url) {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') id = parts[0];
  if (host === 'api.smartrecruiters.com') id = parts[parts.indexOf('companies') + 1];
  return id ? { id, scope: id.toLowerCase() } : null;
}

const base = (p) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(p.id)}/postings`;

export async function list(p, { http }) {
  const jobs = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await http.fetchJson(`${base(p)}?limit=${PAGE}&offset=${page * PAGE}`);
    const content = data.content ?? [];
    for (const j of content) {
      const loc = j.location ?? {};
      const location = loc.fullLocation || [loc.city, loc.region, loc.country?.toUpperCase()].filter(Boolean).join(', ') || null;
      jobs.push({
        id: String(j.id),
        title: j.name,
        location: loc.remote ? [location, 'Remote'].filter(Boolean).join(' · ') : location,
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(p.id)}/${j.id}`,
        postedAt: toDay(j.releasedDate),
      });
    }
    if (content.length < PAGE || (page + 1) * PAGE >= (data.totalFound ?? 0)) break;
  }
  return jobs;
}

export async function detail(p, job, { http }) {
  const data = await http.fetchJson(`${base(p)}/${encodeURIComponent(job.id)}`);
  const s = data.jobAd?.sections ?? {};
  const parts = [s.jobDescription, s.qualifications, s.additionalInformation]
    .filter((x) => x?.text)
    .map((x) => `${x.title ? x.title + '\n' : ''}${htmlToText(x.text)}`);
  return { description: parts.join('\n\n') };
}
