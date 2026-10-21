// Pay range per role: asked for in the scoring call, checked, and shown on the dashboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { cleanPay, payContext, loadPayGuide, PAY_RULES } from '../src/pay.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const POSTING = 'Lead our payments platform. Compensation: INR 45,00,000 to 60,00,000 per annum, plus bonus.';

test('pay stated on the posting is kept with its own words', () => {
  const p = cleanPay({ source: 'posting', currency: 'inr', low: 6000000, high: 4500000, period: 'year', quote: 'INR 45,00,000 to 60,00,000 per annum', basis: '' }, POSTING);
  assert.deepEqual(p, { source: 'posting', currency: 'INR', low: 4500000, high: 6000000, period: 'year', quote: 'INR 45,00,000 to 60,00,000 per annum' });
});

test('a "posting" figure the posting does not contain counts only as an estimate', () => {
  const p = cleanPay({ source: 'posting', currency: 'INR', low: 9000000, high: 12000000, period: 'year', quote: 'INR 90 lakh to 1.2 crore', basis: '' }, POSTING);
  assert.equal(p.source, 'estimate');
  assert.equal(p.quote, undefined);
  assert.match(p.basis, /not found word for word/);
});

test('ranges that make no sense become none; no pay answer leaves no field', () => {
  const base = { source: 'estimate', currency: 'INR', period: 'year', quote: '', basis: 'director, Pune' };
  assert.deepEqual(cleanPay({ ...base, low: 0, high: 0 }, ''), { source: 'none' });
  assert.deepEqual(cleanPay({ ...base, low: 100, high: 90000000 }, ''), { source: 'none' }, 'a 20x spread is no guide');
  assert.deepEqual(cleanPay({ ...base, currency: 'rupees', low: 1, high: 2 }, ''), { source: 'none' });
  assert.deepEqual(cleanPay({ ...base, source: 'none', low: 5, high: 6 }, ''), { source: 'none' });
  assert.equal(cleanPay(undefined, ''), undefined);
  assert.deepEqual(cleanPay({ ...base, low: 7000000, high: 9000000 }, ''), { source: 'estimate', currency: 'INR', low: 7000000, high: 9000000, period: 'year', basis: 'director, Pune' });
});

const TABLE = `currency: INR
companies:
  Acme Bank:
    source: Levels.fyi, India, median total pay
    Software Engineering Manager: { L6: 5816612, L5: 8683665 }
    Solution Architect: about 50 to 70 lakh
  Big Tech:
    currency: USD
    Software Engineer: { L5: 185000 }
`;

test('your pay table: only the role\'s own employer goes into its request, in short amounts', () => {
  const dir = tempProject({ companies: [] });
  writeFileSync(join(dir, 'pay.yml'), TABLE);
  const guide = loadPayGuide({ scoring: { pay: 'pay.yml' } }, dir);
  assert.equal(
    payContext({ company: 'acme bank' }, guide),
    '<pay-data currency="INR" source="Levels.fyi, India, median total pay">\nSoftware Engineering Manager: L6 ₹58.2L, L5 ₹86.8L\nSolution Architect: about 50 to 70 lakh\n</pay-data>',
  );
  assert.equal(payContext({ company: 'Big Tech' }, guide), '<pay-data currency="USD">\nSoftware Engineer: L5 185k USD\n</pay-data>');
  assert.equal(payContext({ company: 'Nobody' }, guide), '');
  // No table, or pay turned off: nothing to add, and the run still works.
  assert.equal(loadPayGuide({ scoring: { pay: 'missing.yml' } }, dir).companies.size, 0);
  assert.equal(loadPayGuide({ scoring: { pay: false } }, dir).companies.size, 0);
  // A changed table has a new rev, so a catch-up pass can refill pay on older roles.
  const before = guide.rev;
  writeFileSync(join(dir, 'pay.yml'), TABLE.replace('5816612', '6000000'));
  assert.notEqual(loadPayGuide({ scoring: { pay: 'pay.yml' } }, dir).rev, before);
});

test('a nightly run asks for pay in the same call, stores it, and shows it on the dashboard', async () => {
  const board = [1, 2].map((id) => ({
    id,
    title: id === 1 ? 'Payments Architect' : 'Solution Architect',
    location: { name: 'Pune' },
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    first_published: '2026-10-14T10:00:00Z',
    content: id === 1 ? `&lt;p&gt;${POSTING}&lt;/p&gt;` : '&lt;p&gt;Own the integration architecture.&lt;/p&gt;',
  }));
  const dir = tempProject({ companies: [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }] });
  writeFileSync(join(dir, 'pay.yml'), TABLE);
  const calls = [];
  const runClaude = async (args, { input }) => {
    calls.push({ args, input, system: readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8') });
    const ids = [...input.matchAll(/<job id="(\d+)">\nCompany: .*\nTitle: (.*)/g)].map((m) => [m[1], m[2]]);
    const results = ids.map(([id, title]) => ({
      id, score: 72, summary: 's', strengths: [], gaps: [], musts: [],
      pay: title === 'Payments Architect'
        ? { source: 'posting', currency: 'INR', low: 4500000, high: 6000000, period: 'year', quote: 'INR 45,00,000 to 60,00,000 per annum', basis: '' }
        : { source: 'table', currency: 'INR', low: 5000000, high: 7000000, period: 'year', quote: '', basis: 'Solution Architect' },
    }));
    return { code: 0, stderr: '', stdout: JSON.stringify({ is_error: false, structured_output: { results }, modelUsage: { 'claude-sonnet-5-5': {} } }) };
  };
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: board })]]);
  try {
    await run(['--no-notify'], { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, { dir, now: new Date('2026-10-15T03:00:00Z'), log: () => {}, scorerOverrides: { runClaude } });
  } finally {
    stub.restore();
  }
  assert.equal(calls.length, 1, 'no extra request for pay');
  const { args, input, system } = calls[0];
  assert.ok(system.includes(PAY_RULES), 'the pay rules sit in the system prompt once');
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.ok(schema.properties.results.items.required.includes('pay'));
  assert.equal(input.match(/<pay-data /g).length, 2, 'each Acme Bank job carries Acme Bank\'s lines');
  assert.ok(!input.includes('Big Tech') && !input.includes('185k'), 'other employers\' lines stay out');

  const state = JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8'));
  const pay = Object.fromEntries(Object.values(state.jobs).map((j) => [j.title, j.score.pay]));
  assert.equal(pay['Payments Architect'].source, 'posting');
  assert.equal(pay['Solution Architect'].source, 'table');

  const site = join(dir, '.axia/site');
  const html = readdirSync(site).filter((f) => f.endsWith('.html')).map((f) => readFileSync(join(site, f), 'utf8')).join('\n');
  assert.match(html, /"pay":\{"source":"posting","currency":"INR","low":4500000,"high":6000000/);
});

test('roles scored before pay existed get it from the catch-up, with their employer\'s table lines', async () => {
  const board = [{ id: 7, title: 'Payments Architect', location: { name: 'Pune' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/7', first_published: '2026-10-14T10:00:00Z', content: '&lt;p&gt;Own the payments architecture.&lt;/p&gt;' }];
  const dir = tempProject({ companies: [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }] });
  const calls = [];
  const level = { vs: 'same', note: '' };
  const pay = { source: 'table', currency: 'INR', low: 5800000, high: 8700000, period: 'year', quote: '', basis: 'Software Engineering Manager, L5 to L6' };
  const runClaude = (withPay) => async (args, { input }) => {
    const asked = Object.keys(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.results.items.properties);
    calls.push({ catchUp: args[1].startsWith('Answer for all'), asked, input });
    const ids = [...input.matchAll(/<job id="(\d+)">/g)].map((m) => m[1]);
    const results = args[1].startsWith('Answer for all')
      ? ids.map((id) => ({ id, ...(asked.includes('level') ? { level } : {}), ...(asked.includes('pay') ? { pay } : {}) }))
      : ids.map((id) => ({ id, score: 80, summary: 's', strengths: [], gaps: [], musts: [], level, ...(withPay ? { pay } : {}) }));
    return { code: 0, stderr: '', stdout: JSON.stringify({ is_error: false, structured_output: { results }, modelUsage: { 'claude-sonnet-5-5': {} } }) };
  };
  const once = async (withPay, now) => {
    const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: board })]]);
    try {
      await run(['--no-notify'], { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, { dir, now: new Date(now), log: () => {}, scorerOverrides: { runClaude: runClaude(withPay) } });
    } finally {
      stub.restore();
    }
  };
  const payOf = () => Object.values(JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs)[0].score.pay;

  await once(false, '2026-10-15T03:00:00Z'); // as 1.10.0 scored it: a level, no pay
  assert.equal(payOf(), undefined);

  writeFileSync(join(dir, 'pay.yml'), TABLE);
  calls.length = 0;
  await once(true, '2026-10-16T03:00:00Z');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].catchUp);
  assert.deepEqual(calls[0].asked, ['id', 'pay'], 'the level is current, so only pay is asked');
  assert.match(calls[0].input, /<pay-data currency="INR" source="Levels.fyi[^"]*">\nSoftware Engineering Manager: L6 ₹58.2L, L5 ₹86.8L/);
  assert.equal(payOf().source, 'table');
  assert.equal(payOf().rev, loadPayGuide({ scoring: { pay: 'pay.yml' } }, dir).rev);

  calls.length = 0;
  await once(true, '2026-10-17T03:00:00Z');
  assert.equal(calls.length, 0, 'nothing left to catch up');
});
