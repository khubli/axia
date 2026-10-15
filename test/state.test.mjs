// Nothing stays "open" forever: every way a role can close, and the ways it must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeAndPrune, emptyState } from '../src/state.mjs';

function stateWith(jobs, companies = {}) {
  const s = emptyState();
  for (const j of jobs) s.jobs[j.key] = { status: 'open', ...j };
  s.companies = companies;
  return s;
}
const watched = new Set(['Acme', 'Beta']);

test('a role no longer listed on a board read today is closed', () => {
  const s = stateWith([{ key: 'a1', company: 'Acme' }, { key: 'a2', company: 'Acme' }]);
  closeAndPrune(s, { seenKeys: new Set(['a1']), okCompanies: new Set(['Acme']), watched, today: '2026-10-16' });
  assert.equal(s.jobs.a1.status, 'open');
  assert.equal(s.jobs.a2.status, 'closed');
  assert.equal(s.jobs.a2.closedReason, 'no longer listed');
  assert.deepEqual(s.companies.Acme, { lastReadOk: '2026-10-16' });
});

test('a board that fails is frozen for a few days, then its roles close', () => {
  const s = stateWith([{ key: 'b1', company: 'Beta' }], { Beta: { lastReadOk: '2026-10-10' } });
  closeAndPrune(s, { seenKeys: new Set(), okCompanies: new Set(), watched, today: '2026-10-16' });
  assert.equal(s.jobs.b1.status, 'open', '6 days unreadable: still kept');
  closeAndPrune(s, { seenKeys: new Set(), okCompanies: new Set(), watched, today: '2026-10-17' });
  assert.equal(s.jobs.b1.status, 'closed', '7 days unreadable: closed');
  assert.match(s.jobs.b1.closedReason, /unreadable since 2026-10-10/);
});

test('removing or pausing a company closes its roles at once', () => {
  const s = stateWith([{ key: 'g1', company: 'Gone' }], { Gone: { lastReadOk: '2026-10-15' } });
  s.skipped.g2 = { company: 'Gone', title: 't', location: 'x', reason: 'r' };
  closeAndPrune(s, { seenKeys: new Set(), okCompanies: new Set(), watched, today: '2026-10-16' });
  assert.equal(s.jobs.g1.status, 'closed');
  assert.match(s.jobs.g1.closedReason, /removed or paused/);
  assert.equal(s.companies.Gone, undefined);
  assert.equal(s.skipped.g2, undefined);
});

test('closed roles are forgotten after 45 days', () => {
  const s = stateWith([{ key: 'c1', company: 'Acme', status: 'closed', closedOn: '2026-08-01' }, { key: 'c2', company: 'Acme', status: 'closed', closedOn: '2026-10-01' }]);
  closeAndPrune(s, { seenKeys: new Set(), okCompanies: new Set(['Acme']), watched, today: '2026-10-16' });
  assert.equal(s.jobs.c1, undefined);
  assert.equal(s.jobs.c2.status, 'closed');
});
