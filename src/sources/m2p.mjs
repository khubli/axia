// M2P Fintech's own career site (careers.m2pfintech.com). Its jobs page loads every open role
// from one public list on the same host; each role's page then loads its description by id.

import { decodeEntities, htmlToText } from '../text.mjs';

export const type = 'm2p';

const ORIGIN = 'https://careers.m2pfintech.com';

export function match(url) {
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'careers.m2pfintech.com') return null;
  return { scope: 'm2pfintech' };
}

/** "05-11-2026 18:07:55" (day first) → "2026-11-05". */
export function dayOf(s) {
  const m = String(s ?? '').match(/^(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** "Chennai, Tamil Nadu, India (CHE)" → "Chennai, Tamil Nadu, India": the bracket is an office code. */
const place = (s) => String(s ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();

export async function list(_p, { http }) {
  const d = await http.fetchJson(`${ORIGIN}/api/job-list`);
  if (!Array.isArray(d?.data)) throw new Error('no job list from careers.m2pfintech.com');
  const jobs = [];
  const seen = new Set();
  for (const j of d.data) {
    const id = String(j.job_id ?? '').trim();
    if (!id || seen.has(id) || j.post_on_careers_page === 0) continue;
    seen.add(id);
    const places = [...new Set((Array.isArray(j.location) ? j.location : [j.location]).map(place).filter(Boolean))];
    jobs.push({
      id,
      title: String(j.job_title ?? '').replace(/\s+/g, ' ').trim(),
      location: places.length ? places.join('; ') : null,
      url: `${ORIGIN}/job-description/${encodeURIComponent(id)}/`,
      postedAt: dayOf(j.job_created_timestamp),
    });
  }
  return jobs;
}

export async function detail(_p, job, { http }) {
  const d = await http.fetchJson(`${ORIGIN}/api/job-details?job_id=${encodeURIComponent(job.id)}`);
  // The description comes as escaped HTML ("&lt;div&gt;…"), so unescape it before reading it as HTML.
  const html = decodeEntities(String(d?.data?.job_decription ?? ''));
  return { description: htmlToText(html) };
}
