import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFilters } from '../src/filter.mjs';

const settings = (over = {}) => ({
  titles: { include: ['Solution Architect', 'Architect', 'CTO', 'Vice President'], exclude: ['Intern', 'HR', 'Sales'] },
  locations: { include: ['Pune', 'Bengaluru', 'India'], keep_unknown: true },
  ...over,
});

test('title include: start of a word, longest match reported', () => {
  const f = makeFilters(settings());
  assert.deepEqual(f.title('Senior Solution Architect'), { ok: true, matched: 'Solution Architect' });
  assert.equal(f.title('Head of Architecture').ok, true, '"Architect" also catches "Architecture"');
  assert.equal(f.title('Platform Engineer').ok, false);
  assert.equal(f.title('Group CTO').ok, true);
  assert.equal(f.title('Doctor Octopus').ok, false, 'short terms are whole words');
});

test('title words joined by underscores still match', () => {
  const f = makeFilters(settings());
  assert.deepEqual(f.title('Java Development Lead _Vice President _Software Engineering'), { ok: true, matched: 'Vice President' });
});

test('title exclude: whole words only', () => {
  const f = makeFilters(settings());
  assert.equal(f.title('Architect Intern').ok, false);
  assert.equal(f.title('Architecture Interns Program').ok, false, 'plural still excluded');
  assert.equal(f.title('International Payments Architect').ok, true, '"Intern" must not drop "International"');
  assert.equal(f.title('Internal Platforms Architect').ok, true);
  assert.equal(f.title('Three-tier Architect').ok, true, '"HR" must not fire inside "Three"');
  assert.equal(f.title('Sales Architect').ok, false);
});

test('location: whole words, unknown kept by default', () => {
  const f = makeFilters(settings());
  assert.equal(f.location('IN - Bengaluru, India').ok, true);
  assert.equal(f.location('Pune, India, 411006').ok, true);
  assert.equal(f.location('Indianapolis, IN').ok, false, '"India" must not match "Indianapolis"');
  assert.equal(f.location('New York, United States').ok, false);
  assert.equal(f.location(null).ok, true);
  assert.equal(makeFilters(settings({ locations: { include: ['India'], keep_unknown: false } })).location(null).ok, false);
  assert.equal(makeFilters(settings({ locations: { include: [], keep_unknown: true } })).location('Anywhere').ok, true);
});
