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

test('scoring.rescore_on_edit takes all, none or a score', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = readFileSync(join(example, 'settings.yml'), 'utf8');
  const withValue = (v) => {
    const dir = mkdtempSync(join(tmpdir(), 'axia-cfg-'));
    writeFileSync(join(dir, 'settings.yml'), base.replace(/^scoring:\n/m, `scoring:\n  rescore_on_edit: ${v}\n`));
    return loadSettings(dir).scoring.rescore_on_edit;
  };
  assert.equal(loadSettings(example).scoring.rescore_on_edit, 'all', 'default: re-score everything, as before');
  assert.equal(withValue('none'), 'none');
  assert.equal(withValue('false'), 'none');
  assert.equal(withValue('50'), 50);
  assert.equal(withValue('0'), 'all');
  assert.throws(() => withValue('some'), /rescore_on_edit must be all, none or a score/);
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

test('the action and the starter workflow pass max-ai-scores through as --max-ai', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const root = join(example, '..', '..');
  const action = parse(readFileSync(join(root, 'action.yml'), 'utf8'));
  assert.equal(action.inputs['max-ai-scores'].default, '');
  const step = action.runs.steps.find((s) => s.name === 'Find, score and notify');
  assert.equal(step.env.AXIA_MAX_AI, '${{ inputs.max-ai-scores }}');
  assert.match(step.run, /"--max-ai=\$AXIA_MAX_AI"/);
  const workflow = parse(readFileSync(join(example, '.github/workflows/axia.yml'), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs['max-ai-scores'].type, 'string');
  assert.equal(workflow.jobs.axia.steps.find((s) => s.uses === 'khubli/axia@v1').with['max-ai-scores'], '${{ inputs.max-ai-scores }}');
  const preview = parse(readFileSync(join(example, '.github/workflows/axia-preview.yml'), 'utf8'));
  assert.deepEqual(preview.on.workflow_dispatch.inputs.command.options, ['second-look', 'calibrate', 'gaps', 'insights', 'heat']);
  assert.equal(action.runs.steps.find((s) => s.name === 'Find, score and notify').env.X_BEARER_TOKEN, '${{ inputs.x-bearer-token }}');
  assert.deepEqual(preview.permissions, { contents: 'read' }, 'previews write nothing');
});

test('outcomes: reason lists default, can be replaced, and must be short lists', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = readFileSync(join(example, 'settings.yml'), 'utf8');
  const withOutcomes = (yaml) => {
    const dir = mkdtempSync(join(tmpdir(), 'axia-cfg-'));
    writeFileSync(join(dir, 'settings.yml'), base + yaml);
    return dir;
  };
  const d = loadSettings(example).outcomes;
  assert.equal(d.rejected[0], 'No reason given');
  assert.ok(d.turned_down.includes('Pay below expectations'));
  assert.ok(d.stages.length);
  const mine = loadSettings(withOutcomes('\noutcomes:\n  turned_down: ["Staying at UBS", "Staying at UBS", " Pay "]\n')).outcomes;
  assert.deepEqual(mine.turned_down, ['Staying at UBS', 'Pay']);
  assert.deepEqual(mine.rejected, d.rejected, 'lists you leave out keep their defaults');
  assert.throws(() => loadSettings(withOutcomes('\noutcomes:\n  rejected: []\n')), /outcomes\.rejected must be a list with at least one reason/);
  assert.throws(() => loadSettings(withOutcomes(`\noutcomes:\n  stages: ["${'x'.repeat(90)}"]\n`)), /80 characters or fewer/);
});
