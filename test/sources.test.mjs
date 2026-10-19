import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/sources/index.mjs';
import { postedOnToDay } from '../src/sources/workday.mjs';
import { htmlToText } from '../src/text.mjs';
import { readFileSync } from 'node:fs';
import { loadCompanies, ConfigError } from '../src/config.mjs';
import { fixture, fakeHttp, tempProject } from './helpers.mjs';

const ctx = (http) => ({ http, today: '2026-10-15' });

test('careers URLs are recognised and parsed', () => {
  const cases = [
    ['https://woodgrove.wd5.myworkdayjobs.com/en-US/Careers', 'workday', { host: 'woodgrove.wd5.myworkdayjobs.com', tenant: 'woodgrove', site: 'Careers' }],
    ['https://contoso.wd5.myworkdayjobs.com/External', 'workday', { tenant: 'contoso', site: 'External' }],
    ['https://job-boards.greenhouse.io/contosopay', 'greenhouse', { token: 'contosopay' }],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', 'greenhouse', { token: 'acme' }],
    ['https://boards-api.greenhouse.io/v1/boards/litware/jobs', 'greenhouse', { token: 'litware' }],
    ['https://jobs.smartrecruiters.com/FabrikamCapital', 'smartrecruiters', { id: 'FabrikamCapital' }],
    ['https://efgh.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs', 'oracle', { site: 'CX_1', lang: 'en' }],
    ['https://higher.gs.com', 'goldman', {}],
    ['https://jobs.lever.co/palantir', 'lever', { company: 'palantir', eu: false }],
    ['https://jobs.ashbyhq.com/openai', 'ashby', { org: 'openai' }],
  ];
  for (const [url, type, params] of cases) {
    const d = detect(url);
    assert.ok(d, `should detect ${url}`);
    assert.equal(d.source.type, type, url);
    for (const [k, v] of Object.entries(params)) assert.equal(d.params[k], v, `${url} → ${k}`);
  }
  assert.equal(detect('https://careers.example.com/jobs'), null);
  assert.equal(detect('not a url'), null);
});

test('one Workday requisition on two sites of the same tenant has one scope', () => {
  const a = detect('https://northwind.wd1.myworkdayjobs.com/en-US/Northwind_Careers');
  const b = detect('https://northwind.wd1.myworkdayjobs.com/en-US/NW_External_Site');
  assert.equal(a.params.scope, b.params.scope);
});

test('workday: lists postings and reads a posting', async () => {
  const { source, params } = detect('https://woodgrove.wd1.myworkdayjobs.com/en-US/CorporateCareers');
  const http = fakeHttp([
    ['/CorporateCareers/jobs', fixture('workday-list.json')],
    ['/CorporateCareers/job/', fixture('workday-detail.json')],
  ]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].id, 'R-292877');
  assert.equal(jobs[0].location, 'Mexico City, Mexico');
  assert.equal(jobs[0].postedAt, '2026-10-15');
  assert.match(jobs[0].url, /^https:\/\/woodgrove\.wd1\.myworkdayjobs\.com\/en-US\/CorporateCareers\/job\//);
  assert.deepEqual(http.calls[0].body, { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });

  const d = await source.detail(params, jobs[0], ctx(http));
  assert.ok(d.description.length > 500);
  assert.doesNotMatch(d.description, /<[a-z]/i);
  assert.equal(d.location, 'Mexico City, Mexico');
});

test('workday: pages through every posting using the first page total', async () => {
  const { source, params } = detect('https://woodgrove.wd5.myworkdayjobs.com/Careers');
  const page = (offset) => ({
    total: offset === 0 ? 45 : 0, // Workday really does this
    jobPostings: Array.from({ length: Math.min(20, 45 - offset) }, (_, i) => ({ title: `Role ${offset + i}`, externalPath: `/job/X/Role_REF${offset + i}`, locationsText: '2 Locations', postedOn: 'Posted 3 Days Ago' })),
  });
  const http = fakeHttp([['/Careers/jobs', (_u, o) => page(o.body.offset)]]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 45);
  assert.equal(http.calls.length, 3);
  assert.equal(jobs[0].location, null, '"2 Locations" means unknown, resolved later from the posting');
  assert.equal(jobs[0].postedAt, '2026-10-12');
});

test('workday "posted" text becomes a date', () => {
  assert.equal(postedOnToDay('Posted Today', '2026-10-15'), '2026-10-15');
  assert.equal(postedOnToDay('Posted Yesterday', '2026-10-15'), '2026-10-14');
  assert.equal(postedOnToDay('Posted 7 Days Ago', '2026-10-15'), '2026-10-08');
  assert.equal(postedOnToDay('Posted 30+ Days Ago', '2026-10-15'), null);
});

test('greenhouse: double-encoded HTML content becomes plain text', async () => {
  const { source, params } = detect('https://job-boards.greenhouse.io/contosopay');
  const jobs = await source.list(params, ctx(fakeHttp([['boards-api.greenhouse.io', fixture('greenhouse.json')]])));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'Analyst, Banking Alliances');
  assert.equal(jobs[0].location, 'Bengaluru');
  assert.equal(jobs[0].postedAt, '2026-10-09');
  assert.ok(jobs[0].description.length > 200);
  assert.doesNotMatch(jobs[0].description, /&lt;|<p>/);
});

test('smartrecruiters: list + detail', async () => {
  const { source, params } = detect('https://jobs.smartrecruiters.com/FabrikamCapital');
  const http = fakeHttp([
    ['/postings?', fixture('smartrecruiters-list.json')],
    ['/postings/', fixture('smartrecruiters-detail.json')],
  ]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].location, 'Bengaluru, Karnataka, India');
  assert.equal(jobs[0].url, 'https://jobs.smartrecruiters.com/FabrikamCapital/1000000000004131');
  const d = await source.detail(params, jobs[0], ctx(http));
  assert.ok(d.description.length > 200);
});

test('oracle: list', async () => {
  const { source, params } = detect('https://efgh.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs');
  const http = fakeHttp([['recruitingCEJobRequisitions', fixture('oracle-list.json')]]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].location, 'Singapore');
  assert.equal(jobs[0].postedAt, '2026-10-14');
  assert.equal(jobs[0].url, 'https://efgh.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/3123');
  assert.match(decodeURIComponent(http.calls[0].url), /finder=findReqs;siteNumber=CX_1,/);
});

test('goldman: roles come with their description', async () => {
  const { source, params } = detect('https://higher.gs.com');
  const http = fakeHttp([['api-higher.gs.com', fixture('goldman.json')]]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].url, 'https://higher.gs.com/roles/171064');
  assert.equal(jobs[0].location, 'Dallas, United States');
  assert.ok(jobs[0].description.length > 200);
});

test('a GraphQL error is reported, not swallowed', async () => {
  const { source, params } = detect('https://higher.gs.com');
  const http = fakeHttp([['api-higher.gs.com', { errors: [{ message: 'schema changed' }] }]]);
  await assert.rejects(source.list(params, ctx(http)), /schema changed/);
});

test('htmlToText keeps bullets and decodes entities', () => {
  assert.equal(htmlToText('<p>Lead &amp; design</p><ul><li>SWIFT</li><li>ISO&nbsp;20022</li></ul>'), 'Lead & design\n\n• SWIFT\n• ISO 20022');
});

test('successfactors: named by platform, read from the API when the site has one', async () => {
  assert.equal(detect('https://jobs.fabrikam.com/search/'), null, 'the address alone does not say SuccessFactors');
  const { source, params } = detect('https://jobs.fabrikam.com/search/?locationsearch=India&locale=en_GB', 'successfactors');
  assert.equal(source.type, 'successfactors');
  assert.deepEqual([params.base, params.location, params.locale], ['/', 'India', 'en_GB']);
  const api = fixture('successfactors-api.json');
  const http = fakeHttp([['/services/recruiting/v1/jobs', (url, opts) => (opts.body.pageNumber === 0 ? api : { totalJobs: 3, jobSearchResult: [api.jobSearchResult[0]] })]]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 2, 'a role repeated on a later page counts once');
  assert.equal(jobs[0].url, 'https://jobs.fabrikam.com/job/Director%2C-Payments-Architecture/53258-en_GB');
  assert.equal(jobs[1].title, 'Head of Core Banking & Deposits');
  assert.equal(jobs[1].location, 'Chennai, IND; Mumbai, IND');
  assert.equal(jobs[0].postedAt, null);
  assert.equal(http.calls[0].body.location, 'India');
  assert.equal(http.calls[0].body.sortBy, 'date');
});

test('successfactors: an older site is read from its search pages', async () => {
  const { source, params } = detect('https://careers.fabrikam.com/fab/search/?locationsearch=India', 'successfactors');
  assert.equal(params.base, '/fab/');
  const http = fakeHttp([
    ['/services/recruiting/v1/jobs', () => Promise.reject(new Error('HTTP 401'))],
    ['startrow=0', readFileSync(new URL('./fixtures/successfactors-search.html', import.meta.url), 'utf8')],
    ['startrow=2', readFileSync(new URL('./fixtures/successfactors-search-2.html', import.meta.url), 'utf8')],
    ['/job/', readFileSync(new URL('./fixtures/successfactors-job.html', import.meta.url), 'utf8')],
  ]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 3);
  assert.match(http.calls[1].url, /^https:\/\/careers\.fabrikam\.com\/fab\/search\/\?q=&locationsearch=India&startrow=0$/);
  assert.deepEqual(jobs[0], {
    id: '1447535233',
    title: 'Payments Solution Architect & Lead',
    location: 'Pune, MH, IN',
    url: 'https://careers.fabrikam.com/fab/job/Pune-Payments-Solution-Architect-MH-411001/1447535233/',
    postedAt: '2026-10-18',
    ref: { listedPlace: 'Pune, MH, IN' },
  });
  assert.equal(jobs[1].title, 'Core Banking Director');
  assert.equal(jobs[1].location, null, '"+3 more" leaves the place to the posting');

  const d = await source.detail(params, jobs[1], ctx(http));
  assert.equal(d.location, 'Bengaluru; Pune, IN');
  assert.equal(d.postedAt, '2026-10-14');
  assert.match(d.description, /ISO 20022 migration/);
  assert.match(d.description, /• Core banking integration/);
  assert.doesNotMatch(d.description, /Apply now/);
});

test('successfactors: a page with no job list is an error, never "no roles"', async () => {
  const { source, params } = detect('https://careers.fabrikam.com/search/', 'successfactors');
  const http = fakeHttp([
    ['/services/recruiting/v1/jobs', () => Promise.reject(new Error('timed out'))],
    ['/search/', '<html><body>Access denied</body></html>'],
  ]);
  await assert.rejects(source.list(params, ctx(http)), /no job list/);
});

test('oracle: sites on the EU cloud are read too', () => {
  const d = detect('https://ejqi.fa.ocs.oraclecloud.eu/hcmUI/CandidateExperience/en/sites/CX_1001/jobs');
  assert.equal(d.source.type, 'oracle');
  assert.equal(d.params.site, 'CX_1001');
});

test('companies.yml: platform picks the reader, and an unknown one is a clear error', () => {
  const dir = tempProject({ companies: [{ name: 'Fabrikam', url: 'https://careers.fabrikam.com/search/', platform: 'SuccessFactors' }, { name: 'Contoso', url: 'https://careers.contoso.com/' }] });
  const [fab, contoso] = loadCompanies(dir);
  assert.equal(fab.boards[0].source.type, 'successfactors');
  assert.equal(contoso.boards[0].source, null, 'still "check by hand"');
  const bad = tempProject({ companies: [{ name: 'Fabrikam', url: 'https://careers.fabrikam.com/', platform: 'taleo' }] });
  assert.throws(() => loadCompanies(bad), (e) => e instanceof ConfigError && /known platforms: successfactors/.test(e.message));
});

test('amazon: filters on the address carry over; descriptions come with the list', async () => {
  const { source, params } = detect('https://www.amazon.jobs/en/search?country=IND&offset=40');
  assert.equal(source.type, 'amazon');
  const http = fakeHttp([['search.json', fixture('amazon.json')]]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 2);
  assert.match(http.calls[0].url, /^https:\/\/www\.amazon\.jobs\/en\/search\.json\?country=IND&result_limit=100&offset=0&sort=recent$/);
  assert.equal(jobs[0].id, '3100001');
  assert.equal(jobs[0].url, 'https://www.amazon.jobs/en/jobs/3100001/principal-solutions-architect-payments');
  assert.equal(jobs[0].location, 'Bengaluru, Karnataka, IND');
  assert.equal(jobs[0].postedAt, '2026-10-18');
  assert.match(jobs[0].description, /Design payments platforms\.\nLead migrations\.[\s\S]*Basic qualifications\n- 10\+ years[\s\S]*Preferred qualifications/);
});

test('turbohire: token, organization, then every role with its description', async () => {
  const { source, params } = detect('https://navi.turbohire.co/dashboardv2');
  assert.equal(source.type, 'turbohire');
  assert.equal(detect('https://identity.turbohire.co/connect/token'), null);
  const http = fakeHttp([
    ['/token/noauth', { access_token: 'tok' }],
    ['/publicorganizations?accountName=navi', { OrgID: 'org-1', OrgName: 'NAVI' }],
    ['/careerpagev2/filteredjobs?orgId=org-1', fixture('turbohire-jobs.json')],
  ]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(http.calls[0].headers.Origin, 'https://navi.turbohire.co');
  assert.equal(http.calls[2].headers.Authorization, 'Bearer tok');
  assert.equal(http.calls[2].method, 'POST');
  assert.equal(jobs.length, 2, 'a repeated role is listed once');
  assert.deepEqual(
    { ...jobs[0], description: undefined },
    {
      id: '4f70e4cc-0798-4d02-8c93-e8c44b960e12',
      title: 'Senior Manager - Payments Platform',
      location: 'Bengaluru, Karnataka, India',
      url: 'https://navi.turbohire.co/job/publicjobs/F%2F5iroc_example1',
      postedAt: '2026-10-16',
      description: undefined,
    },
  );
  assert.match(jobs[0].description, /About the Team\nOwn the UPI and cards platform\.[\s\S]*10\+ years/);
  assert.equal(jobs[1].location, 'Bengaluru, Karnataka, India; Pune, Maharashtra, India');
  const unknown = fakeHttp([['/token/noauth', { access_token: 'tok' }], ['/publicorganizations', '']]);
  await assert.rejects(source.list(params, ctx(unknown)), /no TurboHire career site named "navi"/);
});

test('google: reads the roles inside the results pages', async () => {
  const { source, params } = detect('https://www.google.com/about/careers/applications/jobs/results?location=India');
  assert.equal(source.type, 'google');
  const page = (n) => readFileSync(new URL(`./fixtures/google-${n}.html`, import.meta.url), 'utf8');
  const http = fakeHttp([['page=1', page(1)], ['page=2', page(2)]]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 3);
  assert.match(http.calls[0].url, /results\?location=India&page=1$/);
  assert.deepEqual([jobs[0].id, jobs[0].title, jobs[0].location, jobs[0].postedAt], ['111', 'Payments Architect', 'Bengaluru, Karnataka, India', '2026-10-16']);
  assert.equal(jobs[0].url, 'https://www.google.com/about/careers/applications/jobs/results/111');
  assert.match(jobs[0].description, /About the team\.[\s\S]*Responsibilities[\s\S]*Own the payments roadmap[\s\S]*10 years/);
  await assert.rejects(source.list(params, ctx(fakeHttp([['page=1', '<html>sorry</html>']]))), /no job data/);
});

test('eightfold: hosted and branded sites, older and newer API', async () => {
  const hsbc = detect('https://portal.careers.hsbc.com/careers?location=India', 'eightfold');
  assert.deepEqual([hsbc.source.type, hsbc.params.domain, hsbc.params.location], ['eightfold', 'hsbc.com', 'India']);
  assert.equal(detect('https://portal.careers.hsbc.com/careers'), null, 'a branded site needs platform: eightfold');
  const v2 = fakeHttp([
    ['/api/apply/v2/jobs?', fixture('eightfold-v2.json')],
    ['/api/apply/v2/jobs/563774612471683', { job_description: '<p>Own <b>collateral</b> platforms.</p>' }],
  ]);
  const jobs = await hsbc.source.list(hsbc.params, ctx(v2));
  assert.match(v2.calls[0].url, /domain=hsbc\.com&start=0&num=10&sort_by=timestamp&location=India/);
  assert.deepEqual(jobs[1], {
    id: '563774612471682',
    title: 'VP Payments Systems',
    location: 'Mumbai, Maharashtra, India; Pune, Maharashtra, India',
    url: 'https://portal.careers.hsbc.com/careers/job/563774612471682',
    postedAt: '2026-10-15',
  });
  assert.equal((await hsbc.source.detail(hsbc.params, jobs[0], ctx(v2))).description, 'Own collateral platforms.');

  const paypal = detect('https://paypal.eightfold.ai/careers?location=India');
  assert.equal(paypal.params.domain, 'paypal.com');
  const pcsx = fakeHttp([
    ['/api/apply/v2/jobs?', { message: 'Not authorized for PCSX' }],
    ['/api/pcsx/search', fixture('eightfold-pcsx.json')],
  ]);
  const pj = await paypal.source.list(paypal.params, ctx(pcsx));
  assert.deepEqual([pj.length, pj[0].id, pj[0].postedAt, pj[0].url], [1, '274922903169', '2026-10-16', 'https://paypal.eightfold.ai/careers/job/274922903169']);

  const none = fakeHttp([['/api/', { message: 'nope' }]]);
  await assert.rejects(paypal.source.list(paypal.params, ctx(none)), /no job list/);
});
