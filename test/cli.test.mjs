import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitDir, main } from '../src/cli.mjs';
import { loadSettings, loadCompanies, loadResume, loadCriteria } from '../src/config.mjs';

const example = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'instance');

test('--dir is taken out; everything else goes to the command', () => {
  assert.deepEqual(splitDir(['--dir', 'x', '--rescore']), { dir: resolve('x'), rest: ['--rescore'] });
  assert.deepEqual(splitDir(['--company', 'Stripe', '--dir=y']), { dir: resolve('y'), rest: ['--company', 'Stripe'] });
});

test('an unknown command says so', async () => {
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.equal(await main(['frobnicate']), 2);
  } finally {
    console.error = original;
  }
  assert.match(errors[0], /Unknown command "frobnicate"/);
});

test('dashboard.public must be a real true/false', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'axia-cfg-'));
  writeFileSync(join(dir, 'settings.yml'), readFileSync(join(example, 'settings.yml'), 'utf8') + '  public: "false"\n');
  assert.throws(() => loadSettings(dir), /dashboard\.public must be true or false without quotes/);
});

test('the starter repository in examples/instance is valid as shipped', () => {
  const settings = loadSettings(example);
  assert.equal(settings.dashboard.url, 'https://jobs.example.com');
  assert.equal(settings.notify.weekly, 'monday');
  const companies = loadCompanies(example);
  assert.ok(companies.length >= 5);
  for (const c of companies) assert.ok(c.boards.every((b) => b.source), `${c.name} is read automatically`);
  assert.ok(loadResume(settings, example).length > 200);
  assert.match(loadCriteria(settings, example), /What a good role looks like/);
});
