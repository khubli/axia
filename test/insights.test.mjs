// Insights: what the roles ask for, by theme, counted free from the scored must-haves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileThemes, checkThemes, insightsView, recordInsights, pageInsights, DEFAULT_THEMES } from '../src/insights.mjs';
import { siteData, renderSite } from '../src/site.mjs';
import { loadSettings, ConfigError } from '../src/config.mjs';
import { jobId } from '../src/text.mjs';

const example = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'instance');
const SETTINGS = { report: { timezone: 'UTC', good_match: 65, show_from: 50 }, insights: { enabled: true, themes: null }, gaps: { enabled: false } };

const must = (requirement, quote, match) => ({ requirement, quote, match });
let n = 0;
function role(value, musts, extra = {}) {
  n++;
  return {
    key: `t:${n}`, company: 'Acme', title: `Role ${n}`, location: 'Pune, India', url: `https://x/${n}`, postedAt: '2026-10-01', firstSeen: '2026-10-10', status: 'open',
    score: { value, scorer: 'ai', summary: '', strengths: [], gaps: [], musts },
    ...extra,
  };
}
const stateOf = (jobs) => ({ jobs: Object.fromEntries(jobs.map((j) => [j.key, j])) });

test('theme words: * is a prefix, other words are whole words with an optional plural', () => {
  const [t] = compileThemes([{ name: 'T', words: ['migrat*', 'ai', '.net', 'c++', 'ci/cd', 'hands-on', 'api'] }]);
  for (const yes of ['Migration of legacy', 'migrating', 'Use of AI in design', 'C# and .NET', 'C++ depth', 'CI/CD pipelines', 'hands on coding', 'Hands-on', 'REST APIs', 'an API'])
    assert.ok(t.re.test(yes), yes);
  for (const no of ['maintain the platform', 'aims to', 'internet', 'capital', 'apiary'])
    assert.ok(!t.re.test(no), no);
});

test('each theme counts a role once, and a partly counts half of a match', () => {
  const jobs = [
    role(70, [must('AWS', 'AWS cloud services', 'no'), must('Payments', '10 years in payments', 'yes')]),
    role(60, [must('Azure', 'Azure cloud', 'partly'), must('Cloud native', 'cloud-native patterns', 'no')]),
    role(55, [must('Payments', 'card payments', 'yes')]),
    role(30, [must('Java', 'core Java', 'no')]),
    role(80, []), // no must-haves: counted as a role, not in the shares
    role(50, [must('Payments', 'payments', 'partly')], { score: { value: 50, scorer: 'keyword', musts: [] } }), // not an AI score: left out
  ];
  const v = insightsView(stateOf(jobs), SETTINGS);
  assert.equal(v.fit.roles, 4);
  assert.equal(v.fit.withMusts, 3);
  const cloud = v.fit.themes.find((t) => t.name === 'Public cloud');
  assert.deepEqual([cloud.asked, cloud.askedPct, cloud.yes, cloud.partly, cloud.no, cloud.matchPct], [2, 67, 0, 1, 2, 17]);
  const pay = v.fit.themes.find((t) => t.name === 'Payments');
  assert.deepEqual([pay.asked, pay.matchPct], [2, 100]);
  assert.equal(v.fit.themes[0].name, 'Payments', 'most-asked first, then by name');
  assert.ok(!v.fit.themes.some((t) => t.name === 'Java and Spring'), 'below the band, so only under all roles');
  assert.equal(v.all.themes.find((t) => t.name === 'Java and Spring').asked, 1);
  assert.equal(v.all.roles, 5);
});

test('cities need ten scored roles; closed best-fit roles give a median time to close', () => {
  const jobs = [];
  for (let i = 0; i < 10; i++) jobs.push(role(i < 3 ? 70 : 20, []));
  for (let i = 0; i < 9; i++) jobs.push(role(70, [], { location: 'Mumbai, India' }));
  jobs.push(role(70, [], { location: 'India' }));
  jobs[0].status = 'closed'; jobs[0].firstSeen = '2026-10-10'; jobs[0].closedOn = '2026-10-12';
  jobs[1].status = 'closed'; jobs[1].firstSeen = '2026-10-10'; jobs[1].closedOn = '2026-10-20';
  jobs[3].status = 'closed'; jobs[3].closedOn = '2026-10-11'; // scored below the band: not counted
  const v = insightsView(stateOf(jobs), SETTINGS);
  assert.deepEqual(v.cities, [{ city: 'Pune', scored: 10, fit: 3, fitPct: 30 }]);
  assert.deepEqual(v.closing, { closed: 2, of: 13, medianDays: 6, withinWeek: 1, longest: 10 });
});

test('off, or nothing scored yet, means no tab', () => {
  assert.equal(insightsView(stateOf([role(70, [])]), { ...SETTINGS, insights: { enabled: false } }), null);
  assert.equal(insightsView(stateOf([]), SETTINGS), null);
});

test('a snapshot is kept at most once a week, for later trends', () => {
  const state = stateOf([role(70, [must('Payments', 'payments', 'yes')])]);
  assert.equal(recordInsights(state, SETTINGS, '2026-10-20'), true);
  assert.deepEqual(state.insights.weeks, [{ on: '2026-10-20', roles: 1, themes: { Payments: [100, 100] } }]);
  assert.equal(recordInsights(state, SETTINGS, '2026-10-25'), false);
  assert.equal(recordInsights(state, SETTINGS, '2026-10-27'), true);
  assert.equal(state.insights.weeks.length, 2);
});

test('the page lists only open roles under a theme, by dashboard id, best score first', () => {
  const a = role(60, [must('Payments', 'payments', 'yes')]);
  const b = role(90, [must('Payments', 'payments', 'yes')]);
  const c = role(80, [must('Payments', 'payments', 'yes')], { status: 'closed', closedOn: '2026-10-12' });
  const page = pageInsights(stateOf([a, b, c]), SETTINGS);
  const pay = page.fit.themes.find((t) => t.name === 'Payments');
  assert.deepEqual(pay.ids, [jobId(b.key), jobId(a.key)]);
  assert.equal(pay.keys, undefined);
});

test('settings: insights false turns it off; your own themes replace the list; bad ones are refused', () => {
  const base = readFileSync(join(example, 'settings.yml'), 'utf8');
  const withYaml = (yaml) => {
    const dir = mkdtempSync(join(tmpdir(), 'axia-ins-'));
    writeFileSync(join(dir, 'settings.yml'), base + yaml);
    return dir;
  };
  assert.deepEqual(loadSettings(example).insights, { themes: null, enabled: true });
  assert.equal(loadSettings(withYaml('\ninsights: false\n')).insights.enabled, false);
  const mine = loadSettings(withYaml('\ninsights:\n  themes:\n    - name: " Cloud "\n      words: [cloud*, aws]\n')).insights;
  assert.deepEqual(mine.themes, [{ name: 'Cloud', words: ['cloud*', 'aws'] }]);
  assert.throws(() => loadSettings(withYaml('\ninsights:\n  themes:\n    - name: Cloud\n')), (e) => e instanceof ConfigError && /needs a list of words/.test(e.message));
  assert.throws(() => loadSettings(withYaml('\ninsights:\n  themes: []\n')), ConfigError);
  assert.throws(() => loadSettings(withYaml('\ninsights:\n  themes:\n    - {name: A, words: [x]}\n    - {name: a, words: [y]}\n')), /twice/);
  assert.equal(checkThemes(DEFAULT_THEMES).themes.length, DEFAULT_THEMES.length, 'the built-in list passes its own check');
});

test('the dashboard gets an Insights tab with the counts embedded', () => {
  const jobs = [role(70, [must('Payments', 'payments', 'yes')])];
  const view = {
    settings: { ...SETTINGS, scoring: { max_ai_scores_per_run: 40 }, notify: { min_score: 65 }, dashboard: {} },
    state: { ...stateOf(jobs), companies: {} },
    summary: { runAt: '2026-10-15T03:00:00Z', today: '2026-10-15', companies: [{ company: 'Acme', url: 'https://x', status: 'ok', listed: 1 }], counts: { listed: 1, open: 1, new: 0 }, ai: { enabled: true }, newKeys: [] },
  };
  const data = siteData(view, { minScore: 65 });
  assert.equal(data.insights.fit.themes[0].name, 'Payments');
  const html = renderSite(data);
  assert.match(html, /id="tab-insights"/);
  assert.match(html, /id="view-insights"[\s\S]*id="themes"/, 'What keeps coming up lives on the Insights tab');
});
