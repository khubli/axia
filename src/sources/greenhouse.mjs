// Greenhouse job boards (job-boards.greenhouse.io/<company>). One call returns every
// posting with its full description (`content=true`), so no detail step.

import { htmlToText, toDay } from '../text.mjs';

export const type = 'greenhouse';

export function match(url) {
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)greenhouse\.io$/.test(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let token = url.searchParams.get('for');
  if (!token && host.startsWith('boards-api.')) token = parts[parts.indexOf('boards') + 1];
  if (!token && (host.startsWith('boards.') || host.startsWith('job-boards.'))) token = parts[0] === 'embed' ? null : parts[0];
  return token ? { token, scope: token.toLowerCase() } : null;
}

export async function list(p, { http }) {
  const data = await http.fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(p.token)}/jobs?content=true`);
  return (data.jobs ?? []).map((j) => ({
    id: String(j.id),
    title: String(j.title ?? '').trim(),
    location: j.location?.name || null,
    url: j.absolute_url,
    postedAt: toDay(j.first_published ?? j.updated_at),
    description: htmlToText(j.content),
  }));
}
