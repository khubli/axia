// Publish .axia/site/ to Cloudflare as a static Worker, then prove it is private:
// an unauthenticated request must be sent to a Cloudflare Access login. If the page
// opens without one, it is replaced at once by a page that holds no data, and the
// run fails so you hear about it.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholderHtml, writeSite } from './site.mjs';
import { feedbackEnabled, findNamespace } from './feedback.mjs';
import { tailorApi } from './tailor.mjs';

const WORKER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'dashboard', 'worker.js');

export const WRANGLER = 'wrangler@4.144.0'; // pinned; bump deliberately
const COMPATIBILITY_DATE = '2026-09-01';
const MARKER = '<meta name="axia" content="private-dashboard">';

/**
 * With `feedback` ({ main, kvId }) the Worker also runs worker.js, which saves your calls from the
 * dashboard's buttons to that KV namespace. Without it, the Worker only serves the page.
 */
export function wranglerConfig(dashboard, assetsDir, feedback = null) {
  const config = {
    name: dashboard.worker || 'axia',
    compatibility_date: COMPATIBILITY_DATE,
    ...(feedback ? { main: feedback.main, kv_namespaces: [{ binding: 'FEEDBACK', id: feedback.kvId }] } : {}),
    ...(feedback?.vars ? { vars: feedback.vars } : {}),
    assets: { directory: assetsDir, ...(feedback ? { binding: 'ASSETS' } : {}) },
    // Version preview URLs would be a second, unprotected way in.
    preview_urls: false,
    workers_dev: !dashboard.domain,
  };
  if (dashboard.domain) config.routes = [{ pattern: dashboard.domain, custom_domain: true }];
  return config;
}

/** Run wrangler; resolves with its output, rejects with the tail of it. */
function runWrangler(args, env, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn('npx', ['--yes', WRANGLER, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => (clearTimeout(timer), reject(err)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveP(out);
      else reject(new Error(`wrangler exited with ${code}: ${out.trim().split('\n').slice(-8).join('\n')}`));
    });
  });
}

/**
 * 'private' — redirected to a Cloudflare Access login (or refused with 401/403)
 * 'public'  — the dashboard itself came back to a stranger
 * 'unknown' — no clear answer in time (a new custom domain can take a few minutes)
 */
export async function privacyCheck(url, { fetchImpl = fetch, attempts = 12, waitMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'axia-privacy-check' }, signal: AbortSignal.timeout(15000) });
      const location = res.headers.get('location') ?? '';
      if (res.status >= 300 && res.status < 400 && /\.cloudflareaccess\.com\//.test(location)) return 'private';
      if (res.status === 401 || res.status === 403) return 'private';
      if (res.status === 200 && (await res.text()).includes(MARKER)) return 'public';
    } catch {
      // DNS or certificate not ready yet; ask again.
    }
    if (i < attempts - 1) await sleep(waitMs);
  }
  return 'unknown';
}

/**
 * @returns {{ skipped?: true, urls?: string[], privacy?: 'private'|'not checked' }}
 */
export async function deploy({ dir, env = process.env, settings, log = console.log, wrangler = runWrangler, check = privacyCheck, cfFetch = fetch }) {
  const dashboard = settings.dashboard;
  if (!env.CLOUDFLARE_API_TOKEN) {
    log('Dashboard not published: add the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets to publish it (docs/setup.md).');
    return { skipped: true };
  }
  const work = resolve(dir, '.axia');
  const siteDir = join(work, 'site');
  if (!existsSync(join(siteDir, 'index.html'))) throw new Error('Nothing to publish yet: `axia run` writes the dashboard to .axia/site first.');

  const publish = async (assetsDir, label, feedback = null) => {
    const configPath = join(work, `wrangler.${label}.json`);
    writeFileSync(configPath, JSON.stringify(wranglerConfig(dashboard, assetsDir, feedback), null, 2));
    return wrangler(['deploy', '--config', configPath], { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? '' }, { cwd: work });
  };

  // Where the dashboard's buttons save your calls. If it can't be set up, the page is still published;
  // the buttons then keep your calls on your device until it can.
  let feedback = null;
  if (feedbackEnabled(settings)) {
    if (!env.CLOUDFLARE_ACCOUNT_ID) log('Feedback buttons not connected: add the CLOUDFLARE_ACCOUNT_ID secret (docs/setup.md, step 5).');
    else {
      try {
        const kvId = await findNamespace({ env, settings, create: true, fetchImpl: cfFetch });
        copyFileSync(WORKER_SOURCE, join(work, 'worker.js'));
        feedback = { main: 'worker.js', kvId };
        if (tailorApi(settings) && settings.tailor.dispatch) feedback.vars = { TAILOR_REPO: settings.tailor.dispatch };
      } catch (err) {
        log(`Feedback buttons not connected: ${err.message}. Check that the Cloudflare token can edit Workers KV Storage (docs/setup.md, step 5).`);
      }
    }
  }

  log(`Publishing the dashboard to Cloudflare (Worker "${dashboard.worker}")…`);
  const output = await publish(siteDir, 'site', feedback);
  const urls = dashboard.domain ? [`https://${dashboard.domain}/`] : [...new Set(output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi) ?? [])].map((u) => `${u}/`);
  if (urls.length === 0) throw new Error('Published, but could not tell the address: set dashboard.domain in settings.yml.');
  log(`Published: ${urls.join(', ')}`);

  // The Tailor button's token (tailor.dispatch): a Worker secret, never in the page or the config file.
  if (feedback?.vars?.TAILOR_REPO) {
    if (!env.AXIA_TAILOR_TOKEN) log(`Tailor clicks are queued for the nightly run only: add the tailor-dispatch-token input to start ${feedback.vars.TAILOR_REPO}'s workflow at once.`);
    else {
      const secrets = join(work, 'tailor-secret.json');
      try {
        writeFileSync(secrets, JSON.stringify({ TAILOR_TOKEN: env.AXIA_TAILOR_TOKEN }), { mode: 0o600 });
        await wrangler(['secret', 'bulk', secrets, '--config', join(work, 'wrangler.site.json')], { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? '' }, { cwd: work });
        log(`Tailor clicks start ${feedback.vars.TAILOR_REPO}'s tailoring workflow at once.`);
      } catch (err) {
        log(`Tailor clicks are queued for the nightly run only: could not set the Worker's token (${err.message.split('\n')[0]}).`);
      } finally {
        rmSync(secrets, { force: true });
      }
    }
  }

  if (dashboard.public === true) {
    log('dashboard.public is true: not checking for a login.');
    return { urls, privacy: 'not checked' };
  }
  // Fail closed: unless a login is confirmed, the data comes down.
  for (const url of urls) {
    const result = await check(url);
    if (result === 'private') continue;
    const host = new URL(url).host;
    const safeDir = join(work, 'placeholder');
    mkdirSync(safeDir, { recursive: true });
    writeSite(safeDir, placeholderHtml(host));
    await publish(safeDir, 'placeholder');
    throw new Error(
      result === 'public'
        ? `${url} opened without a login, so Axia replaced it with a page that holds no data. ` +
            `Add a Cloudflare Access application for ${host} (docs/setup.md, step 5), then run the workflow again.`
        : `Could not confirm that ${url} asks for a login (no clear answer in about two minutes), so Axia replaced it with a page that holds no data. ` +
            `Open it in a private browser window: you should see a Cloudflare Access sign-in. Then run the workflow again.`,
    );
  }
  log('Checked: the dashboard asks for your Cloudflare Access login.');
  return { urls, privacy: 'private' };
}
