// Talentsoft (Cegid) career sites, such as jobs.ca-cib.com. Sites on <company>.talent-soft.com are
// recognised on their own; on the employer's own domain, companies.yml names the platform:
// `platform: talentsoft`.
//
// Every Talentsoft site publishes its roles as an RSS feed (/handlers/offerRss.ashx), each with
// its full description, so one request reads the whole list and no posting is read separately.
// The site's search filters carry over from the address: a list page filtered by country
// (`?facet_JobCountry=96`) reads only that country's roles, and so does the feed's own
// `Rss_JobCountry=96`.

import { decodeEntities, htmlToText, toDay } from '../text.mjs';

export const type = 'talentsoft';

const MAX_JOBS = 2000; // the feed gives 20 roles unless asked for more

export function match(url, { platform } = {}) {
  const host = url.hostname.toLowerCase();
  if (platform !== type && !host.endsWith('.talent-soft.com')) return null;
  const filters = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!v) continue;
    if (/^LCID$/i.test(k) || /^Rss_/.test(k)) filters.append(k === 'lcid' ? 'LCID' : k, v);
    else if (/^facet_/.test(k)) filters.append(`Rss_${k.slice('facet_'.length)}`, v);
  }
  if (!filters.has('LCID')) filters.set('LCID', '2057'); // English
  return { origin: url.origin, filters: filters.toString(), scope: host };
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : '';
};

/** "City : Mumbai" in the description (or "Ville :", "Localisation :"), else the feed's last category. */
function place(description, categories) {
  const m = description.match(/<b>\s*(?:City|Ville|Location|Localisation|Lieu)[^<:]*:\s*<\/b>\s*([^<]+)/i);
  const city = (m ? m[1] : categories.at(-1) ?? '').replace(/\s+/g, ' ').trim();
  return city || null;
}

export async function list(p, { http }) {
  const q = new URLSearchParams(p.filters);
  q.set('top', String(MAX_JOBS));
  const xml = await http.fetchText(`${p.origin}/handlers/offerRss.ashx?${q}`);
  if (!/<rss[\s>]/i.test(xml)) throw new Error(`no job feed from ${new URL(p.origin).host} (is this a Talentsoft career site?)`);
  const jobs = [];
  const seen = new Set();
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const url = tag(item, 'link');
    const id = url.match(/[?&]idOffre=(\d+)/i)?.[1] ?? url;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const description = tag(item, 'description');
    const categories = [...item.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((m) => decodeEntities(m[1]).trim());
    jobs.push({
      id,
      // "2026-115049 - Senior IT Team Manager": the reference number leads each title.
      title: tag(item, 'title').replace(/^\d{4}-\d+\s*-\s*/, ''),
      location: place(description, categories),
      url,
      postedAt: toDay(tag(item, 'pubDate').replace(/ Z$/, ' GMT')),
      description: htmlToText(description),
    });
  }
  return jobs;
}
