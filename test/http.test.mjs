import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../src/http.mjs';
import { stubFetch } from './helpers.mjs';

const challenge = () =>
  new Response('<!DOCTYPE html><html><head></head><body>Checking your browser…</body></html>', {
    status: 429,
    headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
  });

test("a site's bot check is reported as a block and not asked again", async () => {
  const stub = stubFetch([['woodgrove.wd5.myworkdayjobs.com', challenge]]);
  try {
    await assert.rejects(
      fetchJson('https://woodgrove.wd5.myworkdayjobs.com/wday/cxs/woodgrove/Careers/jobs', { method: 'POST', body: {} }),
      (err) => err.blocked === true && err.status === 429 && /blocked by the site's bot check at woodgrove\.wd5\.myworkdayjobs\.com/.test(err.message),
    );
    assert.equal(stub.calls.length, 1, 'a bot check is not retried');
  } finally {
    stub.restore();
  }
});
