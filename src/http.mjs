// One place for every network call: timeout, retry with backoff, and an error
// message that names the URL, so a broken company shows up in the report as a
// readable line instead of a stack trace.

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a URL and parse the JSON body.
 * Retries network errors and 408/429/5xx up to `retries` times.
 */
export async function fetchJson(url, opts = {}) {
  return request(url, opts, 'application/json', (text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(`not JSON from ${shortUrl(url)} (got ${text.slice(0, 60).replace(/\s+/g, ' ')}…)`, { url });
    }
  });
}

/** Fetch a URL and return the body as text (for career sites that only serve HTML). Same retries as fetchJson. */
export async function fetchText(url, opts = {}) {
  return request(url, opts, 'text/html,application/xhtml+xml', (text) => text);
}

async function request(url, { method = 'GET', body, headers = {}, timeoutMs = 30000, retries = 3 } = {}, accept, parse) {
  const init = {
    method,
    headers: {
      Accept: accept,
      'User-Agent': 'axia/1.0 (+https://github.com/khubli/axia; personal job search, one read a day)',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return parse(await res.text());
      lastError = new HttpError(`HTTP ${res.status} from ${shortUrl(url)}`, { status: res.status, url });
      if (!RETRYABLE.has(res.status)) throw lastError;
    } catch (err) {
      if (err instanceof HttpError && !RETRYABLE.has(err.status)) throw err;
      lastError = err instanceof HttpError ? err : new HttpError(`${err.name === 'TimeoutError' ? 'timed out' : err.message} (${shortUrl(url)})`, { url });
    }
  }
  throw lastError;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.slice(0, 60);
  } catch {
    return String(url).slice(0, 80);
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
