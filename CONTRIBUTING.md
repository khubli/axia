# Contributing to Axia

Thanks for helping. Axia is small on purpose: one pipeline, no server, no database. Changes that keep it that way are the easiest to accept.

## Run it

```sh
npm ci
npm test              # offline; job boards, AI models and Telegram are answered by recorded responses
npm run demo          # builds the demo dashboard into _site/ (made-up data); open _site/index.html
node src/cli.mjs run --dir ../my-axia --dry-run   # against your own settings, reading the real boards
```

Node 22 or later. No other tools are needed.

## Where things live

| Path | What |
|---|---|
| `src/sources/` | One file per job site (Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Oracle, SuccessFactors, Eightfold, TurboHire, Amazon, Google, Goldman Sachs) |
| `src/run.mjs` | The daily pass: read, filter, remember, score, notify, write |
| `src/score.mjs` | AI scoring (Claude Code on a subscription, the Claude API, OpenRouter, OpenAI-compatible APIs) and the keyword fallback |
| `src/notify.mjs` | What gets sent and when; Telegram and email |
| `src/site.mjs`, `src/dashboard/` | The dashboard page, service worker, icons and fonts |
| `src/deploy.mjs` | Publishing to Cloudflare and the login check |
| `action.yml` | The GitHub Action people use from their private repository |
| `examples/instance/` | The starter private repository |

## Adding a job site

A source exports `type`, `match(url)` (returns params including a stable `scope`, or null), `list(params, ctx)` and, if the list has no descriptions, `detail(params, job, ctx)`. Use the site's own public JSON, the same calls its careers page makes in a browser: no logins, no scraping of rendered pages, nothing a site's terms forbid. Add a recorded sample to `test/fixtures/` with made-up company details, and tests in `test/sources.test.mjs`.

## Pull requests

- Keep each change focused, with a test that would fail without it.
- `npm test` must pass.
- Never commit real resumes, settings, scores or company lists. Test data uses fictional companies (Woodgrove Bank, Contoso Pay, Fabrikam Capital…).
- Write messages and UI text the way the rest reads: plain, specific, to the reader.

## Questions and ideas

Open an issue. For anything security-related, see [SECURITY.md](SECURITY.md) instead.
