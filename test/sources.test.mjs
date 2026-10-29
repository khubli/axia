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

test('phenom: branded site, country filter from the address, paged search and posting text', async () => {
  const site = detect('https://careers.woodgrove.com/global/en/search-results?country=India', 'phenom');
  assert.equal(detect('https://careers.woodgrove.com/global/en/search-results?country=India'), null, 'a Phenom site needs platform: phenom');
  assert.deepEqual([site.source.type, site.params.country, site.params.lang, site.params.filters], ['phenom', 'global', 'en', { country: ['India'] }]);
  assert.deepEqual([detect('https://jobs.contoso.com/', 'phenom').params.country, detect('https://jobs.contoso.com/', 'phenom').params.lang], ['us', 'en']);

  const page2 = { refineSearch: { totalHits: 3, data: { jobs: [{ jobSeqNo: 'WGIC108607EXTERNALENGLOBAL', title: 'Technical Architect', cityStateCountry: 'Pune, Maharashtra, India', postedDate: '2026-10-22T10:00:00.000+0000' }] } } };
  const http = fakeHttp([
    ['/widgets', (_url, opts) => {
      if (opts.body.ddoKey === 'jobDetail') return { jobDetail: { data: { job: { description: '<p>Lead <b>architecture</b> governance.</p>' } } } };
      return opts.body.from === 0 ? fixture('phenom-search.json') : page2;
    }],
  ]);
  const jobs = await site.source.list(site.params, ctx(http));
  const first = http.calls[0];
  assert.equal(first.url, 'https://careers.woodgrove.com/widgets');
  assert.deepEqual([first.method, first.body.lang, first.body.country, first.body.ddoKey, first.body.selected_fields], ['POST', 'en_global', 'global', 'refineSearch', { country: ['India'] }]);
  assert.equal(http.calls[1].body.from, 2, 'the next page starts after the roles the first returned');
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    id: 'WGIC106336EXTERNALENGLOBAL',
    title: 'Group Technical Architect (Solution Architect)',
    location: 'Pune, Maharashtra, India, 411014; India',
    url: 'https://careers.woodgrove.com/global/en/job/WGIC106336EXTERNALENGLOBAL',
    postedAt: '2026-10-01',
  });
  assert.deepEqual([jobs[1].title, jobs[1].location], ['Application Architect(Java&AI)', 'India']);
  assert.deepEqual([jobs[2].title, jobs[2].location, jobs[2].postedAt], ['Technical Architect', 'Pune, Maharashtra, India', '2026-10-22']);
  assert.equal((await site.source.detail(site.params, jobs[0], ctx(http))).description, 'Lead architecture governance.');
  assert.equal(http.calls.at(-1).body.jobSeqNo, 'WGIC106336EXTERNALENGLOBAL');

  await assert.rejects(site.source.list(site.params, ctx(fakeHttp([['/widgets', { status: 'error' }]]))), /no job list/);
});

test('jibe: branded iCIMS site, filters carry over, paged list with descriptions', async () => {
  const site = detect('https://careers.woodgrove.com/careers-home/jobs?location=India&page=3', 'jibe');
  assert.equal(detect('https://careers.woodgrove.com/careers-home/jobs?location=India'), null, 'a Jibe site needs platform: jibe');
  assert.deepEqual([site.source.type, site.params.jobsPath, site.params.filters], ['jibe', '/careers-home/jobs', 'location=India']);
  assert.equal(detect('https://jobs.contoso.com/', 'jibe').params.jobsPath, '/jobs');

  const page2 = { totalCount: 3, jobs: [{ data: { slug: '109191', req_id: '109191', title: ' Infrastructure Architect ', city: 'Bengaluru', state: 'Karnataka', country: 'India', posted_date: '2026-10-23T04:00:00+0000', description: 'Run it.' } }] };
  const http = fakeHttp([
    ['page=1&', fixture('jibe-jobs.json')],
    ['page=2&', page2],
  ]);
  const jobs = await site.source.list(site.params, ctx(http));
  assert.equal(http.calls[0].url, 'https://careers.woodgrove.com/api/jobs?location=India&page=1&limit=100');
  assert.equal(http.calls.length, 2);
  assert.deepEqual(jobs[0], {
    id: '104426',
    title: 'Enterprise Architect',
    location: 'Bengaluru, India',
    url: 'https://careers.woodgrove.com/careers-home/jobs/104426',
    postedAt: '2026-10-22',
    description: 'Own the target architecture.',
  });
  assert.equal(jobs[1].location, 'GURUGRAM, India', 'city and country when the site gives no summary');
  assert.deepEqual([jobs[2].title, jobs[2].location], ['Infrastructure Architect', 'Bengaluru, Karnataka, India']);

  await assert.rejects(site.source.list(site.params, ctx(fakeHttp([['/api/jobs', { error: 'nope' }]]))), /no job list/);
});

test('deshaw: India and global sites, roles from the page data, open applications left out', async () => {
  const india = detect('https://www.deshawindia.com/careers');
  assert.deepEqual([india.source.type, india.params.origin, india.params.india], ['deshaw', 'https://www.deshawindia.com', true]);
  assert.deepEqual([detect('https://deshaw.com/careers').params.india, detect('https://deshaw.com/careers').params.origin], [false, 'https://www.deshaw.com']);

  const http = fakeHttp([['/careers', readFileSync(new URL('./fixtures/deshaw-careers.html', import.meta.url), 'utf8')]]);
  const jobs = await india.source.list(india.params, ctx(http));
  assert.equal(http.calls[0].url, 'https://www.deshawindia.com/careers');
  assert.equal(jobs.length, 1, '"All positions in …" is an open application, not a role');
  assert.deepEqual(jobs[0], {
    id: '7019',
    title: 'Principal Architect (FinOp Tech - ManCo)',
    location: 'Hyderabad, India; Gurugram, India',
    url: 'https://www.deshawindia.com/careers/Principal-Architect-FinOp-Tech-ManCo-7019',
    postedAt: null,
    description: 'We seek a senior technical architect.\n\nDesign enterprise applications.\n\n' + htmlToText('<ul><li>8 years of experience</li></ul>'),
  });

  await assert.rejects(india.source.list(india.params, ctx(fakeHttp([['/careers', '<html>maintenance</html>']]))), /no job data/);
});

test('avature: search pages at the size the site gives, location from the list, text from the job page', async () => {
  const site = detect('https://woodgrove.avature.net/careers/SearchJobs?jobOffset=24');
  assert.deepEqual([site.source.type, site.params.origin, site.params.portal], ['avature', 'https://woodgrove.avature.net', 'careers']);
  assert.equal(detect('https://avature.net/careers'), null);
  assert.equal(detect('https://woodgrove.avature.net/'), null, 'the portal name is needed');

  const role = (id, title, location) => `
    <article class="article article--result"><h3><a class="link" href="https://woodgrove.avature.net/careers/JobDetail/${title.replace(/\W+/g, '-')}/${id}">
      ${title}
    </a></h3><div class="article__header__text__subtitle"><span class="list-item-location">${location}</span></div>
    <div class="article__footer"><a class="button button--primary" href="https://woodgrove.avature.net/careers/JobDetail/${title.replace(/\W+/g, '-')}/${id}">Apply</a></div></article>`;
  const page = (roles) => `<div class="list-controls__text__legend" aria-label="5 results">1-2 of 5 results</div>${roles.join('')}`;
  const http = fakeHttp([
    ['jobOffset=0', page([role('45785', 'Senior Software Engineer &amp; Lead, Pune', 'Pune, India'), role('45808', 'Accounting Analyst', 'New York, New York, United States of America')])],
    ['jobOffset=2', page([role('21041', 'Engineering Manager - Anomaly Platform', 'Pune, India'), role('45785', 'Senior Software Engineer &amp; Lead, Pune', 'Pune, India')])],
    ['jobOffset=4', page([role('16486', 'Market Specialist, Commodities', 'Mumbai, Maharashtra, India')])],
    ['/JobDetail/', `<div class="article__content__view__field tf_replaceFieldVideoTokens field--rich-text">
      <div class="article__content__view__field__value"><p><span>A</span><span>bout the team</span></p><div><ul><li>Lead 8 engineers</li></ul></div></div></div>
      <div class="article__content__view__field "><div class="article__content__view__field__value">Watch our podcast</div></div></article>`],
  ]);
  const jobs = await site.source.list(site.params, ctx(http));
  assert.deepEqual(http.calls.map((c) => new URL(c.url).searchParams.get('jobOffset')), ['0', '2', '4'], 'steps by the page size the site gave');
  assert.equal(http.calls[0].url, 'https://woodgrove.avature.net/careers/SearchJobs/?jobRecordsPerPage=100&jobOffset=0');
  assert.deepEqual(jobs.map((j) => j.id), ['45785', '45808', '21041', '16486'], 'a role on two pages counts once; Apply links are not roles');
  assert.deepEqual(jobs[0], {
    id: '45785',
    title: 'Senior Software Engineer & Lead, Pune',
    location: 'Pune, India',
    url: 'https://woodgrove.avature.net/careers/JobDetail/Senior-Software-Engineer-amp-Lead-Pune/45785',
    postedAt: null,
  });

  const d = await site.source.detail(site.params, jobs[2], ctx(http));
  assert.equal(d.description, 'About the team\n\n• Lead 8 engineers', 'the posting text only, words kept whole');

  const none = await site.source.list(site.params, ctx(fakeHttp([['SearchJobs', '<p>No jobs found - There are currently no open roles</p>']])));
  assert.deepEqual(none, []);
  await assert.rejects(site.source.list(site.params, ctx(fakeHttp([['SearchJobs', '<html>maintenance</html>']]))), /no job list/);
});

test('talentsoft: RSS feed, list-page filters carry over, reference left off the title', async () => {
  const site = detect('https://jobs.woodgrove.com/job/list-of-jobs.aspx?changefacet=1&facet_JobCountry=96&LCID=2057', 'talentsoft');
  assert.equal(detect('https://jobs.woodgrove.com/job/list-of-jobs.aspx'), null, 'a Talentsoft site on its own domain needs platform: talentsoft');
  assert.equal(detect('https://contoso.talent-soft.com/job/list-of-jobs.aspx').source.type, 'talentsoft', '*.talent-soft.com is recognised');
  assert.deepEqual([site.source.type, site.params.filters], ['talentsoft', 'Rss_JobCountry=96&LCID=2057']);
  assert.equal(detect('https://jobs.woodgrove.com/', 'talentsoft').params.filters, 'LCID=2057', 'English unless the address says otherwise');

  const item = (id, title, cats, city, date) => `<item>
      <link>https://jobs.woodgrove.com/Pages/Offre/detailoffre.aspx?idOffre=${id}&amp;idOrigine=1533&amp;LCID=2057</link>
      ${cats.map((c) => `<category>${c}</category>`).join('')}
      <title>${title}</title>
      <description>&lt;b&gt;Job description : &lt;/b&gt;Lead the platform team.&lt;br /&gt;${city ? `&lt;b&gt;City : &lt;/b&gt;${city}&lt;br /&gt;` : ''}</description>
      <pubDate>${date}</pubDate>
    </item>`;
  const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>RSS export</title>
    ${item('115049', '2026-115049 - Senior IT Team Manager', ['IT', 'Permanent Contract', 'Mumbai'], 'Mumbai', 'Tue, 01 Sep 2026 12:38:14 Z')}
    ${item('112041', 'KYC &amp; Quality Assurance', ['Operations', 'MUMBAI'], '', 'Tue, 28 Apr 2026 10:15:42 Z')}
    ${item('115049', '2026-115049 - Senior IT Team Manager', ['IT'], 'Mumbai', 'Tue, 01 Sep 2026 12:38:14 Z')}
  </channel></rss>`;
  const http = fakeHttp([['/handlers/offerRss.ashx', feed]]);
  const jobs = await site.source.list(site.params, ctx(http));
  assert.equal(http.calls[0].url, 'https://jobs.woodgrove.com/handlers/offerRss.ashx?Rss_JobCountry=96&LCID=2057&top=2000');
  assert.equal(jobs.length, 2, 'a role twice in the feed counts once');
  assert.deepEqual(jobs[0], {
    id: '115049',
    title: 'Senior IT Team Manager',
    location: 'Mumbai',
    url: 'https://jobs.woodgrove.com/Pages/Offre/detailoffre.aspx?idOffre=115049&idOrigine=1533&LCID=2057',
    postedAt: '2026-09-01',
    description: htmlToText('<b>Job description : </b>Lead the platform team.<br /><b>City : </b>Mumbai<br />'),
  });
  assert.deepEqual([jobs[1].title, jobs[1].location], ['KYC & Quality Assurance', 'MUMBAI'], 'no City field: the last category');

  await assert.rejects(site.source.list(site.params, ctx(fakeHttp([['/handlers/', '<html>Sign in</html>']]))), /no job feed/);
});

test('bpce: recrutement.natixis.com search, filters from the address, paged with descriptions', async () => {
  const site = detect('https://recrutement.natixis.com/en/our-job-offers/?tax_place=inde&utm_source=x');
  assert.deepEqual([site.source.type, site.params.origin, site.params.filters], ['bpce', 'https://recrutement.natixis.com', { tax_place: 'inde' }]);
  assert.equal(detect('https://recrutement.bpce.fr/').source.type, 'bpce');
  assert.equal(detect('https://natixis.com/careers'), null);

  const role = (n, title, city, region) => ({
    job_number: n,
    title,
    date: '2026-10-14',
    link: { url: `/job/${n}` },
    description: '<h2>Poste et missions</h2><p>Lead the office.</p>',
    localisation: city,
    localisations: [{ city, region, country: 'International' }],
  });
  const page1 = Array.from({ length: 50 }, (_, i) => role(`R${i}`, `Role ${i}`, 'Mumbai', 'Inde'));
  const http = fakeHttp([
    ['/search/jobs', (url, opts) => ({ code: 'all_good', data: { total: 51, items: opts.body.from === 0 ? page1 : [role('WORKDAY_PVR09171', 'Executive Director &amp; Chief Representative', 'Mumbai', 'Inde'), role('R0', 'Role 0', 'Mumbai', 'Inde')] } })],
  ]);
  const jobs = await site.source.list(site.params, ctx(http));
  assert.equal(http.calls[0].url, 'https://recrutement.natixis.com/app/wp-json/bpce/v1/search/jobs');
  assert.deepEqual(http.calls.map((c) => c.body), [{ tax_place: 'inde', from: 0, size: 50 }, { tax_place: 'inde', from: 50, size: 50 }]);
  assert.equal(jobs.length, 51, 'a role on two pages counts once');
  assert.deepEqual(jobs.at(-1), {
    id: 'WORKDAY_PVR09171',
    title: 'Executive Director & Chief Representative',
    location: 'Mumbai, Inde',
    url: 'https://recrutement.natixis.com/job/WORKDAY_PVR09171',
    postedAt: '2026-10-14',
    description: htmlToText('<h2>Poste et missions</h2><p>Lead the office.</p>'),
  });

  await assert.rejects(site.source.list(site.params, ctx(fakeHttp([['/search/jobs', { code: 'rest_no_route' }]]))), /no job list/);
});

test('oracle: a site over 10,000 postings also reads the older ones by posting date', async () => {
  const { source, params } = detect('https://hcbt.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/jobs');
  const req = (id, day) => ({ Id: id, Title: `Role ${id}`, PrimaryLocation: 'Mumbai, Maharashtra, India', PostedDate: day });
  const http = fakeHttp([
    ['recruitingCEJobRequisitions', (url) => {
      const f = decodeURIComponent(url);
      const offset = Number(f.match(/offset=(\d+)/)[1]);
      const window = f.match(/postingStartDate=([\d-]+),postingEndDate=([\d-]+)/);
      if (!window) {
        // The newest 10,000, the last 200 of them posted on 1 Oct; nothing past offset 10,000.
        const reqs = offset >= 10000 ? [] : Array.from({ length: 200 }, (_, i) => req(String(offset + i), offset === 9800 ? '2026-10-01' : '2026-10-20'));
        return { items: [{ TotalJobsCount: offset >= 10000 ? 0 : 10300, requisitionList: reqs }] };
      }
      const [, from, to] = window;
      // Up to 1 Oct: 10,100 postings in all, too many for one read, so the reader halves the window.
      if (from === '2000-01-01' && to === '2026-10-01') return { items: [{ TotalJobsCount: 10100, requisitionList: [req('x', '2026-10-01')] }] };
      if (to < '2026-01-01') return { items: [{ TotalJobsCount: 1, requisitionList: [req('old-1', '2024-05-02')] }] };
      return { items: [{ TotalJobsCount: 2, requisitionList: [req('9999', '2026-10-01'), req('oct-1', '2026-10-01')] }] };
    }],
  ]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(jobs.length, 10002, 'the newest 10,000 plus the two older postings, each once');
  assert.deepEqual(jobs.slice(-2).map((j) => j.id), ['old-1', 'oct-1']);
  const windows = http.calls.map((c) => decodeURIComponent(c.url).match(/postingStartDate=([\d-]+),postingEndDate=([\d-]+)/)?.slice(1).join('..')).filter(Boolean);
  assert.deepEqual(windows, ['2000-01-01..2026-10-01', '2000-01-01..2013-05-17', '2013-05-18..2026-10-01']);

  // Under 10,000: one read, no date windows.
  const small = fakeHttp([['recruitingCEJobRequisitions', fixture('oracle-list.json')]]);
  await source.list(params, ctx(small));
  assert.equal(small.calls.length, 1);
});

test('ripplehire: list paged without descriptions, detail adds description and date', async () => {
  const site = detect('https://axisbank.ripplehire.com/candidate/?token=WIXhCuz0XRZ7H0GZCwjJ&source=CAREERSITE#list');
  assert.deepEqual([site.source.type, site.params.origin, site.params.token, site.params.source], ['ripplehire', 'https://axisbank.ripplehire.com', 'WIXhCuz0XRZ7H0GZCwjJ', 'CAREERSITE']);
  assert.equal(detect('https://axisbank.ripplehire.com/auth/saml2/authenticate/axisbank'), null, 'no token: not a public job list');

  const role = (n, title, locations) => ({ jobSeq: String(n), jobTitle: title, jobLocation: 'India', locations });
  const page1 = Array.from({ length: 1000 }, (_, i) => role(i, `Branch:Teller ${i}`, 'PHAGWARA, Phagwara'));
  const http = fakeHttp([
    ['candidatejobsearch', (url) => {
      const p = JSON.parse(new URL(url).searchParams.get('careerSiteUrlParams'));
      return { errorStatus: 'success', totalJobCount: 1002, jobVoList: p.page === 0 ? page1 : [role(777777, 'IT:Head - Technology Solution', 'Mumbai'), role(0, 'Branch:Teller 0', 'x'), role(5, 'x', null)] };
    }],
    ['candidatejobdetail', { jobVO: { jobDesc: '<p>Lead the <b>payments</b> platform.</p>', jobSkills: 'Refer to the Job Description', jobPostingDate: '29-Oct-2026', publishDetails: { CAREER_SITE: '2026-10-28T20:50:06Z' } } }],
  ]);
  const jobs = await site.source.list(site.params, ctx(http));
  const first = JSON.parse(new URL(http.calls[0].url).searchParams.get('careerSiteUrlParams'));
  assert.deepEqual(first, { page: 0, search: '*:*', token: 'WIXhCuz0XRZ7H0GZCwjJ', source: 'CAREERSITE', pagesize: 1000 });
  assert.equal(http.calls.length, 2);
  assert.equal(jobs.length, 1001, 'a role on two pages counts once');
  assert.deepEqual(jobs[1000], {
    id: '777777',
    title: 'IT:Head - Technology Solution',
    location: 'Mumbai',
    url: 'https://axisbank.ripplehire.com/candidate/?token=WIXhCuz0XRZ7H0GZCwjJ&source=CAREERSITE#detail/job/777777',
    postedAt: null,
  });
  const d = await site.source.detail(site.params, jobs[1000], ctx(http));
  assert.deepEqual(d, { description: 'Lead the payments platform.', postedAt: '2026-10-28' });
  assert.match(http.calls.at(-1).url, /candidatejobdetail\?token=WIXhCuz0XRZ7H0GZCwjJ&jobSeq=777777&source=CAREERSITE&lang=en/);

  await assert.rejects(site.source.list(site.params, ctx(fakeHttp([['candidatejobsearch', { errorStatus: 'failure' }]]))), /no job list/);
});

test('oracle: a short page does not end the list early', async () => {
  const { source, params } = detect('https://efgh.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs');
  const req = (id) => ({ Id: id, Title: `Role ${id}`, PrimaryLocation: 'Pune, India', PostedDate: '2026-10-01' });
  const http = fakeHttp([['recruitingCEJobRequisitions', (url) => {
    const offset = Number(decodeURIComponent(url).match(/offset=(\d+)/)[1]);
    // Oracle often returns fewer than asked for, mid-list.
    const n = offset === 0 ? 150 : 90;
    return { items: [{ TotalJobsCount: 300, requisitionList: Array.from({ length: n }, (_, i) => req(String(offset + i))) }] };
  }]]);
  const jobs = await source.list(params, ctx(http));
  assert.equal(http.calls.length, 2);
  assert.equal(jobs.length, 240);
});

test('radancy: the search page names the search, results read 100 a page, text and date from the job page', async () => {
  const pageUrl = 'https://www.woodgrovejobs.com/search-jobs/India/33995/2/1269750/22/79/50/2';
  assert.equal(detect(pageUrl), null, 'a Radancy site on its own domain needs platform: radancy');
  const site = detect(pageUrl, 'radancy');
  assert.deepEqual([site.source.type, site.params.origin], ['radancy', 'https://www.woodgrovejobs.com']);

  const searchPage = `<section id="search-results" data-keywords="" data-location="India" data-total-results="3"
    data-location-type="2" data-location-path="1269750" data-organization-ids="33995"></section>`;
  const role = (id, title, location) => `<li><a href="/job/hyderabad/${id}-role/33995/${id}" data-job-id="${id}">
      <h2>${title}</h2><span class="job-location">${location}</span>
      <div><span class="job-req-id"><b>Requisition ID: </b> 2026-1</span></div>
      <button type="button" class="js-save-job-btn" data-job-id="${id}" data-org-id="33995">Save for Later</button></a></li>`;
  const results = (roles) => ({ results: `<section id="search-results" data-total-results="101"><ul>${roles.join('')}</ul></section>`, hasJobs: true });
  const http = fakeHttp([
    ['/search-jobs/results?', (url) =>
      new URL(url).searchParams.get('CurrentPage') === '1'
        ? results([role('111', '&#x200B;&#x200B;Sr Manager, Software Development &amp; Engineering', 'Hyderabad, Telangana'), role('222', 'Solutions Architect', 'Hyderabad, Telangana')])
        : results([role('222', 'Solutions Architect', 'Hyderabad, Telangana'), role('333', 'Manager, Facilities', 'Hyderabad, Telangana')])],
    ['/search-jobs/India/', searchPage],
    ['/job/', `<script type="application/ld+json">{"@context":"http://schema.org","@type":"JobPosting","title":"Solutions Architect",
      "datePosted":"2026-10-16","description":"<h2>Your opportunity</h2><p>Lead the design.</p>","qualifications":"<ul><li>10 years</li></ul>",
      "jobLocation":[{"@type":"Place","address":{"addressLocality":"Hyderabad","addressRegion":"Telangana","addressCountry":"India"}}]}</script>`],
  ]);
  const jobs = await site.source.list(site.params, ctx(http));
  const asked = http.calls.slice(1).map((c) => new URL(c.url).searchParams);
  assert.equal(http.calls[0].url, pageUrl, 'the configured page is read first, for its search');
  assert.deepEqual(asked.map((q) => q.get('CurrentPage')), ['1', '2'], '101 roles at 100 a page');
  assert.deepEqual([asked[0].get('Location'), asked[0].get('LocationType'), asked[0].get('LocationPath'), asked[0].get('RecordsPerPage')], ['India', '2', '1269750', '100']);
  assert.deepEqual(jobs.map((j) => j.id), ['111', '222', '333'], 'a role on two pages counts once');
  assert.deepEqual(jobs[0], {
    id: '111',
    title: 'Sr Manager, Software Development & Engineering',
    location: 'Hyderabad, Telangana',
    url: 'https://www.woodgrovejobs.com/job/hyderabad/111-role/33995/111',
    postedAt: null,
  });

  const d = await site.source.detail(site.params, jobs[1], ctx(http));
  assert.equal(d.postedAt, '2026-10-16');
  assert.equal(d.location, 'Hyderabad, Telangana, India');
  assert.match(d.description, /Your opportunity[\s\S]*Lead the design\.[\s\S]*10 years/);

  await assert.rejects(site.source.list(site.params, ctx(fakeHttp([['/search-jobs/', '<html>maintenance</html>']]))), /no search results section/);
});
