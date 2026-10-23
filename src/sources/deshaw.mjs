// The D. E. Shaw group's own career sites: www.deshaw.com (global) and www.deshawindia.com
// (D. E. Shaw India, in Hyderabad, Bengaluru and Gurugram). The careers page carries every
// open role, with its description, as data inside the page, so one request reads the lot.

import { htmlToText } from '../text.mjs';

export const type = 'deshaw';

export function match(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'deshaw.com' && host !== 'deshawindia.com') return null;
  return { origin: `https://www.${host}`, india: host === 'deshawindia.com', scope: host };
}

/** The page's Next.js data: { regularJobs: [...] }. */
export function pageData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no job data in the D. E. Shaw careers page');
  const props = JSON.parse(m[1])?.props?.pageProps;
  if (!Array.isArray(props?.regularJobs)) throw new Error('no job list in the D. E. Shaw careers page');
  return props;
}

function describe(d = {}) {
  const people = d.peopleWeAreLookingForHtml ? htmlToText(d.peopleWeAreLookingForHtml) : d.peopleWeAreLookingForStr;
  const resp = d.responsibilitiesHtml ? htmlToText(d.responsibilitiesHtml) : d.responsibilities;
  return [d.websiteDescription, resp, people].filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).join('\n\n');
}

export async function list(p, { http }) {
  const { regularJobs } = pageData(await http.fetchText(`${p.origin}/careers`));
  const jobs = [];
  const seen = new Set();
  for (const j of regularJobs) {
    const d = j.data ?? {};
    // "All positions in Financial Operations" and the like are open applications, not roles.
    if (d.jobMetadata?.isExploratory === true || /^All positions\b/i.test(j.displayName ?? '')) continue;
    const id = String(j.id ?? d.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const offices = (j.office ?? d.jobMetadata?.jobLocations ?? []).map((o) => o?.name).filter(Boolean);
    jobs.push({
      id,
      title: String(j.displayName ?? d.displayName ?? '').replace(/\s+/g, ' ').trim(),
      // The India site names only the city; add the country so "Gurugram" reads as India too.
      location: offices.length ? offices.map((o) => (p.india ? `${o}, India` : o)).join('; ') : null,
      url: `${p.origin}/careers/${d.jobUrl ? encodeURIComponent(d.jobUrl) : id}`,
      postedAt: null, // the page gives no posting date
      description: describe(d.jobDescription),
    });
  }
  return jobs;
}
