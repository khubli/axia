// The careers-page URL in companies.yml decides how a company is read.
// Anything not recognised is reported as "check manually" — never silently skipped.

import * as workday from './workday.mjs';
import * as greenhouse from './greenhouse.mjs';
import * as smartrecruiters from './smartrecruiters.mjs';
import * as oracle from './oracle.mjs';
import * as goldman from './goldman.mjs';
import * as lever from './lever.mjs';
import * as ashby from './ashby.mjs';

export const SOURCES = [workday, greenhouse, smartrecruiters, oracle, goldman, lever, ashby];

/** @returns {{source: object, params: object} | null} */
export function detect(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const source of SOURCES) {
    const params = source.match(url);
    if (params) return { source, params };
  }
  return null;
}
