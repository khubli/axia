// Kula career sites (careers.kula.ai/<company>), used by Indian fintechs such as slice. The
// company's careers page reads a public list of its open roles, 100 a page, each with its full
// description, offices and launch date, so no posting reads are needed.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'kula';

const API = 'https://careers.kula.ai/api/internal/ats_job_posts';
const PAGE = 100; // the most the list gives per request
const MAX_PAGES = 50;

export function match(url) {
  if (url.hostname.toLowerCase() !== 'careers.kula.ai') return null;
  const account = url.pathname.split('/').filter(Boolean)[0];
  if (!account || account === 'api') return null;
  return { account, scope: account.toLowerCase() };
}

async function page(p, http, n) {
  const q = new URLSearchParams({ accountName: p.account, page: String(n), type: 'ats_job_post.index', items: String(PAGE) });
  const d = await http.fetchJson(`${API}?${q}`);
  if (!Array.isArray(d?.data)) throw new Error(`no job list from Kula for "${p.account}" (check the address)`);
  return { pages: Number(d.meta?.pages) || 1, jobs: d.data };
}

/** Every office a role is offered in, as the site writes it: "Bengaluru, Karnataka, India". */
function place(j) {
  const offices = (j.ats_job?.offices ?? []).map((o) => String(o?.location || [o?.city, o?.state, o?.country].filter(Boolean).join(', ')).trim()).filter(Boolean);
  return offices.length ? [...new Set(offices)].join('; ') : null;
}

export async function list(p, { http }) {
  const first = await page(p, http, 1);
  const rest = await http.mapLimit(Array.from({ length: Math.min(first.pages, MAX_PAGES) - 1 }, (_, i) => i + 2), 4, (n) => page(p, http, n));
  const jobs = [];
  const seen = new Set();
  for (const j of [first, ...rest].flatMap((x) => x.jobs)) {
    const id = String(j.id ?? '');
    if (!id || seen.has(id) || j.listed === false || j.on_career_page === false) continue;
    seen.add(id);
    jobs.push({
      id,
      title: String(j.title ?? '').trim(),
      location: place(j),
      url: `https://careers.kula.ai/${encodeURIComponent(p.account)}/${id}`,
      postedAt: toDay(j.launch_at),
      description: htmlToText(String(j.ats_job?.job_description ?? '')),
    });
  }
  return jobs;
}
