// TurboHire career sites (<company>.turbohire.co), used by many Indian startups and
// fintechs, e.g. https://navi.turbohire.co/dashboardv2. The site's own page reads a public
// API: an anonymous token, the company's organization record, then every open role in one
// answer with its description, so no posting reads are needed.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'turbohire';

// The API host TurboHire's career pages use (it is the production host despite its name).
const API = 'https://thapi-stage2.azurewebsites.net/api';

export function match(url) {
  const m = url.hostname.toLowerCase().match(/^([a-z0-9-]+)\.turbohire\.co$/);
  if (!m || ['www', 'app', 'identity'].includes(m[1])) return null;
  return { account: m[1], site: `https://${m[1]}.turbohire.co`, scope: `${m[1]}.turbohire.co` };
}

/** "[{\"Address\":\"Bengaluru, Karnataka, India\"}]" (a JSON string) or an array → "Bengaluru, Karnataka, India". */
export function placesOf(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return raw.trim() || null;
    }
  }
  const places = (Array.isArray(list) ? list : []).map((l) => String(l?.Address ?? l ?? '').trim()).filter(Boolean);
  return places.length ? [...new Set(places)].join('; ') : null;
}

export async function list(p, { http }) {
  // The API only answers requests that come from the company's own career site.
  const headers = { Origin: p.site, Referer: `${p.site}/` };
  const token = (await http.fetchJson(`${API}/token/noauth`, { headers }))?.access_token;
  if (!token) throw new Error(`no access token from TurboHire for ${p.scope}`);
  const auth = { ...headers, Authorization: `Bearer ${token}` };

  const org = await http.fetchJson(`${API}/publicorganizations?accountName=${encodeURIComponent(p.account)}`, { headers: auth }).catch(() => null);
  if (!org?.OrgID) throw new Error(`no TurboHire career site named "${p.account}" (check the address)`);

  const data = await http.fetchJson(`${API}/careerpagev2/filteredjobs?orgId=${org.OrgID}&pageType=0`, {
    method: 'POST',
    headers: auth,
    body: { SortByV2: { Key: 'PostedDate', Order: 2 }, Keyword: '', Department: '', CustomFields: {} },
  });
  if (!Array.isArray(data?.Result)) throw new Error('no job list in the answer from TurboHire');

  const jobs = [];
  const seen = new Set();
  for (const j of data.Result) {
    const id = String(j.JobId ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    jobs.push({
      id,
      title: String(j.JobTitle ?? '').trim(),
      location: placesOf(j.Location),
      // JobIdObfuscated comes URL-encoded already ("F%2F5iro…").
      url: j.JobIdObfuscated ? `${p.site}/job/publicjobs/${j.JobIdObfuscated}` : `${p.site}/dashboardv2`,
      postedAt: j.PublishedDate ? toDay(j.PublishedDate) : null,
      description: htmlToText(j.JobDescV2 ?? ''),
    });
  }
  return jobs;
}
