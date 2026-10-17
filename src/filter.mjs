// The cheap, free gate before any scoring: does the title look like a role you
// want, and is it somewhere you'd work?

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Include terms match at the start of a word, so "Architect" also catches
 * "Architecture"; terms of 3 letters or fewer (CTO, VP) must be whole words.
 */
function includeMatcher(term) {
  const t = escapeRe(term.trim());
  const re = term.trim().length <= 3 ? new RegExp(`\\b${t}\\b`, 'i') : new RegExp(`\\b${t}`, 'i');
  return (s) => re.test(s);
}

/**
 * Exclude terms match whole words (plural allowed), so "Intern" drops "Interns"
 * but never "Internal" or "International", and "HR" never fires inside "Three".
 */
function excludeMatcher(term) {
  const re = new RegExp(`\\b${escapeRe(term.trim())}(s|es)?\\b`, 'i');
  return (s) => re.test(s);
}

/** Location terms are whole words, so "India" never matches "Indianapolis". */
function locationMatcher(term) {
  const re = new RegExp(`(^|[^\\p{L}])${escapeRe(term.trim())}($|[^\\p{L}])`, 'iu');
  return (s) => re.test(s);
}

export function makeFilters(settings) {
  const include = settings.titles.include.map((t) => ({ term: t, test: includeMatcher(t) }));
  const exclude = settings.titles.exclude.map((t) => ({ term: t, test: excludeMatcher(t) }));
  const places = settings.locations.include.map(locationMatcher);

  return {
    /** @returns {{ok: boolean, matched?: string, reason?: string}} */
    title(title) {
      // Some boards join title parts with underscores ("Java Lead _Vice President _Software Engineering").
      const t = String(title ?? '').replace(/_+/g, ' ');
      const bad = exclude.find((x) => x.test(t));
      if (bad) return { ok: false, excluded: true, reason: `title contains "${bad.term}"` };
      const hits = include.filter((x) => x.test(t));
      if (hits.length === 0) return { ok: false, reason: 'title matches none of your target titles' };
      // Report the most specific term that matched (longest), e.g. "Solution Architect" over "Architect".
      return { ok: true, matched: hits.sort((a, b) => b.term.length - a.term.length)[0].term };
    },

    /** null location = unknown; `keep_unknown` decides. */
    location(location) {
      if (places.length === 0) return { ok: true };
      if (!location) return settings.locations.keep_unknown ? { ok: true } : { ok: false, reason: 'location unknown' };
      return places.some((test) => test(location)) ? { ok: true } : { ok: false, reason: `location "${location}" is outside your list` };
    },
  };
}
