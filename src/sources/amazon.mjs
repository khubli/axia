// Amazon (amazon.jobs). The search page reads from a public JSON endpoint that returns
// each role with its description, so no posting reads are needed.
// Filters on the configured address carry over, e.g. https://www.amazon.jobs/en/search?country=IND
// reads only Amazon's roles in India (about 2,300 instead of 10,000+).

import { htmlToText, toDay } from '../text.mjs';

export const type = 'amazon';

const PAGE = 100;
const MAX_JOBS = 10000; // the endpoint stops at 10,000 results

export function match(url) {
  if (!/^(www\.)?amazon\.jobs$/i.test(url.hostname)) return null;
  const filters = [...url.searchParams].filter(([k]) => !['offset', 'result_limit', 'sort'].includes(k));
  return { filters, scope: 'amazon' };
}

function pageUrl(p, offset) {
  const q = new URLSearchParams(p.filters);
  q.set('result_limit', String(PAGE));
  q.set('offset', String(offset));
  q.set('sort', 'recent');
  return `https://www.amazon.jobs/en/search.json?${q}`;
}

export async function list(p, { http }) {
  const first = await http.fetchJson(pageUrl(p, 0));
  if (!Array.isArray(first?.jobs)) throw new Error('no job list in the answer from amazon.jobs');
  const total = Math.min(MAX_JOBS, Number(first.hits) || 0);
  const offsets = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
  const rest = await http.mapLimit(offsets, 4, (o) => http.fetchJson(pageUrl(p, o)));
  const jobs = [];
  const seen = new Set();
  for (const data of [first, ...rest]) {
    for (const j of data.jobs ?? []) {
      const id = String(j.id_icims ?? j.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      jobs.push({
        id,
        title: j.title,
        location: j.normalized_location || j.location || null,
        url: `https://www.amazon.jobs${j.job_path}`,
        postedAt: j.posted_date ? toDay(`${j.posted_date} UTC`) : null, // "October 18, 2026"
        description: [
          htmlToText(j.description),
          j.basic_qualifications && `Basic qualifications\n${htmlToText(j.basic_qualifications)}`,
          j.preferred_qualifications && `Preferred qualifications\n${htmlToText(j.preferred_qualifications)}`,
        ].filter(Boolean).join('\n\n'),
      });
    }
  }
  return jobs;
}
