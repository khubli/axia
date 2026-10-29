// The careers-page URL in companies.yml decides how a company is read.
// Anything not recognised is reported as "check manually" — never silently skipped.

import * as workday from './workday.mjs';
import * as greenhouse from './greenhouse.mjs';
import * as smartrecruiters from './smartrecruiters.mjs';
import * as oracle from './oracle.mjs';
import * as goldman from './goldman.mjs';
import * as lever from './lever.mjs';
import * as ashby from './ashby.mjs';
import * as successfactors from './successfactors.mjs';
import * as eightfold from './eightfold.mjs';
import * as amazon from './amazon.mjs';
import * as google from './google.mjs';
import * as turbohire from './turbohire.mjs';
import * as phenom from './phenom.mjs';
import * as jibe from './jibe.mjs';
import * as deshaw from './deshaw.mjs';
import * as avature from './avature.mjs';
import * as talentsoft from './talentsoft.mjs';
import * as bpce from './bpce.mjs';
import * as ripplehire from './ripplehire.mjs';
import * as radancy from './radancy.mjs';

export const SOURCES = [workday, greenhouse, smartrecruiters, oracle, goldman, lever, ashby, amazon, google, turbohire, eightfold, successfactors, phenom, jibe, deshaw, avature, talentsoft, bpce, ripplehire, radancy];

/** Sites the address can't identify; companies.yml names them with `platform:`. */
export const PLATFORMS = [successfactors.type, eightfold.type, phenom.type, jibe.type, talentsoft.type, radancy.type];

/** @returns {{source: object, params: object} | null} */
export function detect(rawUrl, platform) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const source of platform ? SOURCES.filter((s) => s.type === platform) : SOURCES) {
    const params = source.match(url, { platform });
    if (params) return { source, params };
  }
  return null;
}
