// Google (google.com/about/careers). The results page carries its roles, with their
// descriptions, as data inside the HTML, 20 a page. Filters on the configured address
// carry over, e.g. .../jobs/results?location=India reads only Google's roles in India.

import { htmlToText } from '../text.mjs';

export const type = 'google';

const MAX_PAGES = 100; // 2,000 roles

const BASE = 'https://www.google.com/about/careers/applications/jobs/results';

export function match(url) {
  if (!/^(www\.)?google\.com$/i.test(url.hostname) || !url.pathname.startsWith('/about/careers')) return null;
  const filters = [...url.searchParams].filter(([k]) => k !== 'page');
  return { filters, scope: 'google' };
}

/** The roles inside one results page, and the total the page reports. Throws when the data is missing. */
export function parsePage(html) {
  const at = html.indexOf("AF_initDataCallback({key: 'ds:1'");
  const start = at < 0 ? -1 : html.indexOf('data:', at);
  const end = start < 0 ? -1 : html.indexOf(', sideChannel:', start);
  if (end < 0) throw new Error('no job data on the Google careers page (has the page changed?)');
  const data = JSON.parse(html.slice(start + 5, end));
  const rows = Array.isArray(data?.[0]) ? data[0] : [];
  const jobs = rows.map((r) => ({
    id: String(r[0]),
    title: r[1],
    location: (r[9] ?? []).map((l) => l?.[0]).filter(Boolean).join('; ') || null,
    url: `${BASE}/${r[0]}`,
    postedAt: Number.isFinite(r[12]?.[0]) ? new Date(r[12][0] * 1000).toISOString().slice(0, 10) : null,
    description: [r[10]?.[1], r[3]?.[1] && `<h3>Responsibilities</h3>${r[3][1]}`, r[4]?.[1]] // about, responsibilities, qualifications
      .filter(Boolean)
      .map(htmlToText)
      .join('\n\n'),
  }));
  return { total: Number(data[2]) || jobs.length, perPage: Number(data[3]) || 20, jobs };
}

function pageUrl(p, page) {
  const q = new URLSearchParams(p.filters);
  q.set('page', String(page));
  return `${BASE}?${q}`;
}

export async function list(p, { http }) {
  const first = parsePage(await http.fetchText(pageUrl(p, 1)));
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / first.perPage));
  const rest = await http.mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 4, async (n) => parsePage(await http.fetchText(pageUrl(p, n))));
  const jobs = [];
  const seen = new Set();
  for (const page of [first, ...rest]) {
    for (const j of page.jobs) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      jobs.push(j);
    }
  }
  return jobs;
}
