// iCIMS career sites built on Jibe, on the employer's own domain such as careers.axa.com or
// jobs.aon.com. The address can't tell them apart from any other site, so companies.yml
// names the platform: `platform: jibe`.
//
// The site's own pages read a public /api/jobs list, 100 roles a page, each with its full
// description, so no posting reads are needed. Terms on the configured address carry over
// as the site's own filters: `?location=India` reads only the roles the site places in India.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'jibe';

const PAGE = 100;
const MAX_JOBS = 5000;

export function match(url, { platform } = {}) {
  if (platform !== type) return null;
  // Postings live under the list's own path: /careers-home/jobs → /careers-home/jobs/<id>.
  const at = url.pathname.search(/\/jobs(\/|$)/);
  const jobsPath = at >= 0 ? url.pathname.slice(0, at + '/jobs'.length) : '/jobs';
  const filters = new URLSearchParams(url.searchParams);
  for (const k of ['page', 'limit']) filters.delete(k);
  return { origin: url.origin, jobsPath, filters: filters.toString(), scope: url.host.toLowerCase() };
}

function pageUrl(p, page) {
  const q = new URLSearchParams(p.filters);
  q.set('page', String(page));
  q.set('limit', String(PAGE));
  return `${p.origin}/api/jobs?${q}`;
}

async function fetchPage(p, http, page) {
  const d = await http.fetchJson(pageUrl(p, page));
  if (!Array.isArray(d?.jobs)) throw new Error(`no job list from ${new URL(p.origin).host} (is this an iCIMS Jibe career site?)`);
  return { total: Number(d.totalCount) || 0, jobs: d.jobs.map((j) => j?.data ?? j) };
}

/** Every place a role is offered: the site's own summary, else city and country. */
function place(j) {
  if (j.full_location) return String(j.full_location).trim();
  const one = [j.city, j.state, j.country].filter(Boolean).join(', ');
  return one || j.location_name || null;
}

export async function list(p, { http }) {
  const first = await fetchPage(p, http, 1);
  const size = first.jobs.length;
  const total = Math.min(MAX_JOBS, first.total);
  const pages = [];
  for (let n = 2; size && (n - 1) * size < total; n++) pages.push(n);
  const rest = await http.mapLimit(pages, 4, (n) => fetchPage(p, http, n));
  const jobs = [];
  const seen = new Set();
  for (const page of [first, ...rest]) {
    for (const j of page.jobs) {
      const id = String(j.req_id ?? j.slug ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      jobs.push({
        id,
        title: String(j.title ?? '').trim(),
        location: place(j),
        url: `${p.origin}${p.jobsPath}/${encodeURIComponent(j.slug ?? id)}`,
        postedAt: toDay(j.posted_date),
        description: htmlToText(String(j.description ?? '')),
      });
    }
  }
  return jobs;
}
