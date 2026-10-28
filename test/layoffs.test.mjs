import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLayoffs, loadLayoffs, announcedOf, scopeOf } from '../src/layoffs.mjs';
import { loadSettings, ConfigError } from '../src/config.mjs';
import { siteData, renderSite } from '../src/site.mjs';

const companies = ['Example Bank', 'Contoso Pay'];

test('dates take a day or just a month', () => {
  assert.deepEqual(announcedOf('2026-10-22'), { date: '2026-10-22', month: 2026 * 12 + 9 });
  assert.equal(announcedOf('2026-10').date, '2026-10');
  assert.equal(announcedOf(new Date('2026-10-22T00:00:00Z')).date, '2026-10-22');
  assert.equal(announcedOf('22 Oct 2026'), null);
  assert.equal(announcedOf('2026-13'), null);
  assert.equal(scopeOf('India'), 'india');
  assert.equal(scopeOf('India and UK'), 'india');
  assert.equal(scopeOf('global'), 'elsewhere');
});

test('entries are matched to your companies, newest first, and old news drops off', () => {
  const r = normalizeLayoffs({
    layoffs: [
      { company: 'example bank', announced: '2026-08', where: 'global', size: 'about 5,000', link: 'https://news.example/a' },
      { company: 'Example Bank', announced: '2026-10-22', where: 'India', note: 'Pune centre', link: 'javascript:alert(1)' },
      { company: 'Contoso Pay', announced: '2026-04-30', where: 'US' },  // 6 months before Oct: gone
      { company: 'Contoso Pay', announced: '2026-05-01', where: 'US' },  // still shown in Oct
      { company: 'Citi', announced: '2026-10' },
      { announced: '2026-10' },
      { company: 'Contoso Pay', announced: 'last week' },
      { company: 'Contoso Pay', announced: '2026-11-02' },
    ],
  }, { companies, today: '2026-10-28', months: 6 });
  assert.equal(r.expired, 1);
  assert.deepEqual(Object.keys(r.byCompany), ['Example Bank', 'Contoso Pay']);
  const eb = r.byCompany['Example Bank'];
  assert.deepEqual(eb.map((l) => l.announced), ['2026-10-22', '2026-08']);
  assert.equal(eb[0].india, true);
  assert.equal(eb[0].link, null);
  assert.equal(eb[1].india, false);
  assert.equal(eb[1].size, 'about 5,000');
  assert.equal(r.byCompany['Contoso Pay'][0].where, 'US');
  assert.equal(r.dropped.length, 4);
  assert.match(r.dropped[0], /Citi.*not one of your companies/);
  assert.match(r.dropped[1], /needs a company/);
  assert.match(r.dropped[2], /announced must be a date/);
  assert.match(r.dropped[3], /in the future/);
});

function instance(settingsExtra = '', file = null) {
  const dir = mkdtempSync(join(tmpdir(), 'axia-layoffs-'));
  writeFileSync(join(dir, 'settings.yml'), 'titles:\n  include: [architect]\n' + settingsExtra);
  if (file != null) writeFileSync(join(dir, 'layoffs.yml'), file);
  return dir;
}

test('settings: on by default, false turns it off, months is checked', () => {
  assert.deepEqual(loadSettings(instance()).layoffs, { file: 'layoffs.yml', months: 6 });
  assert.equal(loadSettings(instance('layoffs: false\n')).layoffs.file, '');
  assert.equal(loadSettings(instance('layoffs:\n  months: 3\n')).layoffs.months, 3);
  assert.throws(() => loadSettings(instance('layoffs:\n  months: soon\n')), ConfigError);
});

test('the file is optional and a broken one never stops the run', () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const none = instance();
  assert.equal(loadLayoffs(none, loadSettings(none), { companies, today: '2026-10-28', log }), null);
  const bad = instance('', 'layoffs: [unclosed');
  assert.equal(loadLayoffs(bad, loadSettings(bad), { companies, today: '2026-10-28', log }), null);
  assert.match(logs.at(-1), /::warning::Layoffs: layoffs.yml could not be read/);
  const ok = instance('', 'layoffs:\n  - company: Example Bank\n    announced: 2026-10-22\n    where: global\n');
  const by = loadLayoffs(ok, loadSettings(ok), { companies, today: '2026-10-28', log });
  assert.equal(by['Example Bank'][0].announced, '2026-10-22');
  assert.match(logs.at(-1), /Layoffs: 1 company labelled from layoffs.yml/);
});

test('the page carries the labels and never mixes them into scores', () => {
  const settings = loadSettings(instance());
  const job = { key: 'eb:1', company: 'Example Bank', title: 'Architect', url: 'https://x.test/1', status: 'open', firstSeen: '2026-10-20', score: { scorer: 'ai', value: 70, summary: 's' } };
  const view = {
    state: { jobs: { [job.key]: job }, companies: {} },
    summary: { runAt: '2026-10-28T00:00:00Z', today: '2026-10-28', ai: { enabled: true }, counts: { listed: 1 }, companies: [{ company: 'Example Bank', url: 'https://x.test', status: 'ok', listed: 1 }] },
    settings,
    feedback: { roles: {} },
    layoffs: { 'Example Bank': [{ announced: '2026-10-22', where: 'India', india: true, size: null, note: null, link: 'https://news.example/a' }] },
  };
  const data = siteData(view, { minScore: 65 });
  assert.equal(data.layoffs['Example Bank'][0].announced, '2026-10-22');
  assert.equal(data.layoffMonths, 6);
  assert.equal(data.jobs[0].score, 70);
  assert.match(renderSite(data), /news\.example/);
  assert.deepEqual(siteData({ ...view, layoffs: null }, { minScore: 65 }).layoffs, {});
});

test('a run puts the labels on the page and leaves scores and messages alone', async () => {
  const { run } = await import('../src/run.mjs');
  const { tempProject, stubFetch } = await import('./helpers.mjs');
  const { readFileSync } = await import('node:fs');
  const dir = tempProject({ companies: [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }] });
  writeFileSync(join(dir, 'layoffs.yml'), [
    'layoffs:',
    '  - { company: acme bank, announced: 2026-10-02, where: India, link: "https://news.example/acme" }',
    '  - { company: Acme Bank, announced: 2026-03, where: global }',   // older than 6 months on 15 Oct
    '  - { company: Nobody Inc, announced: 2026-10 }',
  ].join('\n'));
  const role = { id: 1, title: 'Senior Solution Architect', location: { name: 'Pune' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', first_published: '2026-10-14T10:00:00Z', content: '&lt;p&gt;x&lt;/p&gt;' };
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: [role] })]]);
  const logs = [];
  try {
    await run([], {}, { dir, now: new Date('2026-10-15T03:00:00Z'), log: (m) => logs.push(m) });
  } finally {
    stub.restore();
  }
  assert.ok(logs.some((m) => /Layoffs: 1 company labelled from layoffs.yml, 1 older than 6 months left off \(skipped: entry 3 \(Nobody Inc\): not one of your companies/.test(m)), logs.join('\n'));
  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  const data = JSON.parse(html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.deepEqual(Object.keys(data.layoffs), ['Acme Bank']);
  assert.equal(data.layoffs['Acme Bank'].length, 1);
  assert.equal(data.layoffs['Acme Bank'][0].india, true);
});
