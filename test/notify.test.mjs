// What gets sent, that it is one message per run, and that nothing is sent twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMessages, applyDelivery, trackProblems, seedNotified, notifyMinScore, fitTelegram, plainText, tidySummary } from '../src/notify.mjs';
import { emptyState } from '../src/state.mjs';

const settings = {
  report: { timezone: 'Asia/Kolkata', good_match: 65, show_from: 50 },
  notify: { min_score: 65, weekly: 'monday' },
  dashboard: { url: 'https://axia.example.test' },
};

const job = (i, value, extra = {}) => ({
  key: `workday:bank:${i}`,
  company: 'Big Bank',
  title: `Payments Architect ${i}`,
  location: 'Bengaluru, Karnataka, India',
  url: `https://bank.example/${i}`,
  postedAt: '2026-10-14',
  firstSeen: '2026-10-15',
  status: 'open',
  score: { value, scorer: 'ai', summary: `This is a strong match: why ${i} & more.`, strengths: [], gaps: [`Gap ${i}`] },
  ...extra,
});

function stateWith(jobs) {
  const s = emptyState();
  for (const j of jobs) s.jobs[j.key] = j;
  return s;
}
const summary = (extra = {}) => ({ companies: [{ company: 'Big Bank', status: 'ok', listed: 10 }], ai: { enabled: true, stoppedBecause: null }, partial: false, ...extra });
const ok = [{ kind: 'digest', channel: 'telegram', ok: true }];
const plan = (state, today = '2026-10-15', extra = {}) => planMessages({ state, summary: summary(), settings, minScore: 65, today, ...extra });

test('a role is sent once, when its first AI score reaches the threshold', () => {
  const state = stateWith([job(1, 80), job(2, 64), job(3, 90, { score: { value: 90, scorer: 'keyword' } })]);
  const day1 = plan(state);
  assert.equal(day1.length, 1);
  assert.deepEqual(day1[0].keys, ['workday:bank:1'], 'below the line and keyword estimates are never sent');
  const html = day1[0].html;
  assert.match(html, /^<b>Axia<\/b> · 1 new good match/);
  assert.match(html, /<b>80<\/b> · <a href="https:\/\/axia\.example\.test\/#workday-bank-1">Payments Architect 1<\/a>/);
  assert.match(html, /Big Bank · Bengaluru · posted 14 Oct/);
  assert.match(html, /\nWhy 1 &amp; more\.\n/, 'the summary, without "This is a strong match:"');
  assert.match(html, /<i>Watch: Gap 1<\/i>/);
  assert.match(html, /<a href="https:\/\/bank\.example\/1">Posting ↗<\/a>/);
  assert.match(html, /1 good match open · <a href="https:\/\/axia\.example\.test">Open Axia<\/a>$/);
  assert.equal(day1[0].silent, false);
  applyDelivery(state, day1, ok, '2026-10-15');
  assert.equal(state.jobs['workday:bank:1'].notifiedOn, '2026-10-15');

  state.jobs['workday:bank:2'].score.value = 70; // re-scored after a resume change
  assert.deepEqual(plan(state, '2026-10-16')[0].keys, ['workday:bank:2'], 'only the newly good one');
});

test('several matches, a problem and the weekly note arrive as one message', () => {
  const state = stateWith([job(1, 70), job(2, 90)]);
  state.problems['read:Other Bank'] = { kind: 'read', company: 'Other Bank', detail: 'HTTP 500', since: '2026-10-17', notifiedOn: null };
  const [m, ...rest] = plan(state, '2026-10-19');
  assert.equal(rest.length, 0);
  assert.deepEqual(m.parts, ['matches', 'problems', 'weekly']);
  assert.equal(m.subject, 'Axia: 2 new good matches (90, 70)');
  assert.ok(m.html.indexOf('<b>90</b>') < m.html.indexOf('<b>70</b>'), 'best first');
  assert.match(m.html, /<b>Needs attention<\/b>\n⚠️ <b>Other Bank<\/b> unreadable for 3 days \(HTTP 500\)/);
  assert.match(m.html, /<b>Weekly check-in<\/b>\n⚠️ 1 of 1 companies read today · 1 open problem/);
  applyDelivery(state, [m], ok, '2026-10-19');
  assert.equal(state.problems['read:Other Bank'].notifiedOn, '2026-10-19');
  assert.equal(state.lastWeekly, '2026-10-19');
  assert.equal(plan(state, '2026-10-19').length, 0, 'a second run that day stays quiet');
});

test('nothing is marked as sent when delivery failed everywhere', () => {
  const state = stateWith([job(1, 80)]);
  const msgs = plan(state);
  applyDelivery(state, msgs, [{ kind: 'digest', channel: 'telegram', ok: false }], '2026-10-15');
  assert.equal(state.jobs['workday:bank:1'].notifiedOn, undefined, 'tried again tomorrow');
});

test('the threshold comes from NOTIFY_MIN_SCORE when set, else settings', () => {
  const quiet = () => {};
  assert.equal(notifyMinScore(settings, {}, quiet), 65);
  assert.equal(notifyMinScore(settings, { NOTIFY_MIN_SCORE: '' }, quiet), 65);
  assert.equal(notifyMinScore(settings, { NOTIFY_MIN_SCORE: '72' }, quiet), 72);
  assert.equal(notifyMinScore(settings, { NOTIFY_MIN_SCORE: 'high' }, quiet), 65);
  assert.equal(plan(stateWith([job(1, 70)]), '2026-10-15', { minScore: 72 }).length, 0);
});

test('upgrading from the daily digest does not resend matches you already saw', () => {
  const state = stateWith([job(1, 80), job(2, 40)]);
  assert.equal(seedNotified(state, 65, '2026-10-15'), 1);
  assert.equal(plan(state).length, 0);
});

test('an unreadable company is reported on the third day, once per streak', () => {
  const state = stateWith([]);
  const failing = summary({ companies: [{ company: 'Big Bank', status: 'failed', error: 'HTTP 500', listed: 0 }] });
  const planFor = (today) => planMessages({ state, summary: failing, settings, minScore: 65, today });
  for (const [today, expected] of [['2026-10-14', 0], ['2026-10-15', 0], ['2026-10-16', 1]]) {
    trackProblems(state, failing, today);
    assert.equal(planFor(today).length, expected, today);
  }
  const msg = planFor('2026-10-16')[0];
  assert.match(msg.html, /^<b>Axia<\/b> · needs your attention\n\n⚠️ <b>Big Bank<\/b> unreadable for 3 days \(HTTP 500\)/);
  assert.equal(msg.subject, 'Axia needs your attention');
  applyDelivery(state, [msg], ok, '2026-10-16');
  trackProblems(state, failing, '2026-10-17');
  assert.equal(planFor('2026-10-17').length, 0, 'not repeated');

  trackProblems(state, summary(), '2026-10-18');
  assert.deepEqual(state.problems, {}, 'cleared once readable');
});

test('AI scoring failing on two runs in a row is reported; a one-off is not', () => {
  const state = stateWith([]);
  const broken = summary({ ai: { enabled: true, stoppedBecause: 'Invalid OAuth token' } });
  trackProblems(state, broken, '2026-10-15');
  assert.equal(planMessages({ state, summary: broken, settings, minScore: 65, today: '2026-10-15' }).length, 0);
  trackProblems(state, broken, '2026-10-16');
  const [msg] = planMessages({ state, summary: broken, settings, minScore: 65, today: '2026-10-16' });
  assert.match(msg.html, /<b>AI scoring<\/b> failed on two runs in a row \(Invalid OAuth token\)/);
  assert.match(msg.html, /<code>claude setup-token<\/code>/);
});

test('a run limited to some companies never clears problems', () => {
  const state = stateWith([]);
  trackProblems(state, summary({ companies: [{ company: 'Big Bank', status: 'failed', error: 'x' }] }), '2026-10-15');
  trackProblems(state, summary({ partial: true, companies: [] }), '2026-10-16');
  assert.ok(state.problems['read:Big Bank']);
});

test('the weekly note alone is a short, silent check-in on the chosen day', () => {
  const state = stateWith([job(1, 80, { notifiedOn: '2026-10-15' }), job(2, 55), job(3, 30, { score: { value: 30, scorer: 'keyword' } }), job(4, 70, { status: 'closed', closedOn: '2026-10-17' })]);
  assert.equal(plan(state, '2026-10-18').length, 0, 'Sunday: nothing');
  const [weekly] = plan(state, '2026-10-19');
  assert.deepEqual(weekly.parts, ['weekly']);
  assert.equal(weekly.silent, true);
  assert.equal(weekly.subject, 'Axia weekly check-in: 1 good match open');
  assert.equal(
    plainText(weekly.html),
    [
      'Axia · weekly check-in, 19 Oct',
      '',
      '✓ 1 of 1 companies read today',
      'New this week: 4 roles · 1 good match · 1 closed',
      'Open now: 1 good match (65+) · 1 worth a look · 3 in all',
      '1 waiting for an AI score',
      '',
      'Open Axia (https://axia.example.test)',
    ].join('\n'),
  );
  assert.equal(planMessages({ state, summary: summary(), settings: { ...settings, notify: { min_score: 65, weekly: false } }, minScore: 65, today: '2026-10-26' }).length, 0, 'weekly: false turns it off');
});

test('a long list is shortened, never the problems or the weekly note', () => {
  const state = stateWith(Array.from({ length: 40 }, (_, i) => job(i, 99 - i, { title: 'A very long title '.repeat(10), score: { value: 99 - i, scorer: 'ai', summary: 'Long reason. '.repeat(30), gaps: ['A long gap. '.repeat(20)] } })));
  state.problems.ai = { kind: 'ai', detail: 'x', since: '2026-10-17', notifiedOn: null };
  const [m] = plan(state, '2026-10-19');
  assert.equal(m.keys.length, 35, 'every new match is marked, even those not listed');
  assert.ok(m.html.length <= 4000, String(m.html.length));
  assert.match(m.html, /…and \d+ more on the dashboard\./);
  assert.match(m.html, /<b>Needs attention<\/b>/);
  assert.match(m.html, /<b>Weekly check-in<\/b>/);
  assert.equal(fitTelegram(m.html), m.html);
});

test('summaries drop the "this is a good match" preamble', () => {
  assert.equal(tidySummary('This is a strong match: a payments VP role.'), 'A payments VP role.');
  assert.equal(tidySummary('This looks like a solid fit, given your SWIFT work.'), 'Given your SWIFT work.');
  assert.equal(tidySummary('A payments VP role that fits.'), 'A payments VP role that fits.');
});

test('cities and dates read cleanly; long text is cut at a word', async () => {
  const { clip } = await import('../src/notify.mjs');
  const state = stateWith([job(1, 80, { location: 'Northwind Global Services Pvt. Ltd. - Bengaluru (Tech Park)', postedAt: '2026-09-29' })]);
  assert.match(plan(state)[0].html, /Big Bank · Bengaluru · posted 29 Sep/);
  assert.equal(clip('a payments platform role at a network company', 30), 'a payments platform role at a…');
  assert.equal(clip('short', 30), 'short');
});

test('many unreadable companies fold into one line, so the problems always fit', () => {
  const state = stateWith([]);
  for (let i = 0; i < 60; i++) state.problems[`read:Company ${i}`] = { kind: 'read', company: `Company number ${i} with a long name`, detail: 'HTTP 500 '.repeat(20), since: '2026-10-13', notifiedOn: null };
  const [m] = plan(state, '2026-10-16');
  assert.equal(m.problemKeys.length, 60);
  assert.match(m.html, /⚠️ <b>60 companies<\/b> unreadable for 3 days or more: Company number 0 with a long name, /);
  assert.ok(m.html.length < 1500, String(m.html.length));
});

test('a new match says whether it is a step up, the same level or a step down', () => {
  const up = job(1, 80);
  up.score.level = { vs: 'up', note: '≈ Executive Director', rev: 'r' };
  const unclear = job(2, 70);
  unclear.score.level = { vs: 'unclear', rev: 'r' };
  const [m] = plan(stateWith([up, unclear]));
  assert.match(m.html, /Bengaluru · posted [^\n]* · Step up\n/);
  assert.doesNotMatch(m.html, /unclear/i, 'no label when the posting does not settle it');
});
