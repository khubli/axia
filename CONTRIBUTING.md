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
| `src/config.mjs` | Reads `companies.yml`, `settings.yml` and the resume, with plain error messages |
| `src/filter.mjs`, `src/secondlook.mjs` | Title and place filter; the model's second look at titles your words miss |
| `src/score.mjs` | AI scoring (Claude Code on a subscription, the Claude API, OpenRouter, OpenAI-compatible APIs) and the keyword fallback |
| `src/levels.mjs`, `src/pay.mjs` | The step up / same level / step down label and the pay range, both returned in the scoring answer |
| `src/catchup.mjs` | Fills those fields on roles scored before they existed, without re-scoring |
| `src/state.mjs` | Memory between runs (`data/jobs.json`): new, open, closed, reopened |
| `src/changes.mjs` | "What changed in the last run", by comparing memory before and after (no AI) |
| `src/feedback.mjs`, `src/review.mjs`, `src/calibrate.mjs` | Your calls from the dashboard, the weekly criteria review, and `axia calibrate` |
| `src/gaps.mjs` | The weekly "what keeps coming up" themes |
| `src/insights.mjs` | The Insights tab: what the roles ask for by theme, cities and closing speed (no AI) |
| `src/todo.mjs` | Your to-do list (`todo.yml`) and the ticks and notes made on the dashboard (`data/todo.json`) |
| `src/moonshots.mjs`, `src/tailor.mjs` | The optional Moonshots tab and Tailor requests |
| `src/layoffs.mjs` | The optional Layoffs label, from your hand-kept `layoffs.yml` |
| `src/render.mjs` | The view model shared by the dashboard and `dashboard/README.md` |
| `src/notify.mjs` | What gets sent and when; Telegram and email |
| `src/site.mjs`, `src/dashboard/` | The dashboard page, its Worker (saves your calls and Tailor clicks), service worker, icons and fonts |
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
