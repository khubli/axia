// Ashby job boards (jobs.ashbyhq.com/<org>). Not used by today's list, but
// common enough that adding such a company should just work.

import { toDay } from '../text.mjs';

export const type = 'ashby';

export function match(url) {
  if (url.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null;
  const org = url.pathname.split('/').filter(Boolean)[0];
  return org ? { org, scope: org.toLowerCase() } : null;
}

export async function list(p, { http }) {
  const data = await http.fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(p.org)}`);
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: j.id,
      title: j.title,
      location: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean).join('; ') || null,
      url: j.jobUrl,
      postedAt: toDay(j.publishedAt),
      description: j.descriptionPlain ?? '',
    }));
}
