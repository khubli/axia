import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, runChanges, addHistory, briefLine, HISTORY_RUNS } from '../src/changes.mjs';

const settings = { report: { good_match: 65, show_from: 55 } };
const ai = (value) => ({ value, scorer: 'ai' });
const job = (key, extra = {}) => ({ key, company: 'Acme', title: key, status: 'open', score: null, ...extra });

function memory() {
  return {
    lastRun: {
      runAt: '2026-10-20T23:00:00.000Z',
      companies: [
        { company: 'Acme', status: 'ok' },
        { company: 'Big Bank', status: 'ok' },
        { company: 'Big Bank', status: 'failed' }, // one of two boards failed
        { company: 'Gone Co', status: 'ok' },
      ],
      ai: { pending: 100 },
    },
    jobs: {
      a: job('a', { score: ai(60) }),
      b: job('b', { score: ai(70) }),
      c: job('c', { score: { value: 50, scorer: 'keyword' } }),
      d: job('d', { status: 'closed', closedOn: '2026-10-18', score: ai(66) }),
      e: job('e', { score: ai(40) }),
    },
  };
}

test('the brief compares memory before and after a run', () => {
  const state = memory();
  const before = snapshot(state);
  // The run: a is re-scored 60 → 63 (same band, small move: not listed), b 70 → 58 (into another band),
  // c gets its first AI score, d is listed again, e closes, f is new and scored, g is new and waits.
  state.jobs.a.score = ai(63);
  state.jobs.b.score = ai(58);
  state.jobs.c.score = ai(72);
  state.jobs.c.notifiedOn = '2026-10-21';
  state.jobs.d.status = 'open';
  state.jobs.e.status = 'closed';
  state.jobs.f = job('f', { score: ai(57) });
  state.jobs.g = job('g', { score: { value: 50, scorer: 'keyword' } });
  const summary = {
    runAt: '2026-10-21T23:00:00.000Z', today: '2026-10-22', partial: false,
    companies: [{ company: 'Acme', status: 'ok' }, { company: 'Big Bank', status: 'ok' }, { company: 'New Co', status: 'failed' }],
    ai: { enabled: true, pending: 81 },
  };
  const ch = runChanges({ before, state, summary, settings, newKeys: new Set(['f', 'g']), closedKeys: ['e'], scoredKeys: new Set(['a', 'b', 'c', 'f']) });
  assert.deepEqual(ch.new, ['f', 'g']);
  assert.deepEqual(ch.scored, ['c', 'f']);
  assert.deepEqual(ch.moved, [{ key: 'b', from: 70 }]);
  assert.deepEqual(ch.closed, ['e']);
  assert.deepEqual(ch.reopened, ['d']);
  assert.deepEqual(ch.notified, ['c']);
  assert.deepEqual(ch.companies, { unreadable: ['New Co'], stillUnreadable: [], recovered: ['Big Bank'], added: ['New Co'], removed: ['Gone Co'] });
  assert.deepEqual(ch.pending, { before: 100, now: 81 });
  assert.equal(ch.since, '2026-10-20T23:00:00.000Z');

  assert.equal(
    briefLine({ changes: ch, state, settings, aiPerRun: 40 }),
    '2 new roles and 1 closed. 1 closed role listed again. Scored 2 roles for the first time: 1 good match and 1 worth a look. 1 re-scored role moved 10+ points or into another band. 1 good match sent to you. New Co could not be read. Big Bank is readable again. 81 still waiting for a score, about 3 nights at 40 a night.',
  );

  const h = addHistory([], { summary, changes: ch, state, settings });
  assert.deepEqual(h, [{ runAt: summary.runAt, today: '2026-10-22', new: 2, closed: 1, scored: 2, good: 1, look: 1, pending: 81 }]);
});

test('a partial run does not report companies it skipped as removed', () => {
  const state = memory();
  const before = snapshot(state);
  const summary = { runAt: 'x', today: '2026-10-22', partial: true, companies: [{ company: 'Acme', status: 'ok' }], ai: { enabled: false, pending: 5 } };
  const ch = runChanges({ before, state, summary, settings, newKeys: new Set(), closedKeys: [], scoredKeys: new Set() });
  assert.deepEqual(ch.companies.removed, []);
  assert.equal(ch.pending.now, null, 'no AI, no backlog');
  assert.equal(briefLine({ changes: ch, state, settings, aiPerRun: 40 }), 'Nothing changed: no new or closed roles, and nothing new scored.');
});

test('history keeps the most recent runs, newest first, one line per run', () => {
  let h = [];
  const state = { jobs: {} };
  const changes = { new: [], closed: [], scored: [], pending: { now: 0 } };
  for (let i = 0; i < HISTORY_RUNS + 3; i++) h = addHistory(h, { summary: { runAt: `run-${i}`, today: 't' }, changes, state, settings });
  assert.equal(h.length, HISTORY_RUNS);
  assert.equal(h[0].runAt, `run-${HISTORY_RUNS + 2}`);
  h = addHistory(h, { summary: { runAt: h[0].runAt, today: 't' }, changes, state, settings });
  assert.equal(h.length, HISTORY_RUNS, 'the same run is not counted twice');
});

test('scored roles that all fall below the line say so', () => {
  const state = { jobs: { a: job('a', { score: ai(30) }) } };
  const changes = { new: [], closed: [], reopened: [], scored: ['a'], moved: [], notified: [], companies: { unreadable: [], recovered: [] }, pending: { now: 0 } };
  assert.equal(briefLine({ changes, state, settings, aiPerRun: 40 }), 'Scored 1 role for the first time, none of them 55 or more.');
});
