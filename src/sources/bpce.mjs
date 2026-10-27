// Groupe BPCE's career sites: recrutement.natixis.com (Natixis CIB and the other Global
// Financial Services brands) and recrutement.bpce.fr (the whole group), recognised from the address.
//
// Their pages search through a public JSON endpoint (/app/wp-json/bpce/v1/search/jobs) that
// returns each role with its full description, so no posting is read separately. The site's
// own filters carry over from the address: `?tax_place=inde` reads only the roles in India.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'bpce';

const PAGE = 50;
const MAX_JOBS = 5000;

export function match(url) {
  const host = url.hostname.toLowerCase();
  if (host !== 'recrutement.natixis.com' && host !== 'recrutement.bpce.fr' && !host.endsWith('.recrutement.bpce.fr')) return null;
  const filters = {};
  for (const [k, v] of url.searchParams) if ((k.startsWith('tax_') || k === 'keyword') && v) filters[k] = v;
  return { origin: url.origin, filters, scope: host };
}

async function search(p, http, from) {
  const d = await http.fetchJson(`${p.origin}/app/wp-json/bpce/v1/search/jobs`, {
    method: 'POST',
    body: { ...p.filters, from, size: PAGE },
  });
  if (!Array.isArray(d?.data?.items)) throw new Error(`no job list from ${new URL(p.origin).host}`);
  return { total: Number(d.data.total) || 0, items: d.data.items };
}

/** "Mumbai, Inde": each place's city and region. */
const place = (j) =>
  (j.localisations ?? [])
    .map((l) => [l.city, l.region].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ') || j.localisation || null;

export async function list(p, { http }) {
  const jobs = [];
  const seen = new Set();
  for (let from = 0; from < MAX_JOBS; from += PAGE) {
    const { total, items } = await search(p, http, from);
    for (const j of items) {
      const id = String(j.job_number ?? j.post_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const link = j.link?.url ?? '';
      jobs.push({
        id,
        title: htmlToText(String(j.title ?? '')),
        location: place(j),
        url: /^https?:/.test(link) ? link : `${p.origin}${link}`,
        postedAt: toDay(j.date),
        description: htmlToText(String(j.description ?? '')),
      });
    }
    if (items.length < PAGE || from + PAGE >= total) break;
  }
  return jobs;
}
