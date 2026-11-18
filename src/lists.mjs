// Saved lists: a board's roles read on another computer, for the daily run to use when it can't read
// that board itself (a site whose bot check stops GitHub's servers but not a home connection).
//
//   axia fetch --platform workday   read every Workday board in companies.yml and save its roles
//                                   (with the text of the roles in your titles and places) under
//                                   data/lists/. Nothing is scored, sent or published.
//
// The daily run tries each board as usual. Only when a read fails does it look for a saved list of that
// board, and it uses one only if it is newer than the board's last good read and under 7 days old.

import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as httpModule from './http.mjs';
import { ConfigError, loadSettings, loadCompanies } from './config.mjs';
import { makeFilters } from './filter.mjs';
import { loadState, daysBetween, UNREAD_CLOSE_DAYS } from './state.mjs';
import { isoDate, normalize } from './text.mjs';

export const LISTS_DIR = 'data/lists';
const DETAIL_MAX = 400; // posting reads per fetch; the rest are read on the next one
const KEEP = ['id', 'title', 'location', 'url', 'postedAt', 'ref', 'description'];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'board';
/** One file per board in companies.yml, named so you can tell which: workday-<tenant>-<hash of the address>.json */
export const listFile = (board) => `${board.source.type}-${slug(board.params.scope)}-${createHash('sha256').update(board.url).digest('hex').slice(0, 8)}.json`;

/** The saved list of one board, or null. */
export function loadSavedList(dir, board) {
  const path = join(dir, LISTS_DIR, listFile(board));
  if (!existsSync(path)) return null;
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.url !== board.url || !Array.isArray(saved.jobs) || !/^\d{4}-\d{2}-\d{2}$/.test(saved.fetchedOn ?? '')) return null;
    return saved;
  } catch {
    return null;
  }
}

/** A saved list the daily run may use for a board it couldn't read today: newer than its last good read, under 7 days old. */
export function usableList(saved, { lastReadOk, today }) {
  if (!saved || saved.fetchedOn > today) return null;
  if (lastReadOk && saved.fetchedOn < lastReadOk) return null;
  if (daysBetween(saved.fetchedOn, today) >= UNREAD_CLOSE_DAYS) return null;
  return saved;
}

/** `axia fetch`: read the boards on these platforms and save their lists. Returns { saved, failed }. */
export async function fetchLists({ dir, platforms, http = httpModule, now = new Date(), log = console.log }) {
  const want = new Set(platforms.map((p) => p.trim().toLowerCase()).filter(Boolean));
  if (!want.size) throw new ConfigError('fetch needs --platform, for example --platform workday');
  const settings = loadSettings(dir);
  const companies = loadCompanies(dir).filter((c) => c.enabled);
  const state = loadState(join(dir, 'data/jobs.json'));
  const filters = makeFilters(settings);
  const today = isoDate(now, settings.report.timezone);
  const ctx = { http, today };
  // The same test the daily run uses: your title words, or the second look let the title through before.
  const secondLookOn = settings.titles.second_look !== false;
  const passesTitle = (company, title) => {
    const t = filters.title(title);
    return t.ok || (secondLookOn && !t.excluded && state.titleChecks[`${company}|${normalize(title)}`]?.keep === true);
  };

  const boards = companies.flatMap((c) => c.boards.filter((b) => b.source && want.has(b.source.type)).map((board) => ({ company: c.name, board })));
  if (!boards.length) throw new ConfigError(`No board in companies.yml is on ${[...want].join(', ')}.`);
  const out = join(dir, LISTS_DIR);
  mkdirSync(out, { recursive: true });

  let detailBudget = DETAIL_MAX;
  let saved = 0;
  let failed = 0;
  for (const { company, board } of boards) {
    const file = listFile(board);
    const before = loadSavedList(dir, board);
    const known = new Map((before?.jobs ?? []).filter((j) => j.description).map((j) => [j.id, j]));
    let jobs;
    try {
      jobs = await board.source.list(board.params, ctx);
    } catch (err) {
      log(`  ✗ ${company.padEnd(32)} could not read: ${err.message}`);
      failed++;
      continue; // the list saved before stays as it was
    }
    // The text of the roles the daily run will score: in your titles, and in your places (or no place listed).
    const wanted = jobs.filter((j) => passesTitle(company, j.title) && (!j.location || filters.location(j.location).ok));
    let read = 0;
    for (const j of wanted) {
      const k = known.get(j.id);
      if (k && normalize(k.title) === normalize(j.title)) {
        j.description = k.description;
        if (!j.location && k.location) j.location = k.location;
      }
    }
    const toRead = board.source.detail ? wanted.filter((j) => !j.description).slice(0, Math.max(0, detailBudget)) : [];
    detailBudget -= toRead.length;
    await http.mapLimit(toRead, 4, async (j) => {
      try {
        const d = await board.source.detail(board.params, j, ctx);
        if (d.description) j.description = d.description;
        if (!j.location && d.location) j.location = d.location;
        if (!j.postedAt && d.postedAt) j.postedAt = d.postedAt;
        read++;
      } catch {
        // The posting may have just closed. The daily run scores it from its title, as it would anyway.
      }
    });
    const body = {
      about: 'Saved by `axia fetch` for the daily run to use if it cannot read this board itself. Rewritten on every fetch.',
      company,
      url: board.url,
      type: board.source.type,
      fetchedAt: now.toISOString(),
      fetchedOn: today,
      jobs: jobs.map((j) => Object.fromEntries(KEEP.filter((f) => j[f] != null).map((f) => [f, j[f]]))),
    };
    const path = join(out, file);
    writeFileSync(`${path}.tmp`, JSON.stringify(body, null, 1) + '\n');
    renameSync(`${path}.tmp`, path);
    saved++;
    log(`  ✓ ${company.padEnd(32)} ${String(jobs.length).padStart(5)} open roles saved, ${wanted.length} in your titles and places (${read} posting(s) read)`);
  }
  // Lists of boards no longer in companies.yml (or paused) are removed, so nothing stale is ever used.
  const current = new Set(boards.map(({ board }) => listFile(board)));
  for (const f of readdirSync(out)) {
    if (f.endsWith('.json') && [...want].some((p) => f.startsWith(`${p}-`)) && !current.has(f)) rmSync(join(out, f));
  }
  log(`\nSaved ${saved} list(s)${failed ? `; ${failed} board(s) could not be read here either` : ''}. The next daily run uses them for boards it can't read itself.`);
  if (!saved) throw new Error(`No ${[...want].join(', ')} board could be read from this computer either.`);
  return { saved, failed };
}
