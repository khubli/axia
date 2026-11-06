// Scout career sites (scout.<company>.in/careers?org=<company>), the in-house hiring system of
// Dezerv. The company's careers page loads every open role, each with its full description and
// posting date, from one public list on the Scout host, so one request reads the whole site.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'scout';

export function match(url) {
  const host = url.hostname.toLowerCase();
  if (!host.startsWith('scout.')) return null;
  const org = url.searchParams.get('org');
  if (!org) return null;
  return { origin: `https://${host}`, org, scope: `${host}:${org.toLowerCase()}` };
}

/** Scout descriptions are plain text with line breaks; HTML is read as HTML in case that changes. */
const textOf = (s) => (/<\/?[a-z][^>]*>/i.test(s) ? htmlToText(s) : s.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());

export async function list(p, { http }) {
  const d = await http.fetchJson(`${p.origin}/api/public/careers?org=${encodeURIComponent(p.org)}`);
  if (d?.ok === false || !Array.isArray(d?.jobs)) throw new Error(`no job list from ${new URL(p.origin).host} for "${p.org}" (check the address's org=)`);
  const jobs = [];
  const seen = new Set();
  for (const j of d.jobs) {
    const id = String(j.id ?? '');
    if (!id || seen.has(id) || j.isAcceptingApplications === false || (j.status && j.status !== 'open')) continue;
    seen.add(id);
    jobs.push({
      id,
      title: String(j.title ?? '').trim(),
      location: String(j.location ?? '').trim() || null,
      url: `${p.origin}/careers/jobs/${encodeURIComponent(id)}?org=${encodeURIComponent(p.org)}`,
      postedAt: toDay(j.publishedAt),
      description: textOf(String(j.description ?? '')),
    });
  }
  return jobs;
}
