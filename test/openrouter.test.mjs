// OpenRouter and other OpenAI-compatible providers: same scorer interface as Claude.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeScorer } from '../src/score.mjs';
import { ConfigError } from '../src/config.mjs';

const settings = (scoring = {}) => ({
  titles: { include: ['Architect'], exclude: [] },
  locations: { include: [], keep_unknown: true },
  scoring: { provider: 'openrouter', model: 'example/model-large', effort: 'medium', base_url: '', batch_size: 2, keywords: [], ...scoring },
  report: { timezone: 'UTC', good_match: 65, show_from: 50 },
});
const jobs = [1, 2, 3].map((i) => ({ key: `k${i}`, company: 'Woodgrove Bank', title: `Payments Architect ${i}`, location: 'London', description: 'Own the payments platform.' }));

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const out = await handler(body, calls.length);
    return new Response(typeof out === 'string' ? out : JSON.stringify(out.body ?? out), { status: out.status ?? 200 });
  };
  fn.calls = calls;
  return fn;
}
const answer = (body, extra = '') => {
  const ids = [...body.messages[1].content.matchAll(/<job id="(\d+)">/g)].map((m) => m[1]);
  const content = JSON.stringify({ results: ids.map((id) => ({ id, score: 60 + Number(id), summary: `Fits ${id}.`, strengths: ['payments'], gaps: ['scale'] })) });
  return { model: 'example/model-large-2026', choices: [{ message: { content: extra ? `${extra}\n${content}\n${extra}` : content } }] };
};

test('openrouter: batches roles, asks for a JSON-schema answer, keeps your key in the header', async () => {
  const fetchImpl = fakeFetch((body) => answer(body));
  const scorer = makeScorer({ env: { OPENROUTER_API_KEY: 'or-key' }, settings: settings(), resume: 'R'.repeat(300), criteria: 'C', fetchImpl });
  assert.equal(scorer.engine, 'OpenRouter');
  const { scores, failed, stoppedBecause } = await scorer.scoreAll(jobs);
  assert.equal(stoppedBecause, null);
  assert.equal(failed, 0);
  assert.equal(scores.size, 3);
  assert.deepEqual({ ...scores.get('k1'), summary: undefined }, { value: 61, summary: undefined, strengths: ['payments'], gaps: ['scale'], scorer: 'ai', model: 'example/model-large-2026' });
  assert.equal(fetchImpl.calls.length, 2, '3 roles in batches of 2');
  const first = fetchImpl.calls[0];
  assert.equal(first.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(first.headers.Authorization, 'Bearer or-key');
  assert.equal(first.headers['X-Title'], 'Axia');
  assert.equal(first.body.model, 'example/model-large');
  assert.equal(first.body.response_format.type, 'json_schema');
  assert.deepEqual(first.body.reasoning, { effort: 'medium' });
  assert.match(first.body.messages[0].content, /<resume>\nR+\n<\/resume>/);
});

test('a model without JSON-schema answers falls back to JSON mode, and remembers it', async () => {
  const fetchImpl = fakeFetch((body) =>
    body.response_format?.type === 'json_schema'
      ? { status: 400, body: { error: { message: 'response_format json_schema is not supported by this model' } } }
      : answer(body, '```json'),
  );
  const scorer = makeScorer({ env: { OPENROUTER_API_KEY: 'k' }, settings: settings(), resume: 'R', criteria: '', fetchImpl });
  const { scores } = await scorer.scoreAll(jobs);
  assert.equal(scores.size, 3, 'fenced JSON is read too');
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.response_format?.type), ['json_schema', 'json_object', 'json_object']);
});

test('a bad key or no credit stops scoring at once, without trying every batch', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 402, body: { error: { message: 'Insufficient credits' } } }));
  const scorer = makeScorer({ env: { OPENROUTER_API_KEY: 'k' }, settings: settings(), resume: 'R', criteria: '', fetchImpl });
  const { scores, stoppedBecause } = await scorer.scoreAll(jobs);
  assert.equal(scores.size, 0);
  assert.match(stoppedBecause, /HTTP 402 Insufficient credits/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('openai-compatible: any base URL, key optional (a local Ollama needs none)', async () => {
  const fetchImpl = fakeFetch((body) => answer(body));
  const scorer = makeScorer({ env: {}, settings: settings({ provider: 'openai-compatible', base_url: 'http://localhost:11434/v1/', model: 'llama3.1' }), resume: 'R', criteria: '', fetchImpl });
  assert.equal(scorer.engine, 'OpenAI-compatible API (localhost:11434)');
  await scorer.scoreAll(jobs.slice(0, 1));
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].headers.Authorization, undefined);
  assert.equal(fetchImpl.calls[0].body.reasoning, undefined, 'OpenRouter-only parameter');
});

test('auto picks the provider from the secrets present', () => {
  const s = settings({ provider: 'auto' });
  assert.equal(makeScorer({ env: { OPENROUTER_API_KEY: 'k' }, settings: s, resume: 'R', criteria: '' }).engine, 'OpenRouter');
  assert.equal(makeScorer({ env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, settings: { ...s, scoring: { ...s.scoring, model: 'sonnet' } }, resume: 'R', criteria: '' }).engine, 'Claude Code (your subscription)');
  assert.equal(makeScorer({ env: {}, settings: s, resume: 'R', criteria: '' }), null);
});

test('settings mistakes are explained, not guessed at', () => {
  const make = (scoring, env = { OPENROUTER_API_KEY: 'k' }) => () => makeScorer({ env, settings: settings(scoring), resume: 'R', criteria: '' });
  assert.throws(make({ model: 'sonnet' }), (e) => e instanceof ConfigError && /model id such as "provider\/model"/.test(e.message));
  assert.throws(make({}, {}), /scoring.provider is openrouter, but the OPENROUTER_API_KEY secret is not set/);
  assert.throws(make({ provider: 'openai-compatible', base_url: '' }), /scoring.base_url is needed/);
  assert.throws(make({ provider: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: '' }), /scoring.model must be the provider's model id for OpenAI-compatible API/);
  assert.throws(make({ provider: 'gemini-direct' }), /scoring.provider must be one of/);
});
