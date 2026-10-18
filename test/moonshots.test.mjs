import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeMoonshots, loadMoonshots, statusOf, fitOf } from '../src/moonshots.mjs';
import { loadSettings } from '../src/config.mjs';
import { siteData, renderSite } from '../src/site.mjs';

const role = (extra = {}) => ({ company: 'Example Bank', title: 'Chief Technology Officer', location: 'Mumbai', url: 'https://careers.example.test/cto', status: '🔥 ACTIVE', fit: 'Stretch', ...extra });

test('status and fit read the words a report uses', () => {
  assert.equal(statusOf('🆕 NEW'), 'new');
  assert.equal(statusOf('🔥 ACTIVE'), 'active');
  assert.equal(statusOf('ACTIVE / ⚠️ CLOSING SOON'), 'closing');
  assert.equal(statusOf('❌ CLOSED'), 'closed');
  assert.equal(statusOf('position has been filled'), 'closed');
  assert.equal(statusOf(undefined), 'active');
  assert.equal(fitOf('High/Medium'), 'high');
  assert.equal(fitOf('Stretch (low-Medium)'), 'stretch');
  assert.equal(fitOf('unsure'), null);
});

test('roles are cleaned, given ids, and unusable entries are dropped with a reason', () => {
  const r = normalizeMoonshots({
    updatedAt: '2026-10-18T15:25:00Z',
    roles: [
      role(),
      role({ title: '' }),
      role({ url: 'javascript:alert(1)', id: 'Same', requirements: 'One thing', gaps: ['a', 3, null], firstSeen: '18 Oct', closesOn: '2026-10-27' }),
      role({ id: 'same', title: 'Another' }),
    ],
    picks: [{ label: 'Best overall', role: 'same', note: 'why' }, { label: 'Ghost', role: 'nope' }, { label: 'Text only', note: 'a line' }],
    notes: 'One note',
  });
  assert.equal(r.roles.length, 3);
  assert.deepEqual(r.dropped, ['role 2: needs a company and a title']);
  assert.equal(r.roles[0].id, 'example-bank-chief-technology-officer-mumbai');
  assert.equal(r.roles[0].status, 'active');
  assert.equal(r.roles[0].fit, 'stretch');
  assert.equal(r.roles[1].url, null, 'only http(s) links are kept');
  assert.deepEqual(r.roles[1].requirements, ['One thing']);
  assert.deepEqual(r.roles[1].gaps, ['a', '3']);
  assert.equal(r.roles[1].firstSeen, null, 'dates must be YYYY-MM-DD');
  assert.equal(r.roles[1].closesOn, '2026-10-27');
  assert.equal(r.roles[2].id, 'same-4', 'ids stay unique');
  assert.deepEqual(r.picks.map((p) => [p.label, p.role]), [['Best overall', 'same'], ['Text only', null]]);
  assert.deepEqual(r.notes, ['One note']);
  assert.equal(r.updatedAt, '2026-10-18T15:25:00.000Z');
});

test('a file that is not a report is refused', () => {
  assert.throws(() => normalizeMoonshots([]), /JSON object/);
  assert.throws(() => normalizeMoonshots({ roles: 'x' }), /"roles" must be a list/);
});

test('the file is optional, can be turned off, and a broken one never stops the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axia-ms-'));
  const settings = { moonshots: { file: 'moonshots.json' } };
  const logs = [];
  const log = (m) => logs.push(m);
  assert.equal(loadMoonshots(dir, settings, { log }), null, 'no file, no tab');
  writeFileSync(join(dir, 'moonshots.json'), '{ not json');
  assert.match(loadMoonshots(dir, settings, { log }).problem, /moonshots\.json could not be read/);
  writeFileSync(join(dir, 'moonshots.json'), JSON.stringify({ roles: [role()] }));
  const ok = loadMoonshots(dir, settings, { log });
  assert.equal(ok.report.roles.length, 1);
  assert.ok(ok.report.updatedAt, 'falls back to the file time');
  assert.equal(loadMoonshots(dir, { moonshots: { file: '' } }, { log }), null);
  assert.match(logs.at(-1), /Moonshots: 1 role from moonshots\.json/);
});

test('settings: moonshots defaults to moonshots.json and false turns it off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axia-ms-'));
  writeFileSync(join(dir, 'settings.yml'), 'titles:\n  include: [Architect]\n');
  assert.equal(loadSettings(dir).moonshots.file, 'moonshots.json');
  writeFileSync(join(dir, 'settings.yml'), 'titles:\n  include: [Architect]\nmoonshots: false\n');
  assert.equal(loadSettings(dir).moonshots.file, '');
  writeFileSync(join(dir, 'settings.yml'), 'titles:\n  include: [Architect]\nmoonshots:\n  file: research/moonshots.json\n');
  assert.equal(loadSettings(dir).moonshots.file, 'research/moonshots.json');
  writeFileSync(join(dir, 'settings.yml'), 'titles:\n  include: [Architect]\nmoonshots:\n  file: 3\n');
  assert.throws(() => loadSettings(dir), /moonshots\.file must be a file name/);
});

test('the dashboard carries the moonshots, escaped, and only when there are some', () => {
  const settings = { report: { timezone: 'Asia/Kolkata', good_match: 65, show_from: 50 }, scoring: { max_ai_scores_per_run: 40 }, dashboard: { url: '', feedback: false } };
  const view = (moonshots) => ({
    settings,
    state: { jobs: {}, companies: {} },
    summary: { runAt: '2026-10-18T21:00:00Z', today: '2026-10-19', companies: [], counts: { listed: 0 }, ai: { enabled: true, pending: 0 } },
    moonshots,
  });
  assert.equal(siteData(view(null), { minScore: 65 }).moonshots, null);
  const report = normalizeMoonshots({ roles: [role({ why: '</script><img src=x onerror=alert(1)>' })] });
  const html = renderSite(siteData(view({ file: 'moonshots.json', report }), { minScore: 65 }));
  assert.doesNotMatch(html, /<\/script><img/);
  const data = JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.moonshots.roles[0].title, 'Chief Technology Officer');
  assert.equal(data.moonshots.dropped, undefined, 'what was dropped goes to the run log, not the page');
  assert.deepEqual(siteData(view({ file: 'moonshots.json', problem: 'bad' }), { minScore: 65 }).moonshots, { problem: 'bad' });
});
