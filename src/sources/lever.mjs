// Lever job boards (jobs.lever.co/<company>). Not used by today's list, but
// common enough that adding such a company should just work.

import { toDay } from '../text.mjs';

export const type = 'lever';

export function match(url) {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') return { company: parts[0], eu: host.includes('.eu.'), scope: parts[0]?.toLowerCase() };
  if (host === 'api.lever.co' || host === 'api.eu.lever.co') return { company: parts[parts.indexOf('postings') + 1], eu: host.includes('.eu.'), scope: parts[parts.indexOf('postings') + 1]?.toLowerCase() };
  return null;
}

export async function list(p, { http }) {
  const data = await http.fetchJson(`https://api${p.eu ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(p.company)}?mode=json`);
  return (Array.isArray(data) ? data : []).map((j) => ({
    id: j.id,
    title: j.text,
    location: (j.categories?.allLocations ?? [j.categories?.location]).filter(Boolean).join('; ') || null,
    url: j.hostedUrl,
    postedAt: toDay(j.createdAt),
    description: [j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text}\n${String(l.content ?? '').replace(/<[^>]+>/g, ' ')}`), j.additionalPlain]
      .filter(Boolean)
      .join('\n\n'),
  }));
}
