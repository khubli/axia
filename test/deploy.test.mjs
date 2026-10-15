// Publishing never leaves your data on a public page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploy, privacyCheck, wranglerConfig } from '../src/deploy.mjs';

const settings = (dashboard = {}) => ({ dashboard: { url: '', worker: 'axia', domain: 'axia.example.test', public: false, ...dashboard } });
const quiet = () => {};

function builtSite() {
  const dir = mkdtempSync(join(tmpdir(), 'axia-deploy-'));
  mkdirSync(join(dir, '.axia/site'), { recursive: true });
  writeFileSync(join(dir, '.axia/site/index.html'), '<meta name="axia" content="private-dashboard"> secret roles');
  return dir;
}

function fakeWrangler(calls, output = 'Deployed axia') {
  return async (args, env, opts) => {
    const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
    calls.push({ args, env, opts, config, index: readFileSync(join(config.assets.directory, 'index.html'), 'utf8') });
    return output;
  };
}

test('custom domain: no workers.dev and no preview URLs, so the domain is the only way in', () => {
  const c = wranglerConfig({ worker: 'axia', domain: 'axia.example.test' }, '/x/site');
  assert.deepEqual(c.routes, [{ pattern: 'axia.example.test', custom_domain: true }]);
  assert.equal(c.workers_dev, false);
  assert.equal(c.preview_urls, false);
  assert.equal(wranglerConfig({ worker: 'axia', domain: '' }, '/x/site').workers_dev, true);
});

test('without a Cloudflare token nothing is published', async () => {
  const calls = [];
  const out = await deploy({ dir: builtSite(), env: {}, settings: settings(), log: quiet, wrangler: fakeWrangler(calls) });
  assert.deepEqual(out, { skipped: true });
  assert.equal(calls.length, 0);
});

test('a private dashboard is published once and checked', async () => {
  const calls = [];
  const checked = [];
  const out = await deploy({
    dir: builtSite(),
    env: { CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acc' },
    settings: settings(),
    log: quiet,
    wrangler: fakeWrangler(calls),
    check: async (url) => (checked.push(url), 'private'),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].env, { CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acc' });
  assert.deepEqual(checked, ['https://axia.example.test/']);
  assert.deepEqual(out, { urls: ['https://axia.example.test/'], privacy: 'private' });
});

test('a public dashboard is replaced by an empty page and the run fails', async () => {
  const calls = [];
  await assert.rejects(
    deploy({ dir: builtSite(), env: { CLOUDFLARE_API_TOKEN: 'cf' }, settings: settings(), log: quiet, wrangler: fakeWrangler(calls), check: async () => 'public' }),
    /opened without a login, so Axia replaced it with a page that holds no data/,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].index, /secret roles/);
  assert.doesNotMatch(calls[1].index, /secret roles/, 'the second publish carries no data');
  assert.match(calls[1].index, /not protected yet/);
  assert.equal(calls[1].config.name, 'axia', 'same Worker, so it replaces the public page');
});

test('no clear answer counts as not private: the data comes down', async () => {
  const calls = [];
  await assert.rejects(
    deploy({ dir: builtSite(), env: { CLOUDFLARE_API_TOKEN: 'cf' }, settings: settings(), log: quiet, wrangler: fakeWrangler(calls), check: async () => 'unknown' }),
    /Could not confirm that https:\/\/axia\.example\.test\/ asks for a login/,
  );
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].index, /secret roles/);
});

test('only public: true (a real boolean) skips the check', async () => {
  const checked = [];
  const run = (pub) => deploy({ dir: builtSite(), env: { CLOUDFLARE_API_TOKEN: 'cf' }, settings: settings({ public: pub }), log: quiet, wrangler: fakeWrangler([]), check: async (u) => (checked.push(u), 'private') });
  assert.equal((await run(true)).privacy, 'not checked');
  assert.equal((await run('false')).privacy, 'private', 'a quoted "false" never bypasses the check');
  assert.equal(checked.length, 1);
});

test('workers.dev address is read from wrangler output when there is no domain', async () => {
  const checked = [];
  const out = await deploy({
    dir: builtSite(),
    env: { CLOUDFLARE_API_TOKEN: 'cf' },
    settings: settings({ domain: '' }),
    log: quiet,
    wrangler: fakeWrangler([], 'Uploaded axia\n  https://axia.someone.workers.dev\nCurrent Version ID: x'),
    check: async (url) => (checked.push(url), 'private'),
  });
  assert.deepEqual(checked, ['https://axia.someone.workers.dev/']);
  assert.equal(out.privacy, 'private');
});

test('privacy check: an Access login redirect is private, the page itself is public', async () => {
  const res = (status, headers = {}, body = '') => new Response(body, { status, headers });
  const opts = (r) => ({ fetchImpl: async () => r(), attempts: 2, waitMs: 0, sleep: async () => {} });
  assert.equal(await privacyCheck('https://a/', opts(() => res(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/a' }))), 'private');
  assert.equal(await privacyCheck('https://a/', opts(() => res(403))), 'private');
  assert.equal(await privacyCheck('https://a/', opts(() => res(200, {}, '<meta name="axia" content="private-dashboard">'))), 'public');
  assert.equal(await privacyCheck('https://a/', opts(() => res(302, { location: 'https://elsewhere.example/' }))), 'unknown');
  let n = 0;
  const flaky = { fetchImpl: async () => (n++ ? res(302, { location: 'https://t.cloudflareaccess.com/x' }) : Promise.reject(new Error('ENOTFOUND'))), attempts: 3, waitMs: 0, sleep: async () => {} };
  assert.equal(await privacyCheck('https://a/', flaky), 'private', 'a domain that is still being set up is asked again');
});
