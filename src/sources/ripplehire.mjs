// RippleHire career sites (<company>.ripplehire.com), such as Axis Bank's. The address is the
// one the employer's careers page links to: /candidate/?token=…&source=CAREERSITE. The token
// names the company's public job list, so no login is needed.
//
// The pages load their roles from two public endpoints: candidatejobsearch (the list, a
// page at a time, without descriptions or dates) and candidatejobdetail (one role, with its
// description and posting date).

import { htmlToText, toDay } from '../text.mjs';

export const type = 'ripplehire';

const PAGE = 1000;
const MAX_JOBS = 20000; // Axis Bank lists over 10,000

export function match(url) {
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.ripplehire.com')) return null;
  const token = url.searchParams.get('token');
  if (!token) return null;
  return { origin: `https://${host}`, token, source: url.searchParams.get('source') || 'CAREERSITE', scope: host };
}

const api = (p, path, query) => `${p.origin}/candidate/${path}?${new URLSearchParams({ ...query, lang: 'en' })}`;

async function page(p, http, n) {
  const params = { page: n, search: '*:*', token: p.token, source: p.source, pagesize: PAGE };
  const d = await http.fetchJson(api(p, 'candidatejobsearch', { careerSiteUrlParams: JSON.stringify(params) }));
  if (d?.errorStatus !== 'success' || !Array.isArray(d.jobVoList ?? [])) throw new Error(`no job list from ${new URL(p.origin).host} (is the token in the address still current?)`);
  return { total: Number(d.totalJobCount) || 0, jobs: d.jobVoList ?? [] };
}

export async function list(p, { http }) {
  const jobs = [];
  const seen = new Set();
  for (let n = 0; n * PAGE < MAX_JOBS; n++) {
    const { total, jobs: batch } = await page(p, http, n);
    for (const j of batch) {
      const id = String(j.jobSeq ?? j.jobId ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      jobs.push({
        id,
        // Axis titles start with the team: "IT:Head - Technology Solution".
        title: String(j.jobTitle ?? '').trim(),
        location: j.locations || j.jobLocation || null,
        url: `${p.origin}/candidate/?token=${encodeURIComponent(p.token)}&source=${encodeURIComponent(p.source)}#detail/job/${id}`,
        postedAt: null, // only the role's own page has it; see detail()
      });
    }
    if (batch.length < PAGE || (n + 1) * PAGE >= total) break;
  }
  return jobs;
}

export async function detail(p, job, { http }) {
  const d = await http.fetchJson(api(p, 'candidatejobdetail', { token: p.token, jobSeq: job.id, source: p.source }));
  const v = d?.jobVO ?? {};
  const skills = v.jobSkills && !/^refer to the job description$/i.test(v.jobSkills.trim()) ? `Skills: ${v.jobSkills}` : '';
  return {
    description: [htmlToText(String(v.jobDesc ?? '')), skills].filter(Boolean).join('\n\n'),
    postedAt: toDay(v.publishDetails?.CAREER_SITE) ?? toDay(v.jobPostingDate),
  };
}
