import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/sources/index.mjs';
import { postedOnToDay } from '../src/sources/workday.mjs';
import { htmlToText } from '../src/text.mjs';
import { fixture, fakeHttp } from './helpers.mjs';

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
