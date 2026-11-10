# CLAUDE.md — Axia (public engine)

Axia is a private job radar. It reads target companies' careers sites daily, scores each role against a resume with Claude, publishes a private dashboard and messages the user only when a role clears their bar. One pipeline, no server, no database. Keep it that way.

**This is the public, MIT-licensed repo.** Users run it as a GitHub Action (`khubli/axia@v1`) from their own private repo. The maintainer's own settings live in a separate private repo and never come here.

## Read first
- [CONTRIBUTING.md](CONTRIBUTING.md): where everything lives, how to add a job site, PR rules
- [docs/how-it-works.md](docs/how-it-works.md), [docs/configuration.md](docs/configuration.md), [docs/setup.md](docs/setup.md)
- [CHANGELOG.md](CHANGELOG.md): what changed and why, newest first

## Non-negotiables
- **No personal data, ever.** That means no real resumes, settings, scores, company lists, run logs or role titles from Krishna's search. Test data uses fictional companies only (Woodgrove Bank, Contoso Pay, Fabrikam Capital…).
- Job sources use the site's own public JSON (the calls its careers page makes). No logins, no scraping of rendered pages, nothing a site's terms forbid.
- Users depend on `@v1`. Don't break `action.yml` inputs or the settings-file format without a migration path and a CHANGELOG note.
- Write UI text, messages and docs the way the rest reads: plain, specific, to the reader.

## Commands
```bash
npm ci
npm test        # offline: boards, models and Telegram are recorded responses
npm run demo    # demo dashboard into _site/ (made-up data)
node src/cli.mjs run --dir ../my-axia --dry-run   # against a real settings folder
```
Node 22+. No other tools are needed.

## Every change
1. Keep it focused, with a test in `test/` that would fail without it.
2. `npm test` passes.
3. User-visible change: bump `version` in `package.json` and add a `CHANGELOG.md` entry in the existing style (bold one-line summary, then details, with a link to the doc section).
4. Update `docs/` when behaviour or settings change.
