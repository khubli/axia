// Keka Hire career sites (<company>.keka.com/careers). The careers page names the company's
// portal id; its job widget then loads every open role, each with its full description and
// posting date, from one public list for that id.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'keka';

export function match(url) {
  const m = url.hostname.toLowerCase().match(/^([a-z0-9-]+)\.keka\.com$/);
  if (!m || m[1] === 'www' || m[1] === 'app') return null;
  return { origin: `https://${m[1]}.keka.com`, scope: `${m[1]}.keka.com` };
}

/** The portal id on the careers page ("/ats/documents/<id>/careerportal/…" or "identifier: '<id>'"). */
export function portalId(html) {
  const m = html.match(/\/ats\/documents\/([0-9a-f-]{36})\/careerportal\//i) ?? html.match(/identifier\s*:\s*['"]([0-9a-f-]{36})['"]/i);
  if (!m) throw new Error('no job portal id in the Keka careers page (check the address)');
  return m[1].toLowerCase();
}

const placeOf = (l) => [l?.city || l?.name, l?.countryName].filter(Boolean).join(', ');

export async function list(p, { http }) {
  const id = portalId(await http.fetchText(`${p.origin}/careers/`));
  const data = await http.fetchJson(`${p.origin}/careers/api/embedjobs/default/active/${id}`);
  if (!Array.isArray(data)) throw new Error(`no job list from ${new URL(p.origin).host}`);
  const jobs = [];
  const seen = new Set();
  for (const j of data) {
    const jobId = String(j.id ?? '').trim();
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    const places = [...new Set((Array.isArray(j.jobLocations) ? j.jobLocations : []).map(placeOf).filter(Boolean))];
    jobs.push({
      id: jobId,
      title: String(j.title ?? '').replace(/\s+/g, ' ').trim(),
      location: places.length ? places.join('; ') : null,
      url: `${p.origin}/careers/jobdetails/${encodeURIComponent(jobId)}`,
      postedAt: toDay(j.publishedOn),
      description: htmlToText(String(j.description ?? '')),
    });
  }
  return jobs;
}
