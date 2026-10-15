import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/** A fake `http` module for source tests: routes by URL substring. */
export function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async fetchJson(url, opts = {}) {
      calls.push({ url, ...opts });
      for (const [pattern, handler] of routes) {
        if (url.includes(pattern)) return typeof handler === 'function' ? handler(url, opts) : structuredClone(handler);
      }
      throw new Error(`unexpected URL in test: ${url}`);
    },
    async mapLimit(items, _limit, fn) {
      return Promise.all(items.map(fn));
    },
  };
}

/**
 * Replace global fetch for end-to-end tests. `routes` is a list of
 * [substring, (url, init) => body | Response]. Returns the recorded calls and a restore().
 */
export function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        const out = await handler(url, init);
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

export const RESUME = `# Test Candidate
Platform and Solution Architect with 15 years in payments. Card and account-to-account platforms, SWIFT ISO 20022 migration,
integration architecture, cloud migration, regulatory delivery. Leads a team of 12 engineers. Based in Pune.
`.repeat(2);

/** A throwaway instance folder with its own settings, companies and resume. */
export function tempProject({ companies, settings = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'axia-test-'));
  mkdirSync(join(dir, 'dashboard'));
  writeFileSync(join(dir, 'cv.md'), RESUME);
  writeFileSync(join(dir, 'criteria.md'), 'Prefers Pune. Not interested in QA roles.');
  const base = {
    resume: 'cv.md',
    titles: { include: ['Solution Architect', 'Architect', 'Vice President'], exclude: ['Intern', 'Sales'] },
    locations: { include: ['Pune', 'Bengaluru', 'India'], keep_unknown: true },
    scoring: { model: 'claude-opus-5-5', effort: 'low', max_ai_scores_per_run: 10, batch_size: 2, criteria: 'criteria.md', keywords: ['payments', 'core banking'] },
    report: { timezone: 'Asia/Kolkata', good_match: 70, show_from: 50, send_daily_even_if_nothing_new: true, dashboard_url: 'https://example.test/dash' },
  };
  const merged = { ...base, ...settings };
  writeFileSync(join(dir, 'settings.yml'), JSON.stringify(merged)); // JSON is valid YAML
  writeFileSync(join(dir, 'companies.yml'), JSON.stringify(companies));
  return dir;
}
