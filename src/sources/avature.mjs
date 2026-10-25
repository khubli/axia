// Avature career sites (<company>.avature.net/<portal>), such as Bloomberg's
// bloomberg.avature.net/careers. The portal has no public JSON feed, so its search pages
// are read: each lists a page of roles with title, link and location. The site decides the
// page size (Bloomberg's is 12, whatever is asked). A posting's text is read from its own
// page only when a role is about to be scored.

import { htmlToText } from '../text.mjs';

const ASK = 100; // asked for; the site may give fewer a page
const MAX_PAGES = 100;

export const type = 'avature';

export function match(url) {
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+\.avature\.net$/.test(host)) return null;
  const portal = url.pathname.split('/').filter(Boolean)[0];
  if (!portal) return null;
  return { origin: `https://${host}`, portal, scope: host };
}

const pageUrl = (p, offset) => `${p.origin}/${p.portal}/SearchJobs/?jobRecordsPerPage=${ASK}&jobOffset=${offset}`;

/** The roles on one search page, and the total the page reports. */
export function parsePage(html, p) {
  const totalText = html.match(/aria-label="(\d[\d,]*) results?"/i) ?? html.match(/\bof\s+(\d[\d,]*)\s+results?\b/i);
  const total = totalText ? Number(totalText[1].replace(/,/g, '')) : null;
  const jobs = [];
  // One block per role: from a JobDetail link to the next one.
  const linkRe = /<a\b[^>]*href="([^"]*\/JobDetail\/[^"]*?\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [...html.matchAll(linkRe)];
  for (let i = 0; i < links.length; i++) {
    const [, href, id, inner] = links[i];
    const title = htmlToText(inner).replace(/\s+/g, ' ').trim();
    if (!title || /^(apply|save)\b/i.test(title)) continue; // the Apply button repeats the link
    const block = html.slice(links[i].index, links[i + 1]?.index ?? html.length);
    const loc = block.match(/class="[^"]*list-item-location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    jobs.push({
      id,
      title,
      location: loc ? htmlToText(loc[1]).replace(/\s+/g, ' ').trim() || null : null,
      url: new URL(href.replace(/&amp;/g, '&'), `${p.origin}/`).href,
      postedAt: null, // the search pages give no posting date
    });
  }
  return { total, jobs };
}

export async function list(p, { http }) {
  const html = await http.fetchText(pageUrl(p, 0));
  const first = parsePage(html, p);
  if (first.total === null && first.jobs.length === 0 && !/No jobs found/i.test(html)) {
    throw new Error('no job list in the Avature search page');
  }
  const per = new Set(first.jobs.map((j) => j.id)).size;
  const pages = per ? Math.min(MAX_PAGES, Math.ceil((first.total ?? per) / per)) : 1;
  const rest = await http.mapLimit(Array.from({ length: pages - 1 }, (_, i) => (i + 1) * per), 4, async (offset) =>
    parsePage(await http.fetchText(pageUrl(p, offset)), p),
  );
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

export async function detail(p, job, { http }) {
  const html = await http.fetchText(job.url);
  // The posting text is the page's rich-text field: from its value to the next field or the
  // end of its section, so markup nested inside the text can't cut it short.
  const parts = [];
  for (const m of html.matchAll(/class="[^"]*field--rich-text[^"]*"[^>]*>/gi)) {
    const rest = html.slice(m.index + m[0].length);
    const end = rest.search(/<div class="article__content__view__field[\s"]|<\/article>/i);
    // Text pasted from Google Docs splits words across <span>s ("<span>A</span><span>bout"), so
    // spans are dropped without adding a space.
    const text = htmlToText((end >= 0 ? rest.slice(0, end) : rest).replace(/<\/?span\b[^>]*>/gi, '')).trim();
    if (text) parts.push(text);
  }
  if (!parts.length) throw new Error('no posting text on the Avature job page');
  return { description: parts.join('\n\n') };
}
