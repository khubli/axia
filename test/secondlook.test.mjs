// The second look: titles your words reject, in your places, judged by the model from the title.
// It may only let roles in, asks about each title once, and changes nothing when it fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { secondLook } from '../src/secondlook.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const COMPANIES = [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }];
const gh = (id, title, location) => ({
  id,
  title,
  location: { name: location },
  absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  first_published: '2026-10-14T10:00:00Z',
  content: `&lt;p&gt;${title}: what the job is.&lt;/p&gt;`,
});
const JOBS = [
  gh(1, 'Senior Solution Architect', 'Pune'), // has one of your title words
  gh(2, 'Executive Manager - Technology Modernisation', 'Pune'), // none of your words: the second look keeps it
  gh(3, 'Staff Software Engineer', 'Pune'), // none of your words: the second look leaves it out
  gh(4, 'Sales Director', 'Pune'), // an excluded word: never asked about
  gh(5, 'Executive Manager - Payments', 'New York'), // outside your places: never asked about
];
const ENV = { ANTHROPIC_API_KEY: 'test-key' };
const quiet = () => {};

/** A Claude API stand-in. The second look keeps "Executive Manager" titles; every scored role gets 70. */
function claude(requests, { failSecondLook = false } = {}) {
  return ['/v1/messages', (_url, init) => {
    const body = JSON.parse(init.body);
    const kind = body.system[0].text.includes('deserve a full read') ? 'second-look' : 'score';
    requests.push({ kind, body });
    if (kind === 'second-look' && failSecondLook) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const lines = [...body.messages[0].content.matchAll(/^(\d+) \| [^|]+ \| (.*)$/gm)];
    const text = kind === 'second-look'
      ? JSON.stringify({ keep: lines.filter((m) => /Executive Manager/.test(m[2])).map((m) => ({ id: m[1], why: 'senior technology leadership' })) })
      : JSON.stringify({ score: 70, summary: 'Fits.', strengths: [], gaps: [] });
    return { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 10, output_tokens: 10 } };
  }];
}

async function day(dir, requests, date, { argv = ['--no-notify'], failSecondLook = false, log = quiet } = {}) {
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: JOBS })], claude(requests, { failSecondLook })]);
  try {
    return await run(argv, ENV, { dir, now: new Date(`${date}T03:00:00Z`), log });
  } finally {
    stub.restore();
  }
}

test('the second look lets through a title your words missed, and asks about each title once', async () => {
  const dir = tempProject({ companies: COMPANIES });
  const requests = [];
  let out = await day(dir, requests, '2026-10-15');

  const asked = requests.filter((r) => r.kind === 'second-look');
  assert.equal(asked.length, 1);
  const list = asked[0].body.messages[0].content;
  assert.match(list, /Executive Manager - Technology Modernisation/);
  assert.match(list, /Staff Software Engineer/);
  assert.doesNotMatch(list, /Sales Director/, 'an excluded word is your decision, not the model\'s');
  assert.doesNotMatch(list, /Executive Manager - Payments/, 'outside your places');
  assert.doesNotMatch(list, /Senior Solution Architect/, 'already matched by your words');
  assert.deepEqual(out.summary.secondLook, { titles: 2, checked: 2, letThrough: 1, roles: 1, stoppedBecause: null });
  assert.match(asked[0].body.system[0].text, /<title_words>\nSolution Architect, Architect, Vice President\n<\/title_words>/, 'the model sees your own title words');

  let state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  const kept = state.jobs['greenhouse:acme:2'];
  assert.equal(kept.secondLook, 'senior technology leadership');
  assert.equal(kept.titleMatch, null);
  assert.equal(kept.score.value, 70, 'scored in full like any other role');
  assert.equal(state.jobs['greenhouse:acme:3'], undefined);
  assert.equal(Object.keys(state.titleChecks).length, 2);

  // Next day: same titles, no new question to the model, and the role stays.
  requests.length = 0;
  out = await day(dir, requests, '2026-10-16');
  assert.equal(requests.filter((r) => r.kind === 'second-look').length, 0);
  state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  assert.equal(state.jobs['greenhouse:acme:2'].status, 'open');
  assert.equal(out.summary.counts.new, 0);
});

test('when the second look fails, nothing is let through, the run carries on, and it asks again next run', async () => {
  const dir = tempProject({ companies: COMPANIES });
  const requests = [];
  const out = await day(dir, requests, '2026-10-15', { failSecondLook: true });
  assert.equal(out.exitCode, 0);
  assert.ok(out.summary.secondLook.stoppedBecause);
  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  assert.equal(state.jobs['greenhouse:acme:2'], undefined);
  assert.deepEqual(state.titleChecks, {}, 'no verdict, so the titles are asked about again');
  assert.equal(state.jobs['greenhouse:acme:1'].score.value, 70, 'scoring is unaffected');
});

test('titles.second_look: false never asks the model about titles', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { titles: { include: ['Solution Architect'], exclude: ['Sales'], second_look: false } } });
  const requests = [];
  const out = await day(dir, requests, '2026-10-15');
  assert.equal(requests.filter((r) => r.kind === 'second-look').length, 0);
  assert.equal(out.summary.secondLook.roles, 0);
});

test('axia second-look previews every rejected title and writes nothing', async () => {
  const dir = tempProject({ companies: COMPANIES });
  const requests = [];
  const lines = [];
  const out = await day(dir, requests, '2026-10-15', { argv: ['--second-look-preview'], log: (l) => lines.push(l) });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.preview, { titles: 2, letThrough: 1 });
  const text = lines.join('\n');
  assert.match(text, /\+ Executive Manager - Technology Modernisation — senior technology leadership/);
  assert.match(text, /Left out: 1 title\(s\):\n {2}Acme Bank: Staff Software Engineer/);
  assert.equal(requests.filter((r) => r.kind === 'score').length, 0, 'nothing is scored');
  assert.equal(existsSync(join(dir, 'data/jobs.json')), false, 'nothing is written');
});

test('secondLook: batches of 150, a failed batch gets no verdict, a fatal error stops', async () => {
  const titles = Array.from({ length: 160 }, (_, i) => ({ id: `t${i}`, company: 'Acme', title: i % 2 ? 'Head of Payments' : 'Teller' }));
  const calls = [];
  const keepHeads = (input) => ({ data: { keep: [...input.matchAll(/^(\d+) \| Acme \| Head of Payments$/gm)].map((m) => ({ id: m[1], why: 'payments leadership' })) } });
  let out = await secondLook({ ask: async ({ input }) => (calls.push(input), keepHeads(input)) }, titles, { resume: 'R', criteria: 'C' });
  assert.equal(calls.length, 2);
  assert.equal(out.verdicts.size, 160);
  assert.deepEqual(out.verdicts.get('t1'), { keep: true, why: 'payments leadership' });
  assert.deepEqual(out.verdicts.get('t0'), { keep: false, why: null });

  let n = 0;
  out = await secondLook({ ask: async ({ input }) => (n++ === 0 ? Promise.reject(new Error('timeout')) : keepHeads(input)) }, titles, { resume: 'R', criteria: 'C' });
  assert.equal(out.verdicts.size, 10, 'the first batch failed: those titles have no verdict');
  assert.equal(out.stoppedBecause, null);

  const fatal = Object.assign(new Error('invalid key'), { fatal: true });
  out = await secondLook({ ask: async () => Promise.reject(fatal) }, titles, { resume: 'R', criteria: 'C' });
  assert.equal(out.stoppedBecause, 'invalid key');
  assert.equal(out.verdicts.size, 0);
});

test('the Companies tab lists what your filters left out, and memory does not keep it', async () => {
  const dir = tempProject({ companies: COMPANIES });
  const jobs = [...JOBS, gh(6, 'Solution Architect', 'New York'), gh(7, 'Lead Architect', 'New York'), gh(8, 'Staff Software Engineer', 'Bengaluru')];
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs })], claude([])]);
  let out;
  try {
    out = await run(['--no-notify'], ENV, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet });
  } finally {
    stub.restore();
  }
  const nm = out.summary.nearMisses;
  assert.deepEqual(
    nm.titles.map((t) => [t.title, t.why, t.roles, t.word]),
    [
      ['Staff Software Engineer', 'second-look', 2, undefined], // one entry per title, two roles
      ['Sales Director', 'excluded', 1, 'Sales'],
    ],
    'the title the second look let in is not listed; one outside your places is not either',
  );
  assert.equal(nm.titles[0].url, 'https://job-boards.greenhouse.io/acme/jobs/3');
  assert.deepEqual(nm.places, [{ place: 'New York', roles: 2, example: 'Solution Architect · Acme Bank' }]);
  assert.equal(nm.placeRoles, 2);

  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  assert.equal(state.lastRun.nearMisses, undefined, 'kept out of jobs.json, so it does not churn daily');
  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  assert.match(html, /"nearMisses":\{"titles":\[/);
  assert.match(readFileSync(join(dir, 'dashboard/README.md'), 'utf8'), /Left out by your filters in this run: 2 title\(s\)/);
});

test('with the second look off, titles your words reject are still listed as left out', async () => {
  const dir = tempProject({ companies: COMPANIES, settings: { titles: { include: ['Solution Architect'], exclude: ['Sales'], second_look: false } } });
  const requests = [];
  const out = await day(dir, requests, '2026-10-15');
  assert.equal(requests.filter((r) => r.kind === 'second-look').length, 0);
  assert.deepEqual(
    out.summary.nearMisses.titles.map((t) => [t.title, t.why]),
    [['Executive Manager - Technology Modernisation', 'words'], ['Staff Software Engineer', 'words'], ['Sales Director', 'excluded']],
  );
});
