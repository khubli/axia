// Zerodha's own career site (careers.zerodha.com). Its page loads every open role, with its
// description, from one public list on the same host. Roles open in place on that one page,
// so each role's link is the page with the role's name after the #.

import { htmlToText } from '../text.mjs';

export const type = 'zerodha';

const ORIGIN = 'https://careers.zerodha.com';

export function match(url) {
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'careers.zerodha.com') return null;
  return { scope: 'zerodha' };
}

export async function list(_p, { http }) {
  const d = await http.fetchJson(`${ORIGIN}/api/jobs`);
  if (!Array.isArray(d?.data)) throw new Error('no job list from careers.zerodha.com');
  const jobs = [];
  const seen = new Set();
  for (const j of d.data) {
    const id = String(j.name ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const place = String(j.location ?? '').trim();
    jobs.push({
      id,
      title: String(j.job_title ?? '').replace(/\s+/g, ' ').trim(),
      location: place || (/remote/i.test(String(j.location_type ?? '')) ? 'Remote' : null),
      url: `${ORIGIN}/#${encodeURIComponent(id)}`,
      postedAt: null,
      description: htmlToText(String(j.description ?? '')),
    });
  }
  return jobs;
}
