// Scores made of four parts: the model rates level, domain, core work and must-haves from 0 to 10,
// and Axia weighs and adds them, so scores spread out instead of bunching on a model's favourite numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { createHash } from 'node:crypto';
import { cleanParts, partsTotal, reweigh, resumeHash, titleHash, HARD_STOP_MAX } from '../src/score.mjs';
import { bestCutoff, scoreSpread } from '../src/calibrate.mjs';
import { loadSettings, DEFAULTS } from '../src/config.mjs';
import { tempProject, stubFetch } from './helpers.mjs';

const W = DEFAULTS.scoring.weights;
const quiet = () => {};

test('the default weights add up to 100, and the parts add up to the score', () => {
  assert.equal(Object.values(W).reduce((a, b) => a + b, 0), 100);
  assert.equal(partsTotal({ level: 10, domain: 10, core: 10, musts: 10 }, W), 100);
  assert.equal(partsTotal({ level: 0, domain: 0, core: 0, musts: 0 }, W), 0);
  // 8×2 + 9×2.5 + 7×3.5 + 6×2 = 16 + 22.5 + 24.5 + 12 = 75
  assert.equal(partsTotal({ level: 8, domain: 9, core: 7, musts: 6 }, W), 75);
  // Near neighbours land on different scores: no more ties from a favourite number.
  const near = [
    { level: 8, domain: 8, core: 7, musts: 7 },
    { level: 8, domain: 8, core: 8, musts: 6 },
    { level: 9, domain: 7, core: 7, musts: 7 },
    { level: 7, domain: 9, core: 8, musts: 6 },
  ].map((p) => partsTotal(p, W));
  assert.equal(new Set(near).size, near.length, `all different: ${near}`);
});

test('a hard stop caps the score at 50 whatever the parts say', () => {
  const p = { level: 9, domain: 9, core: 3, musts: 8 };
  assert.ok(partsTotal(p, W) > HARD_STOP_MAX);
  assert.equal(partsTotal(p, W, true), HARD_STOP_MAX);
  assert.equal(partsTotal({ level: 2, domain: 2, core: 2, musts: 2 }, W, true), 20, 'below the cap stays as it is');
});

test('parts are whole numbers from 0 to 10; a missing one means no parts', () => {
  assert.deepEqual(cleanParts({ level: 8.4, domain: 12, core: -1, musts: '7' }), { level: 8, domain: 10, core: 0, musts: 7 });
  assert.equal(cleanParts({ level: 8, domain: 8, core: 8 }), null);
  assert.equal(cleanParts({ level: 8, domain: null, core: 8, musts: 8 }), null);
  assert.equal(cleanParts(null), null);
});

test('a weights edit works scores out again from their parts, with no AI', () => {
  const s = { scorer: 'ai', value: 75, parts: { level: 8, domain: 9, core: 7, musts: 6 }, hardStop: false };
  assert.equal(reweigh(s, W), false, 'same weights, same score');
  assert.equal(reweigh(s, { level: 10, domain: 10, core: 70, musts: 10 }), true);
  assert.equal(s.value, 72); // 0.8×10 + 0.9×10 + 0.7×70 + 0.6×10
  const old = { scorer: 'ai', value: 66 };
  assert.equal(reweigh(old, W), false, 'a score from before parts keeps its value');
  assert.equal(old.value, 66);
  assert.equal(reweigh({ scorer: 'keyword', value: 40 }, W), false);
});

test('settings.yml: scoring.weights must give the four parts, adding up to 100', () => {
  const dir = tempProject({ companies: [] });
  const write = (scoring) => writeFileSync(join(dir, 'settings.yml'), JSON.stringify({ resume: 'cv.md', titles: { include: ['Architect'] }, scoring }));
  write({});
  assert.deepEqual(loadSettings(dir).scoring.weights, W);
  write({ weights: { level: 25, domain: 25, core: 25, musts: 25 } });
  assert.deepEqual(loadSettings(dir).scoring.weights, { level: 25, domain: 25, core: 25, musts: 25 });
  write({ weights: { level: 30, domain: 30, core: 30, musts: 30 } });
  assert.throws(() => loadSettings(dir), /add up to 120/);
  write({ weights: { level: 20, domain: 25, core: 35, skills: 20 } });
  assert.throws(() => loadSettings(dir), /has "skills"/);
  write({ weights: { level: -5, domain: 30, core: 55, musts: 20 } });
  assert.throws(() => loadSettings(dir), /each a number of 0 or more/);
});

test('the way scores are made is part of a score\'s resume version, but not of the second look\'s', () => {
  // A new way of scoring follows rescore_on_edit like a resume edit; title verdicts already given stand.
  assert.notEqual(resumeHash('cv', 'criteria'), titleHash('cv', 'criteria'));
  assert.notEqual(resumeHash('cv', 'criteria'), resumeHash('cv', 'criteria2'));
  assert.equal(resumeHash('cv', 'criteria').length, 12);
  // Pinned: the second look's hash is what earlier versions stored, so no title is asked about again.
  assert.equal(titleHash('cv', 'criteria'), createHash('sha256').update('cv\ncriteria').digest('hex').slice(0, 12));
});

test('the best good-match line, and how spread out the scores are', () => {
  const rows = [
    { decision: 'Apply', ai: 72 },
    { decision: 'Apply', ai: 68 },
    { decision: 'Skip', ai: 66 },
    { decision: 'Skip', ai: 40 },
  ];
  assert.deepEqual(bestCutoff(rows, 65), { cutoff: 67, agree: 4, of: 4 });
  assert.deepEqual(bestCutoff([{ decision: 'Apply', ai: 80 }, { decision: 'Skip', ai: 30 }], 65), { cutoff: 65, agree: 2, of: 2 }, 'a tie keeps the line nearest today');
  assert.equal(bestCutoff([{ decision: 'Apply', ai: null }], 65), null);
  assert.deepEqual(scoreSpread([66, 66, 70, null, 72]), { distinct: 3, of: 4, top: 66, topCount: 2 });
});

const gh = (id, title) => ({ id, title, location: { name: 'Pune' }, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, first_published: '2026-10-14T10:00:00Z', content: '&lt;p&gt;Own the payments architecture.&lt;/p&gt;' });

/** A `claude -p` stand-in that answers in parts, and records the schema it was given. */
function partsClaude(calls) {
  return async (args, { input }) => {
    calls.push({ schema: JSON.parse(args[args.indexOf('--json-schema') + 1]), system: readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8') });
    const ids = [...input.matchAll(/<job id="(\d+)">\nCompany: .*\nTitle: (.*)/g)].map((m) => [m[1], m[2]]);
    const structured = {
      results: ids.map(([id, title]) => ({
        id,
        summary: `Fit for ${title}.`,
        strengths: ['payments'],
        gaps: [],
        musts: [],
        parts: title.startsWith('Payments') ? { level: 8, domain: 9, core: 7, musts: 6 } : { level: 9, domain: 9, core: 2, musts: 8 },
        hard_stop: !title.startsWith('Payments'),
      })),
    };
    return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured, modelUsage: { 'claude-sonnet-5-5': {} } }) };
  };
}

test('a run asks for parts, not a score, adds them up, and shows them on the dashboard', async () => {
  const dir = tempProject({ companies: [{ name: 'Acme Bank', url: 'https://job-boards.greenhouse.io/acme' }] });
  const calls = [];
  const stub = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: [gh(1, 'Payments Architect'), gh(2, 'Solution Architect')] })]]);
  try {
    await run(['--no-notify'], { CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: '' }, { dir, now: new Date('2026-10-15T03:00:00Z'), log: quiet, scorerOverrides: { runClaude: partsClaude(calls) } });
  } finally {
    stub.restore();
  }
  const item = calls[0].schema.properties.results.items;
  assert.ok(item.required.includes('parts') && item.required.includes('hard_stop'));
  assert.ok(!item.properties.score, 'the model is not asked for an overall score');
  assert.match(calls[0].system, /do not give one overall number/);

  const jobs = Object.values(JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs);
  const pay = jobs.find((j) => j.title === 'Payments Architect').score;
  assert.equal(pay.value, 75);
  assert.deepEqual(pay.parts, { level: 8, domain: 9, core: 7, musts: 6 });
  assert.equal(pay.hardStop, false);
  assert.equal(jobs.find((j) => j.title === 'Solution Architect').score.value, HARD_STOP_MAX);

  const html = readFileSync(join(dir, '.axia/site/index.html'), 'utf8');
  assert.match(html, /"parts":\{"level":8,"domain":9,"core":7,"musts":6\}/);
  assert.match(html, /"weights":\{"level":20,"domain":25,"core":35,"musts":20\}/);
  assert.match(html, /How the score adds up/);

  // A weights edit re-weighs the stored parts on the next run, with no new AI request.
  const settings = JSON.parse(readFileSync(join(dir, 'settings.yml'), 'utf8'));
  writeFileSync(join(dir, 'settings.yml'), JSON.stringify({ ...settings, scoring: { ...settings.scoring, weights: { level: 10, domain: 10, core: 70, musts: 10 } } }));
  const again = [];
  const stub2 = stubFetch([['boards-api.greenhouse.io/v1/boards/acme', () => ({ jobs: [gh(1, 'Payments Architect'), gh(2, 'Solution Architect')] })]]);
  const lines = [];
  try {
    await run(['--no-notify'], { CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: '' }, { dir, now: new Date('2026-10-16T03:00:00Z'), log: (l) => lines.push(l), scorerOverrides: { runClaude: partsClaude(again) } });
  } finally {
    stub2.restore();
  }
  assert.equal(again.filter((c) => c.schema.properties.results?.items?.properties?.parts).length, 0, 'no role was scored again');
  const after = Object.values(JSON.parse(readFileSync(join(dir, 'data/jobs.json'), 'utf8')).jobs);
  assert.equal(after.find((j) => j.title === 'Payments Architect').score.value, 72); // 0.8×10 + 0.9×10 + 0.7×70 + 0.6×10
  assert.equal(after.find((j) => j.title === 'Solution Architect').score.value, 40, 'now under the hard-stop cap: 9 + 9 + 14 + 8');
  assert.match(lines.join('\n'), /score\(s\) worked out again from their parts/);
});
