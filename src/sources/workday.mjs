// Workday career sites (*.myworkdayjobs.com). Uses the same JSON endpoints the
// career site itself calls. 20 postings per page is Workday's hard maximum.

import { htmlToText, toDay } from '../text.mjs';

const PAGE = 20;
const MAX_PAGES = 150; // 3,000 postings — far above any single site we track

export const type = 'workday';

export function match(url) {
  const m = url.hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
  if (!m) return null;
  const parts = url.pathname.split('/').filter(Boolean).filter((p) => !/^[a-z]{2}-[a-z]{2}$/i.test(p));
  const site = parts[0];
  if (!site) return null;
  const tenant = m[1].toLowerCase();
  // Scope on host+tenant, not site: one requisition published on two sites of the
  // same tenant (some employers do this) must count once.
  return { host: url.hostname.toLowerCase(), tenant, site, scope: tenant };
}

const api = (p) => `https://${p.host}/wday/cxs/${p.tenant}/${p.site}`;

export async function list(p, { http, today }) {
  const fetchPage = (page) =>
    http.fetchJson(`${api(p)}/jobs`, {
      method: 'POST',
      body: { appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText: '' },
    });
  // Workday only reports `total` reliably on the first page; the rest are then
  // fetched a few at a time (polite, and ~4x faster than one by one).
  const first = await fetchPage(0);
  const pages = Math.min(MAX_PAGES, Math.ceil((Number(first.total) || 0) / PAGE));
  const rest = await http.mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 1), 4, fetchPage);

  const jobs = [];
  const seen = new Set();
  for (const data of [first, ...rest]) {
    for (const j of data.jobPostings ?? []) {
      if (!j.externalPath || seen.has(j.externalPath)) continue;
      seen.add(j.externalPath);
      const id = reqId(j);
      const multi = /^\d+\s+locations?$/i.test(j.locationsText ?? '');
      jobs.push({
        id,
        title: j.title,
        location: multi ? null : j.locationsText || null,
        url: `https://${p.host}/en-US/${p.site}${j.externalPath}`,
        postedAt: postedOnToDay(j.postedOn, today),
        ref: { externalPath: j.externalPath, locationsText: j.locationsText },
      });
    }
  }
  return jobs;
}

export async function detail(p, job, { http }) {
  const data = await http.fetchJson(`${api(p)}${job.ref.externalPath}`);
  const info = data.jobPostingInfo ?? {};
  const locations = [info.location, ...(info.additionalLocations ?? [])].filter(Boolean);
  return {
    description: htmlToText(info.jobDescription),
    location: locations.length ? locations.join('; ') : undefined,
    postedAt: toDay(info.startDate) ?? undefined,
  };
}

function reqId(j) {
  // externalPath ends in "_<requisition id>" (sometimes with a "-1" repost suffix,
  // which we keep: a repost is a new posting on the board).
  const tail = j.externalPath.split('/').pop() ?? '';
  const idx = tail.lastIndexOf('_');
  return idx >= 0 ? tail.slice(idx + 1) : (j.bulletFields?.[0] ?? tail);
}

export function postedOnToDay(text, today) {
  if (!text || !today) return null;
  const t = text.toLowerCase();
  const base = new Date(`${today}T00:00:00Z`);
  let days = null;
  if (t.includes('today')) days = 0;
  else if (t.includes('yesterday')) days = 1;
  else {
    const m = t.match(/(\d+)\+?\s+days?\s+ago/);
    if (m && !t.includes('+')) days = Number(m[1]);
  }
  if (days === null) return null;
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}
