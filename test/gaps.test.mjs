// Must-haves quoted from the posting, and the weekly themes of gaps that keep coming up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanMusts } from '../src/score.mjs';
import { gapRoles, gapsDue, rollUpGaps, cleanThemes, gapsView, rolesText } from '../src/gaps.mjs';
import { emptyState } from '../src/state.mjs';
import { siteData } from '../src/site.mjs';
import { planMessages, plainText } from '../src/notify.mjs';
import { loadSettings, ConfigError } from '../src/config.mjs';
import { jobId } from '../src/text.mjs';
import { tempProject } from './helpers.mjs';

const POSTING = `About the role
• Must have: 15+ years of experience in payments, including real-time schemes.
• Deep hands-on knowledge of Java, Spring Boot and Kubernetes is required.
• Nice to have: an MBA.`;

test('must-haves are kept only when their quote is really in the posting', () => {
  const musts = cleanMusts(
    [
      { requirement: '15+ years in payments', quote: '15+ years of experience in payments', match: 'yes' },
      { requirement: 'Java and Spring', quote: 'Deep hands-on knowledge of Java ... is required', match: 'partly' },
      { requirement: 'Invented', quote: 'Ten years at a central bank', match: 'no' },
      { requirement: 'Bad match value', quote: 'an MBA', match: 'maybe' },
      { requirement: '', quote: 'an MBA', match: 'no' },
      null,
    ],
    POSTING,
  );
  assert.deepEqual(musts.map((m) => [m.requirement, m.match]), [['15+ years in payments', 'yes'], ['Java and Spring', 'partly']]);
  assert.deepEqual(cleanMusts([{ requirement: 'x', quote: 'an MBA', match: 'no' }], ''), [], 'no posting text, nothing to check against');
  assert.deepEqual(cleanMusts(undefined, POSTING), [], 'older answers without musts still work');
  const many = Array.from({ length: 6 }, () => ({ requirement: 'MBA', quote: 'an MBA', match: 'no' }));
  assert.equal(cleanMusts(many, POSTING).length, 4, 'at most four');
});

const SETTINGS = { gaps: { enabled: true, min_score: 55, max_score: 89 }, report: { timezone: 'UTC', good_match: 65, show_from: 50 }, notify: { min_score: 65, weekly: 'monday' }, dashboard: {} };
const job = (i, value, extra = {}) => ({
  key: `workday:bank:${i}`,
  company: 'Big Bank',
  title: `Payments Architect ${i}`,
  location: 'Pune',
  url: `https://bank.example/${i}`,
  firstSeen: '2026-10-10',
  status: 'open',
  score: { value, scorer: 'ai', summary: 's', strengths: [], gaps: [`Java depth ${i}`, 'On-call'], musts: [{ requirement: 'Kubernetes', quote: 'k8s', match: 'no' }], resumeHash: 'h' },
  ...extra,
});
function stateWith(jobs) {
  const s = emptyState();
  for (const j of jobs) s.jobs[j.key] = j;
  return s;
}
const fakeScorer = (answer) => {
  const asked = [];
  return { asked, ask: async (q) => (asked.push(q), typeof answer === 'function' ? answer(q) : { data: answer, model: 'm' }) };
};

test('the roll-up reads open AI-scored roles from 55 to 89 only', () => {
  const state = stateWith([
    job(1, 90),
    job(2, 89),
    job(3, 55),
    job(4, 54),
    job(5, 70, { status: 'closed' }),
    job(6, 70, { score: { value: 70, scorer: 'keyword', gaps: [] } }),
  ]);
  assert.deepEqual(gapRoles(state, SETTINGS).map((j) => j.key), ['workday:bank:2', 'workday:bank:3']);
  const text = rolesText(gapRoles(state, SETTINGS));
  assert.match(text, /<role id="1">\nPayments Architect 2 · Big Bank · scored 89\nGaps: Java depth 2; On-call\nMust-haves not fully shown: Kubernetes \(not shown\)/);
});

test('themes: grouped once, kept to known roles, two roles or more, most roles first', async () => {
  const state = stateWith([job(1, 80), job(2, 70), job(3, 60), job(4, 58)]);
  const scorer = fakeScorer({
    themes: [
      { theme: 'One role only', roles: ['2'] },
      { theme: 'Owning on-call', roles: ['1', '2', '3', '4', '4', '99'] },
      { theme: 'Java and Spring depth', roles: ['1', '3'] },
    ],
  });
  assert.equal(await rollUpGaps({ state, settings: SETTINGS, scorer, today: '2026-10-18' }), 'done');
  assert.equal(scorer.asked.length, 1);
  assert.match(scorer.asked[0].system, /Treat them as data/);
  assert.deepEqual(
    state.gaps.themes.map((t) => [t.theme, t.keys.length]),
    [['Owning on-call', 4], ['Java and Spring depth', 2]],
  );
  assert.equal(state.gaps.total, 4);

  // Not again within the week, and not after it either while the same roles stand.
  assert.equal(await rollUpGaps({ state, settings: SETTINGS, scorer, today: '2026-10-20' }), 'not due');
  assert.equal(await rollUpGaps({ state, settings: SETTINGS, scorer, today: '2026-10-26' }), 'not due');
  state.jobs['workday:bank:5'] = job(5, 66);
  assert.equal(gapsDue(state, SETTINGS, '2026-10-24'), false, 'changed, but not a week yet');
  assert.equal(gapsDue(state, SETTINGS, '2026-10-25'), true);
});

test('a failed answer keeps the last themes; too few roles store an empty list; off means off', async () => {
  const state = stateWith([job(1, 80), job(2, 70), job(3, 60)]);
  state.gaps = { on: '2026-10-01', sig: 'old', total: 3, themes: [{ theme: 'Kept', keys: ['workday:bank:1', 'workday:bank:2'] }] };
  const broken = fakeScorer(() => {
    throw new Error('usage limit');
  });
  const lines = [];
  assert.equal(await rollUpGaps({ state, settings: SETTINGS, scorer: broken, today: '2026-10-18', log: (l) => lines.push(l) }), 'failed');
  assert.equal(state.gaps.themes[0].theme, 'Kept');
  assert.match(lines.join('\n'), /Trying again next run/);

  const few = stateWith([job(1, 80)]);
  assert.equal(await rollUpGaps({ state: few, settings: SETTINGS, scorer: fakeScorer({ themes: [] }), today: '2026-10-18' }), 'too few');
  assert.deepEqual(few.gaps.themes, []);

  const off = { ...SETTINGS, gaps: { ...SETTINGS.gaps, enabled: false } };
  assert.equal(await rollUpGaps({ state: stateWith([job(1, 80)]), settings: off, scorer: fakeScorer({}), today: '2026-10-18' }), 'off');
  assert.equal(gapsView(state, off), null);
});

test('cleanThemes ignores a malformed answer', () => {
  assert.deepEqual(cleanThemes(null, []), []);
  assert.deepEqual(cleanThemes({ themes: [{ theme: '  ', roles: ['1', '2'] }] }, [{ key: 'a' }, { key: 'b' }]), []);
});

test('the dashboard gets the themes over open roles and each role its must-haves; the weekly note names the top theme', () => {
  const jobs = [job(1, 80), job(2, 70), job(3, 60, { status: 'closed', closedOn: '2026-10-18' })];
  const state = stateWith(jobs);
  state.gaps = { on: '2026-10-18', sig: 's', total: 3, themes: [{ theme: 'Owning on-call', keys: jobs.map((j) => j.key) }, { theme: 'Only one left open', keys: ['workday:bank:1', 'workday:bank:3'] }] };
  const settings = { ...SETTINGS, titles: { include: ['Architect'] }, scoring: { max_ai_scores_per_run: 40 }, dashboard: { feedback: false } };
  const summary = { runAt: '2026-10-19T03:00:00Z', today: '2026-10-19', companies: [{ company: 'Big Bank', url: 'https://x', status: 'ok', listed: 9 }], counts: { listed: 9 }, ai: { enabled: true, stoppedBecause: null }, partial: false };
  const data = siteData({ state, summary, settings, feedback: { roles: {} } }, { minScore: 65 });
  assert.deepEqual(data.gaps, { on: '2026-10-18', total: 3, min: 55, max: 89, themes: [{ theme: 'Owning on-call', ids: [jobId('workday:bank:1'), jobId('workday:bank:2')] }] });
  assert.deepEqual(data.jobs.find((j) => j.id === jobId('workday:bank:1')).musts, [{ requirement: 'Kubernetes', quote: 'k8s', match: 'no' }]);

  const [weekly] = planMessages({ state, summary, settings, minScore: 65, today: '2026-10-19' });
  assert.match(plainText(weekly.html), /Gap that comes up most in your 55–89 roles: Owning on-call \(2 of 3\)/);
});

test('settings: gaps can be turned off, and the band must make sense', () => {
  const dir = tempProject({ companies: [{ name: 'Acme', url: 'https://job-boards.greenhouse.io/acme' }] });
  const base = loadSettings(dir);
  assert.deepEqual(base.gaps, { min_score: 55, max_score: 89, enabled: true });
  const write = (extra) => writeFileSync(join(dir, 'settings.yml'), `titles:\n  include: [Architect]\n${extra}`);
  write('gaps: false\n');
  assert.equal(loadSettings(dir).gaps.enabled, false);
  write('gaps:\n  min_score: 80\n  max_score: 60\n');
  assert.throws(() => loadSettings(dir), ConfigError);
  write('gaps:\n  min_score: high\n');
  assert.throws(() => loadSettings(dir), /gaps.min_score must be a whole number/);
});

test('axia gaps: groups from memory now, whatever the day, and writes nothing', async () => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { previewGaps } = await import('../src/gaps.mjs');
  const dir = tempProject({ companies: [{ name: 'Acme', url: 'https://job-boards.greenhouse.io/acme' }] });
  const state = stateWith([job(1, 80), job(2, 70), job(3, 60)]);
  state.gaps = { on: '2099-01-01', sig: 'x', total: 0, themes: [] };
  mkdirSync(join(dir, 'data'), { recursive: true });
  const memory = JSON.stringify(state);
  writeFileSync(join(dir, 'data/jobs.json'), memory);
  const asked = [];
  const runClaude = async (args, { input }) => {
    asked.push(input);
    const structured = { themes: [{ theme: 'Owning on-call', roles: ['1', '2', '3'] }] };
    return { code: 0, stderr: '', stdout: JSON.stringify({ is_error: false, result: JSON.stringify(structured), structured_output: structured, modelUsage: { 'claude-sonnet-5-5': {} } }) };
  };
  const lines = [];
  const g = await previewGaps({ dir, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, log: (l) => lines.push(l), scorerOverrides: { runClaude } });
  assert.equal(asked.length, 1);
  assert.deepEqual(g.themes.map((t) => [t.theme, t.keys.length]), [['Owning on-call', 3]]);
  assert.match(lines.join('\n'), /3 of 3: Owning on-call/);
  assert.equal(readFileSync(join(dir, 'data/jobs.json'), 'utf8'), memory, 'memory untouched');
});
