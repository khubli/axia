// Goldman Sachs (higher.gs.com). The career site is a single-page app, but it
// reads from a public GraphQL API that returns every role with its description.

import { htmlToText, toDay } from '../text.mjs';

const ENDPOINT = 'https://api-higher.gs.com/gateway/api/v1/graphql';
const PAGE = 100;
const MAX_PAGES = 30;

const QUERY = `query GetRoles($searchQueryInput: RoleSearchQueryInput!) {
  roleSearch(searchQueryInput: $searchQueryInput) {
    totalCount
    items {
      roleId jobTitle corporateTitle status lastPostedDate descriptionHtml
      locations { primary city state country }
      externalSource { sourceId }
    }
  }
}`;

export const type = 'goldman';

export function match(url) {
  return /(^|\.)higher\.gs\.com$/i.test(url.hostname) ? { scope: 'gs' } : null;
}

export async function list(_p, { http }) {
  const jobs = [];
  let total = Infinity;
  for (let page = 0; page < MAX_PAGES && page * PAGE < total; page++) {
    const data = await http.fetchJson(ENDPOINT, {
      method: 'POST',
      body: {
        operationName: 'GetRoles',
        query: QUERY,
        variables: {
          searchQueryInput: {
            page: { pageSize: PAGE, pageNumber: page },
            sort: { sortStrategy: 'POSTED_DATE', sortOrder: 'DESC' },
            filters: [],
            experiences: ['EARLY_CAREER', 'PROFESSIONAL'],
            searchTerm: '',
          },
        },
      },
    });
    if (data.errors?.length) throw new Error(`Goldman Sachs API: ${data.errors[0].message}`);
    const result = data.data?.roleSearch ?? {};
    total = Number(result.totalCount) || 0;
    const items = result.items ?? [];
    if (items.length === 0) break;
    for (const r of items) {
      const id = r.externalSource?.sourceId ?? r.roleId;
      const locs = [...(r.locations ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary));
      jobs.push({
        id: String(id),
        title: r.jobTitle,
        location: locs.map((l) => [l.city, l.country].filter(Boolean).join(', ')).join('; ') || null,
        url: `https://higher.gs.com/roles/${id}`,
        postedAt: toDay(r.lastPostedDate),
        description: htmlToText(r.descriptionHtml),
      });
    }
  }
  return jobs;
}
