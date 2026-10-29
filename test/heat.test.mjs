import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNewsFeed, namesCompany, newsUrl, readNews, xQueries, readX, cleanSignals, normalizeSignals, loadSignals,
  recordListed, trendOf, computeHeat, scanSignals, scanDue, effortLine, reasonOf, levelOf, itemsText,
} from '../src/heat.mjs';
import { loadSettings, loadCompanies, ConfigError } from '../src/config.mjs';
import { siteData, renderSite } from '../src/site.mjs';
import { planMessages } from '../src/notify.mjs';

function instance(settingsExtra = '', files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'axia-heat-'));
  writeFileSync(join(dir, 'settings.yml'), 'titles:\n  include: [architect]\n' + settingsExtra);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const settings = loadSettings(instance());
const quiet = () => {};

const FEED = `<?xml version="1.0"?><rss><channel>
<item><title>Razorpay to hire 500 engineers in Bengaluru - Moneycontrol</title><link>https://news.example/a</link><pubDate>Tue, 27 Oct 2026 10:38:00 GMT</pubDate><source url="https://moneycontrol.com">Moneycontrol</source></item>
<item><title>OpenAI in talks with UAE funds, BlackRock &amp; others - Business Standard</title><link>https://news.example/b</link><pubDate>Tue, 06 Oct 2026 07:00:00 GMT</pubDate><source url="https://bs.com">Business Standard</source></item>
<item><title><![CDATA[Razorpay&#39;s new CTO joins from Google]]></title><link>https://news.example/c</link><pubDate>Mon, 26 Oct 2026 07:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://news.example/d</link></item>
</channel></rss>`;

test('news: feed items are read, and only headlines naming the company are kept', async () => {
  const items = parseNewsFeed(FEED);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { title: 'Razorpay to hire 500 engineers in Bengaluru', link: 'https://news.example/a', date: '2026-10-27', outlet: 'Moneycontrol' });
  assert.equal(items[1].title, 'OpenAI in talks with UAE funds, BlackRock & others');
  assert.equal(items[2].title, "Razorpay's new CTO joins from Google");
  assert.ok(namesCompany('JPMorgan Chase opens Hyderabad campus', ['JPMorgan Chase', 'JP Morgan']));
  assert.ok(!namesCompany('Visakhapatnam port news', ['Visa']));
  assert.ok(namesCompany('Societe Generale expands GSC', ['Société Générale']));
  assert.match(newsUrl('Razorpay'), /^https:\/\/news\.google\.com\/rss\/search\?q=%22Razorpay%22.*when%3A7d&hl=en-IN&gl=IN&ceid=IN:en$/);

  const calls = [];
  const http = {
    mapLimit: (xs, _n, fn) => Promise.all(xs.map(fn)),
    async fetchText(url) {
      calls.push(url);
      if (url.includes('Broken')) throw new Error('HTTP 503');
      return FEED;
    },
  };
  const logs = [];
  const got = await readNews([{ name: 'Razorpay' }, { name: 'Broken Co' }, { name: 'JP Morgan', news: 'JPMorgan Chase' }], { http, now: new Date('2026-10-29T12:00:00Z'), log: (m) => logs.push(m) });
  assert.deepEqual(got.map((i) => i.title), ['Razorpay to hire 500 engineers in Bengaluru', "Razorpay's new CTO joins from Google"]);
  assert.equal(got[0].company, 'Razorpay');
  assert.match(calls[2], /JPMorgan%20Chase/);
  assert.match(logs[0], /2 headline\(s\).*1 search\(es\) failed/);
});

test('X: queries stay within the limit, the token is sent, and a refusal is named', async () => {
  const q = xQueries({ handles: ['@narayani07', 'bad handle!', 'x'.repeat(16)], companies: ['Razorpay', 'Pine Labs'] });
  assert.equal(q.length, 2);
  assert.match(q[0].query, /^\(from:narayani07\) \(hiring/);
  assert.match(q[1].query, /^\("Razorpay" OR "Pine Labs"\) \(hiring.*-is:retweet -is:reply lang:en$/);
  const many = xQueries({ companies: Array.from({ length: 80 }, (_, i) => `Company number ${i}`) });
  assert.ok(many[0].query.length <= 512);
  assert.deepEqual(xQueries({}), []);

  const now = new Date('2026-10-29T12:00:00Z');
  const seen = [];
  const http = {
    async fetchJson(url, opts) {
      seen.push({ url: new URL(url), opts });
      return {
        data: [{ id: '111', author_id: 'u1', created_at: '2026-10-29T05:00:00.000Z', text: 'Hiring: Razorpay, PhonePe and CRED are all hiring senior engineers' }],
        includes: { users: [{ id: 'u1', username: 'narayani07' }] },
      };
    },
  };
  const r = await readX({ token: 'T0K', handles: ['narayani07'], companies: ['Razorpay'], maxPosts: 40, since: '2026-10-01T00:00:00Z', now, http, log: quiet });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer T0K');
  assert.equal(seen[0].url.searchParams.get('max_results'), '20');
  // Never further back than the search allows (seven days).
  assert.ok(new Date(seen[0].url.searchParams.get('start_time')) > new Date('2026-10-22T12:00:00Z'));
  assert.equal(r.read, 2);
  assert.equal(r.items[0].link, 'https://x.com/narayani07/status/111');
  assert.equal(r.items[0].from, '@narayani07');

  const none = await readX({ token: '', handles: ['narayani07'], companies: [], maxPosts: 40, now, http, log: quiet });
  assert.deepEqual(none, { items: [], read: 0, problem: null });
  const broke = await readX({
    token: 'T', handles: ['a'], companies: ['B'], maxPosts: 40, now, log: quiet,
    http: { async fetchJson() { throw Object.assign(new Error('HTTP 402'), { status: 402 }); } },
  });
  assert.equal(broke.problem, 'X says the account is out of credits');
});

test('the model answer: known items and companies only, a post can name several', () => {
  const items = [
    { source: 'news', company: 'Razorpay', title: 'Razorpay to hire 500', link: 'https://n/1', date: '2026-10-27', from: 'Moneycontrol' },
    { source: 'x', company: null, title: null, text: 'Razorpay, PhonePe and CRED are hiring', link: 'https://x.com/a/status/1', date: '2026-10-29', from: '@a' },
  ];
  assert.match(itemsText(items), /<item id="1" company="Razorpay" source="news · Moneycontrol" date="2026-10-27">Razorpay to hire 500<\/item>/);
  assert.match(itemsText(items), /<item id="2" source="X @a" date="2026-10-29">Razorpay, PhonePe/);
  const out = cleanSignals({
    signals: [
      { id: '1', companies: ['Someone Else'], kind: 'hiring', why: 'not about it' },
      { id: '1', companies: ['razorpay'], kind: 'hiring', why: 'Plans to hire 500 engineers' },
      { id: '2', companies: ['Razorpay', 'phonepe', 'CRED', 'Nobody'], kind: 'hiring', why: 'Recruiter lists them as hiring' },
      { id: '9', companies: ['Razorpay'], kind: 'hiring', why: 'no such item' },
      { id: '2', companies: ['Razorpay'], kind: 'party', why: 'unknown kind' },
    ],
  }, items, ['Razorpay', 'PhonePe', 'CRED']);
  assert.deepEqual(out.map((s) => [s.company, s.source, s.kind]), [['Razorpay', 'news', 'hiring'], ['Razorpay', 'x', 'hiring'], ['PhonePe', 'x', 'hiring'], ['CRED', 'x', 'hiring']]);
  assert.equal(out[0].why, 'Plans to hire 500 engineers');
});

test('your signals.yml: matched to your companies, recent only, a broken file never stops the run', () => {
  const r = normalizeSignals({
    signals: [
      { company: 'razorpay', date: '2026-10-29', note: 'recruiter tweet', link: 'https://x.com/narayani07' },
      { company: 'Razorpay', date: '2026-07-01' },              // older than 60 days
      { company: 'Razorpay', date: '2026-11-02' },
      { company: 'Nobody', date: '2026-10-29' },
      { company: 'Razorpay', date: 'last week' },
      { company: 'Razorpay', date: new Date('2026-10-20T00:00:00Z'), kind: 'GCC', link: 'javascript:x' },
    ],
  }, { companies: ['Razorpay'], today: '2026-10-29', days: 60 });
  assert.deepEqual(r.signals.map((s) => [s.date, s.kind, s.link]), [['2026-10-29', 'hiring', 'https://x.com/narayani07'], ['2026-10-20', 'gcc', null]]);
  assert.equal(r.signals[0].source, 'you');
  assert.equal(r.dropped.length, 3);
  const logs = [];
  const bad = instance('', { 'signals.yml': 'signals: [oops' });
  assert.deepEqual(loadSignals(bad, loadSettings(bad), { companies: ['Razorpay'], today: '2026-10-29', log: (m) => logs.push(m) }), []);
  assert.match(logs[0], /::warning::Hiring signals: signals.yml could not be read/);
  const off = instance('heat: false\n', { 'signals.yml': 'signals:\n  - { company: Razorpay, date: 2026-10-29 }\n' });
  assert.deepEqual(loadSignals(off, loadSettings(off), { companies: ['Razorpay'], today: '2026-10-29', log: quiet }), []);
});

test('settings and companies.yml: defaults, checks, rank and news name', () => {
  assert.deepEqual(settings.heat, { news: true, signals: 'signals.yml', days: 60, x_handles: [], x_companies: 10, x_max_posts: 40, enabled: true });
  assert.equal(loadSettings(instance('heat: false\n')).heat.enabled, false);
  assert.deepEqual(loadSettings(instance('heat:\n  x_handles: ["@narayani07"]\n')).heat.x_handles, ['narayani07']);
  assert.throws(() => loadSettings(instance('heat:\n  x_handles: ["not a handle"]\n')), ConfigError);
  assert.throws(() => loadSettings(instance('heat:\n  x_max_posts: lots\n')), ConfigError);
  assert.throws(() => loadSettings(instance('heat:\n  news: "yes"\n')), ConfigError);
  const dir = instance('', { 'companies.yml': 'companies:\n  - { name: JP Morgan, url: "https://jobs.lever.co/jpm", rank: 4, news: JPMorgan Chase }\n  - { name: Plain, url: "https://jobs.lever.co/plain" }\n' });
  const [jpm, plain] = loadCompanies(dir);
  assert.equal(jpm.rank, 4);
  assert.equal(jpm.news, 'JPMorgan Chase');
  assert.equal(plain.rank, undefined);
  const bad = instance('', { 'companies.yml': 'companies:\n  - { name: X, url: "https://jobs.lever.co/x", rank: first }\n' });
  assert.throws(() => loadCompanies(bad), ConfigError);
});

test('postings over four weeks: recorded per fully read company, trend needs three weeks', () => {
  const state = { jobs: { a: { company: 'Acme', firstSeen: '2026-10-01' } }, companies: { Acme: { lastReadOk: '2026-10-29' }, New: { lastReadOk: '2026-10-29' } } };
  recordListed(state, [{ company: 'Acme', status: 'ok', jobs: [1, 2] }, { company: 'Acme', status: 'ok', jobs: [3] }, { company: 'Half', status: 'ok', jobs: [1] }, { company: 'Half', status: 'failed', jobs: [] }], '2026-10-29');
  assert.deepEqual(state.heat.listed, { Acme: [['2026-10-29', 3]] });
  assert.equal(state.companies.Acme.since, '2026-10-01', 'backfilled from its oldest role');
  assert.equal(state.companies.New.since, '2026-10-29');
  recordListed(state, [{ company: 'Acme', status: 'ok', jobs: [1, 2, 3, 4] }], '2026-10-29');
  assert.deepEqual(state.heat.listed.Acme, [['2026-10-29', 4]], 'one row a day');

  assert.equal(trendOf([['2026-10-20', 10], ['2026-10-29', 20]], '2026-10-29'), null, 'under three weeks of history');
  assert.deepEqual(trendOf([['2026-10-01', 30], ['2026-10-29', 45]], '2026-10-29'), { dir: 1, from: 30, to: 45 });
  assert.deepEqual(trendOf([['2026-10-01', 30], ['2026-10-29', 19]], '2026-10-29'), { dir: -1, from: 30, to: 19 });
  assert.equal(trendOf([['2026-10-01', 3], ['2026-10-29', 5]], '2026-10-29').dir, 0, 'small numbers need a real change');
});

function heatFixture() {
  const today = '2026-10-29';
  const jobs = {};
  const add = (key, company, extra = {}) => (jobs[key] = { key, company, title: 'Architect', status: 'open', firstSeen: '2026-10-25', ...extra });
  for (let i = 0; i < 12; i++) add(`p${i}`, 'PhonePe');
  for (let i = 0; i < 6; i++) add(`s${i}`, 'PhonePe', { score: { scorer: 'ai', value: 70 } });
  add('old1', 'PhonePe', { postedAt: '2026-08-01' });
  for (let i = 0; i < 9; i++) add(`b${i}`, 'Big Bank', { score: { scorer: 'ai', value: 60 } });
  for (let i = 0; i < 5; i++) add(`n${i}`, 'Newly Added', { firstSeen: '2026-10-27' }); // its first week
  add('c1', 'Cool Co', { firstSeen: '2026-09-01', status: 'closed' });
  const state = {
    jobs,
    companies: { PhonePe: { since: '2026-10-01' }, 'Big Bank': { since: '2026-10-01' }, 'Newly Added': { since: '2026-10-25' }, 'Cool Co': { since: '2026-09-01' } },
    heat: { listed: { 'Big Bank': [['2026-10-01', 100], ['2026-10-29', 150]] }, signals: [
      { company: 'Pine Labs', date: '2026-10-20', kind: 'hiring', why: 'hiring drive', link: 'https://n/1', source: 'news' },
      { company: 'Pine Labs', date: '2026-10-21', kind: 'funding', why: 'raised', link: 'https://n/2', source: 'news' },
      { company: 'Pine Labs', date: '2026-10-22', kind: 'gcc', why: 'new office', link: 'https://n/3', source: 'news' },
      { company: 'Big Bank', date: '2026-10-22', kind: 'layoffs', why: 'cuts', link: 'https://n/4', source: 'news' },
      { company: 'PhonePe', date: '2026-07-01', kind: 'hiring', why: 'too old', link: 'https://n/5', source: 'news' },
    ], scannedOn: '2026-10-26' },
  };
  const companies = ['PhonePe', 'Big Bank', 'Newly Added', 'Cool Co', 'Pine Labs'].map((name, i) => ({ name, enabled: true, ...(i < 4 ? { rank: [3, 1, 4, 5][i] } : {}) }));
  return { state, companies, today };
}

test('heat: points, levels, layoffs offset, first week left out, effort list with your rank', () => {
  const { state, companies, today } = heatFixture();
  const heat = computeHeat({
    state, settings, companies, today,
    layoffs: { 'Cool Co': [{ announced: '2026-10-02', india: true }] },
    signals: [{ company: 'Pine Labs', date: '2026-10-29', kind: 'hiring', why: 'tweet', link: null, source: 'you' }],
  });
  const p = heat.companies.PhonePe;
  // 19 new (capped 10) + 6 at 50+ (capped 15) − 1 long open
  assert.equal(p.points, 24);
  assert.equal(p.level, 'hot');
  assert.equal(reasonOf(p), '19 new senior roles in 14 days · 6 open roles scoring 50+ · 1 role open 45+ days');
  const b = heat.companies['Big Bank'];
  // 9 new + 9×3 capped 15 + postings up 5; layoff news is only a flag
  assert.equal(b.points, 29);
  assert.equal(b.layoffNews, true);
  assert.match(reasonOf(b), /postings up from 100 to 150 in 4 weeks/);
  assert.equal(heat.companies['Newly Added'].points, 0, 'roles from its first week in Axia are not new hiring');
  assert.equal(heat.companies['Newly Added'].level, 'quiet');
  const c = heat.companies['Cool Co'];
  assert.equal(c.points, -8);
  assert.match(reasonOf(c), /layoffs in India, 2026-10/);
  const pl = heat.companies['Pine Labs'];
  assert.equal(pl.points, 10, 'signals capped at +10');
  assert.equal(pl.level, 'warm');
  assert.equal(pl.signals[0].source, 'you');
  assert.equal(pl.signals.length, 4);
  // Big Bank 29 + rank bonus beats PhonePe 24 + bonus; Pine Labs (no rank) last.
  assert.deepEqual(heat.effort, ['Big Bank', 'PhonePe', 'Pine Labs']);
  assert.equal(effortLine(heat), 'Where to put effort: Big Bank (Hot), PhonePe (Hot), Pine Labs (Warm)');
  assert.equal(levelOf(20), 'hot');
  assert.equal(levelOf(9), 'cool');
  assert.equal(computeHeat({ state, settings: { ...settings, heat: { ...settings.heat, enabled: false } }, companies, today }), null);
});

test('the weekly scan: due once a week, one model call, posts kept when the call fails', async () => {
  const { state, companies, today } = heatFixture();
  const x = { ...settings, heat: { ...settings.heat, x_handles: ['narayani07'] } };
  assert.equal(scanDue(state, x, today), false);
  assert.equal(scanDue(state, x, '2026-11-02'), true);
  assert.equal(await scanSignals({ state, settings: x, companies, scorer: { ask() {} }, today, log: quiet }), 'not due');
  assert.equal(await scanSignals({ state, settings: x, companies, scorer: null, today, log: quiet }), 'off');

  const http = {
    mapLimit: (xs, _n, fn) => Promise.all(xs.map(fn)),
    async fetchText(url) {
      return url.includes('Pine') ? '<rss><item><title>Pine Labs opens new tech centre in Bengaluru - ET</title><link>https://n/new</link><pubDate>Wed, 28 Oct 2026 07:00:00 GMT</pubDate><source url="https://et">ET</source></item></rss>' : '<rss></rss>';
    },
    async fetchJson() {
      return { data: [{ id: '7', author_id: 'u', created_at: '2026-11-01T05:00:00Z', text: 'PhonePe and Pine Labs are hiring' }], includes: { users: [{ id: 'u', username: 'narayani07' }] } };
    },
  };
  const env = { X_BEARER_TOKEN: 'T' };
  const now = new Date('2026-11-02T00:00:00Z');
  // The model fails: the post (already paid for) waits for the next run; the scan is not marked done.
  const failing = { async ask() { throw new Error('rate limited'); } };
  assert.equal(await scanSignals({ state, settings: x, companies, scorer: failing, env, http, today: '2026-11-02', now, log: quiet }), 'failed');
  assert.equal(state.heat.pending.length, 1);
  assert.equal(state.heat.scannedOn, '2026-10-26');

  let asked;
  const scorer = {
    async ask(req) {
      asked = req;
      return { data: { signals: [{ id: '1', companies: ['PhonePe', 'Pine Labs'], kind: 'hiring', why: 'recruiter says hiring' }, { id: '2', companies: ['Pine Labs'], kind: 'gcc', why: 'new tech centre' }] }, model: 'm' };
    },
  };
  assert.equal(await scanSignals({ state, settings: x, companies, scorer, env, http, today: '2026-11-02', now, log: quiet }), 'done');
  // The kept post (once, though X returned it again here) and the headline.
  assert.equal(asked.input.match(/PhonePe and Pine Labs are hiring/g).length, 1);
  assert.match(asked.input, /Pine Labs opens new tech centre/);
  assert.equal(state.heat.scannedOn, '2026-11-02');
  assert.deepEqual(state.heat.pending, []);
  assert.equal(state.heat.xSince, now.toISOString());
  const fresh = state.heat.signals.filter((s) => s.date >= '2026-10-28');
  assert.deepEqual(fresh.map((s) => `${s.company}:${s.kind}`).sort(), ['PhonePe:hiring', 'Pine Labs:gcc', 'Pine Labs:hiring']);
  assert.ok(!state.heat.signals.some((s) => s.why === 'too old'), 'signals older than heat.days are dropped');
});

test('the page and the weekly message carry the heat', () => {
  const { state, companies, today } = heatFixture();
  const heat = computeHeat({ state, settings, companies, today });
  const view = {
    state,
    summary: { runAt: '2026-10-29T00:00:00Z', today, ai: { enabled: true }, counts: { listed: 1 }, companies: companies.map((c) => ({ company: c.name, url: 'https://x.test', status: 'ok', listed: 1 })) },
    settings,
    feedback: { roles: {} },
    heat,
  };
  const data = siteData(view, { minScore: 65 });
  assert.equal(data.heat.companies.PhonePe.level, 'hot');
  assert.equal(data.heat.companies.PhonePe.reason, reasonOf(heat.companies.PhonePe));
  assert.deepEqual(data.heat.effort, heat.effort);
  const html = renderSite(data);
  assert.match(html, /Where to put effort this week/);
  assert.equal(siteData({ ...view, heat: null }, { minScore: 65 }).heat, null);

  const weekly = { ...settings, notify: { ...settings.notify, weekly: 'monday' } };
  const msgs = planMessages({ state: { ...state, problems: {}, lastWeekly: null }, summary: view.summary, settings: weekly, minScore: 65, today: '2026-11-02', heat });
  assert.match(msgs[0].html, /Where to put effort: Big Bank \(Hot\), PhonePe \(Hot\)/);
});
