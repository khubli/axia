import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/render.mjs';
import { siteData, renderSite, citiesOf } from '../src/site.mjs';
import { keywordScore } from '../src/score.mjs';
import { jobId } from '../src/text.mjs';

const settings = {
  titles: { include: ['Architect'], exclude: [] },
  locations: { include: ['Pune'], keep_unknown: true },
  scoring: { max_ai_scores_per_run: 40, keywords: ['payments', 'swift'] },
  report: { timezone: 'Asia/Kolkata', good_match: 70, show_from: 50 },
  notify: { min_score: 70, weekly: 'monday' },
  dashboard: { url: 'https://axia.example.test', worker: 'axia', domain: 'axia.example.test', public: false },
};

function job(i, score, extra = {}) {
  return {
    key: `greenhouse:x:${i}`,
    company: 'Acme | Co',
    title: `Architect ${i} <script>alert(1)</script>`,
    location: 'Pune',
    url: `https://example.test/${i}`,
    postedAt: '2026-10-14',
    firstSeen: '2026-10-15',
    status: 'open',
    score: { value: score, scorer: 'ai', summary: `Summary ${i} </script><b>`, strengths: ['a'], gaps: ['b'], model: 'claude-sonnet-5-5', resumeHash: 'abcdef123456', scoredOn: '2026-10-15' },
    ...extra,
  };
}

function view(jobs, newKeys = []) {
  return {
    settings,
    state: { jobs: Object.fromEntries(jobs.map((j) => [j.key, j])), companies: { 'Acme | Co': { lastReadOk: '2026-10-15' } } },
    summary: {
      runAt: '2026-10-15T03:00:00Z',
      today: '2026-10-15',
      firstRun: false,
      companies: [{ company: 'Acme | Co', url: 'https://x', status: 'ok', listed: 9 }],
      counts: { listed: 9, open: jobs.length, new: newKeys.length, closedToday: 0 },
      ai: { enabled: true, scored: 1, failed: 0, stoppedBecause: null, pending: 0 },
      newKeys,
    },
  };
}

test('markdown escapes table pipes, groups by score band and links the dashboard', () => {
  const md = renderMarkdown(view([job(1, 91), job(2, 60), job(3, 20)], ['greenhouse:x:1']));
  assert.match(md, /Acme \\\| Co/);
  assert.match(md, /## Good matches — 70\+ \(1\)/);
  assert.match(md, /Worth a look — 50 to 69 \(1\)/);
  assert.match(md, /1 more open role\(s\) scored below 50 are not listed here \(they are on the dashboard\)/);
  assert.match(md, /\[Open the dashboard\]\(https:\/\/axia\.example\.test\)/);
});

test('with AI scoring on, keyword estimates are listed apart, never as matches', () => {
  const kw = job(9, 80, { score: { value: 80, scorer: 'keyword', summary: 'k', strengths: ['title matches "Architect"'], gaps: [] } });
  const v = view([job(1, 91), kw]);
  const md = renderMarkdown(v);
  assert.match(md, /## Good matches — 70\+ \(1\)/);
  assert.match(md, /Waiting for an AI score \(1\)/);
  v.summary.ai.enabled = false;
  assert.match(renderMarkdown(v), /## Good matches — 70\+ \(2\)/, 'without AI the estimate is all there is');
});

test('dashboard page embeds its data safely and carries the privacy marker', () => {
  const html = renderSite(siteData(view([job(1, 91)]), { minScore: 70 }));
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /Summary 1 <\/script>/, 'a value can never close the data script');
  assert.match(html, /\\u003cscript>alert/);
  assert.match(html, /<meta name="axia" content="private-dashboard">/);
  assert.doesNotMatch(html, /__AXIA_DATA__/);
  const data = JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.jobs[0].id, jobId('greenhouse:x:1'));
  assert.equal(data.jobs[0].model, 'Sonnet');
  assert.equal(data.jobs[0].resumeRev, 'abcdef');
  assert.equal(data.tz, 'IST');
  assert.equal(data.notifyMin, 70);
});

test('the dashboard keeps closed roles for a week, then drops them', () => {
  const closed = (i, on) => job(i, 80, { status: 'closed', closedOn: on });
  const data = siteData(view([job(1, 91), closed(2, '2026-10-12'), closed(3, '2026-10-01')]), { minScore: 70 });
  assert.deepEqual(data.jobs.map((j) => j.status), ['open', 'closed']);
});

test('cities are read from messy location strings', () => {
  assert.deepEqual(citiesOf('Bengaluru, Karnataka, India; Hyderabad, India'), ['Bengaluru', 'Hyderabad']);
  assert.deepEqual(citiesOf('Northwind Global Services Pvt. Ltd. - Bengaluru (Tech Park)'), ['Bengaluru']);
  assert.deepEqual(citiesOf('IN - Bengaluru, India'), ['Bengaluru']);
  assert.deepEqual(citiesOf('Singapore; Gurgaon, India'), ['Singapore', 'Gurugram']);
  assert.deepEqual(citiesOf(null), []);
});

test('keyword estimate is modest and explains itself', () => {
  const s = keywordScore({ title: 'Senior Payments Architect', location: 'Pune', description: 'payments and SWIFT' }, settings, 'Architect');
  assert.equal(s.scorer, 'keyword');
  assert.ok(s.value <= 85);
  assert.match(s.strengths.join(' '), /payments, swift/);
  const empty = keywordScore({ title: 'Architect', location: null }, settings, 'Architect');
  assert.match(empty.gaps.join(' '), /no description/);
});

test('the site is an installable app: manifest, service worker, version file', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildSite } = await import('../src/site.mjs');
  const out = mkdtempSync(join(tmpdir(), 'axia-site-'));
  buildSite(view([job(1, 91)]), out, { minScore: 70 });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#F3F5F8', 'status bar matches the page');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  const sw = readFileSync(join(out, 'sw.js'), 'utf8');
  assert.doesNotMatch(sw, /__AXIA_/);
  const assets = JSON.parse(sw.match(/const ASSETS = (\[.*\]);/)[1]);
  for (const a of assets) assert.ok(existsSync(join(out, a)), `${a} is published`);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'version.json'), 'utf8')), { runAt: '2026-10-15T03:00:00Z' });
  assert.match(readFileSync(join(out, '_headers'), 'utf8'), /\/sw\.js\n  Cache-Control: no-cache/);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">/);
  assert.match(html, /<meta name="theme-color" content="#0E1117" media="\(prefers-color-scheme: dark\)">/);
});

test('time zone names read naturally', async () => {
  const { tzLabel } = await import('../src/site.mjs');
  assert.equal(tzLabel('Asia/Kolkata', '2026-10-15T03:00:00Z'), 'IST');
  assert.equal(tzLabel('Europe/London', '2026-10-15T03:00:00Z'), 'BST');
  assert.equal(tzLabel('America/New_York', '2026-10-15T03:00:00Z'), 'EDT');
  assert.equal(tzLabel('UTC', '2026-10-15T03:00:00Z'), 'UTC');
});
