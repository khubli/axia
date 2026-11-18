// Saved lists: a Workday board read on another computer (`axia fetch`) stands in for a daily read
// that the site's bot check stopped. Made-up companies and roles only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { fetchLists, usableList } from '../src/lists.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const WOODGROVE = { name: 'Woodgrove Bank', url: 'https://woodgrove.wd3.myworkdayjobs.com/en-US/Careers' };
const CONTOSO = { name: 'Contoso Pay', url: 'https://job-boards.greenhouse.io/contoso' };
const LIST = 'woodgrove.wd3.myworkdayjobs.com/wday/cxs/woodgrove/Careers/jobs';
const DETAIL = 'woodgrove.wd3.myworkdayjobs.com/wday/cxs/woodgrove/Careers/job/';

const posting = (title, path, locationsText) => ({ title, externalPath: path, locationsText, postedOn: 'Posted Today' });
const POSTINGS = [
  posting('Payments Solution Architect', '/job/Pune/Payments-Solution-Architect_R-201', 'Pune, India'),
  posting('Enterprise Architect', '/job/Pune/Enterprise-Architect_R-202', '2 Locations'),
  posting('Sales Intern', '/job/Pune/Sales-Intern_R-203', 'Pune, India'),
  posting('Solution Architect', '/job/London/Solution-Architect_R-204', 'London, United Kingdom'),
];

const workday = (postings, details) => [
  [LIST, () => ({ total: postings.length, jobPostings: postings })],
  [DETAIL, (url) => {
    details.push(url);
    return { jobPostingInfo: { jobDescription: '<p>Own the card issuing target architecture.</p>', location: 'Pune, India', additionalLocations: ['Bengaluru, India'] } };
  }],
];
// What Workday has shown GitHub's servers since November 2026.
const blocked = [LIST, () => new Response('<html>Just a moment...</html>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } })];
const contoso = ['boards-api.greenhouse.io/v1/boards/contoso', () => ({ jobs: [] })];

function claude(requests) {
  return ['/v1/messages', (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body.messages[0].content);
    return {
      id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: JSON.stringify({ score: 72, summary: 'Fits.', strengths: ['payments'], gaps: [] }) }],
      stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 10, output_tokens: 10 },
    };
  }];
}

const quiet = () => {};
const ENV = { ANTHROPIC_API_KEY: 'test-key' };
const listsIn = (dir) => readdirSync(join(dir, 'data/lists'));
const savedList = (dir) => JSON.parse(readFileSync(join(dir, 'data/lists', listsIn(dir)[0]), 'utf8'));

async function fetchAt(dir, when, postings, details = []) {
  const stub = stubFetch(workday(postings, details));
  try {
    return await fetchLists({ dir, platforms: ['workday'], now: new Date(when), log: quiet });
  } finally {
    stub.restore();
  }
}

async function runAt(dir, when, requests = []) {
  const stub = stubFetch([blocked, contoso, claude(requests)]);
  try {
    return await run(['--no-notify'], ENV, { dir, now: new Date(when), log: quiet });
  } finally {
    stub.restore();
  }
}

test('axia fetch saves a Workday board, with the text of the roles in your titles and places only', async () => {
  const dir = tempProject({ companies: [WOODGROVE, CONTOSO] });
  const details = [];
  const out = await fetchAt(dir, '2026-11-18T13:00:00Z', POSTINGS, details);
  assert.deepEqual(out, { saved: 1, failed: 0 });
  assert.equal(listsIn(dir).length, 1, 'one file for the Workday board; the Greenhouse board is read by the daily run');
  assert.match(listsIn(dir)[0], /^workday-woodgrove-[0-9a-f]{8}\.json$/);

  const saved = savedList(dir);
  assert.equal(saved.url, WOODGROVE.url);
  assert.equal(saved.fetchedOn, '2026-11-18');
  assert.equal(saved.jobs.length, 4, 'every listed role is saved, so the daily run can tell which closed');
  const byTitle = Object.fromEntries(saved.jobs.map((j) => [j.title, j]));
  assert.match(byTitle['Payments Solution Architect'].description, /card issuing/);
  assert.equal(byTitle['Enterprise Architect'].location, 'Pune, India; Bengaluru, India', 'a "2 Locations" role has its places read from the posting');
  assert.equal(byTitle['Sales Intern'].description, undefined, 'an excluded title is not read');
  assert.equal(byTitle['Solution Architect'].description, undefined, 'a role outside your places is not read');
  assert.equal(details.length, 2);

  // The next fetch reads only postings it hasn't read before.
  details.length = 0;
  await fetchAt(dir, '2026-11-18T17:00:00Z', [...POSTINGS, posting('Head of Payments Architecture', '/job/Pune/Head-of-Payments-Architecture_R-205', 'Pune, India')], details);
  assert.equal(details.length, 1);
  assert.match(savedList(dir).jobs.find((j) => j.title === 'Payments Solution Architect').description, /card issuing/);

  // A board taken out of companies.yml loses its list.
  writeFileSync(join(dir, 'companies.yml'), JSON.stringify([CONTOSO, { name: 'Fabrikam Capital', url: 'https://fabrikam.wd1.myworkdayjobs.com/External' }]));
  const stub = stubFetch([['fabrikam.wd1.myworkdayjobs.com/wday/cxs/fabrikam/External/jobs', () => ({ total: 0, jobPostings: [] })]]);
  try {
    await fetchLists({ dir, platforms: ['workday'], now: new Date('2026-11-19T13:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  assert.deepEqual(listsIn(dir).map((f) => f.split('-')[1]), ['fabrikam']);
});

test('axia fetch fails when no board can be read here either, and keeps the list saved before', async () => {
  const dir = tempProject({ companies: [WOODGROVE] });
  await fetchAt(dir, '2026-11-18T13:00:00Z', POSTINGS);
  const stub = stubFetch([blocked]);
  try {
    await assert.rejects(fetchLists({ dir, platforms: ['workday'], now: new Date('2026-11-19T13:00:00Z'), log: quiet }), /could be read from this computer either/);
  } finally {
    stub.restore();
  }
  assert.equal(savedList(dir).fetchedOn, '2026-11-18');
  await assert.rejects(fetchLists({ dir, platforms: [], log: quiet }), /needs --platform/);
  await assert.rejects(fetchLists({ dir, platforms: ['lever'], log: quiet }), /No board in companies.yml is on lever/);
});

test('a board the bot check stops is read from its saved list: new roles scored with their text, missing ones closed', async () => {
  const dir = tempProject({ companies: [WOODGROVE, CONTOSO] });
  await fetchAt(dir, '2026-11-18T13:00:00Z', POSTINGS);

  // Night 1: Workday shows GitHub's servers its bot check; the saved list stands in.
  const requests = [];
  let out = await runAt(dir, '2026-11-18T21:00:00Z', requests);
  assert.equal(out.exitCode, 0);
  assert.equal(out.summary.counts.new, 2);
  const wg = out.summary.companies.find((c) => c.company === 'Woodgrove Bank');
  assert.equal(wg.status, 'ok');
  assert.equal(wg.savedOn, '2026-11-18');
  assert.ok(requests.every((r) => /card issuing target architecture/.test(r)), 'scored with the posting text read on the other computer');
  let state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  assert.equal(state.companies['Woodgrove Bank'].lastReadOk, '2026-11-18');
  assert.match(readFileSync(join(dir, 'dashboard/README.md'), 'utf8'), /Woodgrove Bank \| ✅ read from the list saved on 2026-11-18/);
  assert.match(readFileSync(join(dir, '.axia/site/index.html'), 'utf8'), /"savedOn":"2026-11-18"/);

  // Night 2: a newer list without one of the roles closes it, as a normal read would.
  await fetchAt(dir, '2026-11-19T13:00:00Z', POSTINGS.filter((p) => p.title !== 'Enterprise Architect'));
  out = await runAt(dir, '2026-11-19T21:00:00Z');
  assert.equal(out.summary.counts.new, 0);
  assert.equal(out.summary.counts.closedToday, 1);
  assert.equal(out.summary.ai.scored, 0, 'nothing is scored twice');
  state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  assert.equal(Object.values(state.jobs).find((j) => j.title === 'Enterprise Architect').closedReason, 'no longer listed');
  assert.equal(state.companies['Woodgrove Bank'].lastReadOk, '2026-11-19');

  // Night 3: the same list again is still fine; the roles stay as they are.
  out = await runAt(dir, '2026-11-20T21:00:00Z');
  assert.equal(out.summary.companies.find((c) => c.company === 'Woodgrove Bank').status, 'ok');
  assert.equal(out.summary.counts.closedToday, 0);
});

test('a saved list older than the last good read, or 7 days old, is not used', async () => {
  assert.equal(usableList({ fetchedOn: '2026-11-17' }, { lastReadOk: '2026-11-18', today: '2026-11-19' }), null);
  assert.equal(usableList({ fetchedOn: '2026-11-12' }, { lastReadOk: null, today: '2026-11-19' }), null);
  assert.equal(usableList({ fetchedOn: '2026-11-20' }, { lastReadOk: null, today: '2026-11-19' }), null);
  assert.ok(usableList({ fetchedOn: '2026-11-18' }, { lastReadOk: '2026-11-18', today: '2026-11-19' }));
  assert.ok(usableList({ fetchedOn: '2026-11-13' }, { lastReadOk: '2026-11-10', today: '2026-11-19' }));

  const dir = tempProject({ companies: [WOODGROVE, CONTOSO] });
  await fetchAt(dir, '2026-11-01T13:00:00Z', POSTINGS);
  const out = await runAt(dir, '2026-11-18T21:00:00Z');
  const wg = out.summary.companies.find((c) => c.company === 'Woodgrove Bank');
  assert.equal(wg.status, 'failed');
  assert.match(wg.error, /blocked by the site's bot check/);
  assert.equal(existsSync(join(dir, 'data/lists')), true);
});
