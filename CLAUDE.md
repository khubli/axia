# CLAUDE.md — Axia (public engine)

Axia is a private job radar. It reads target companies' careers sites daily, scores each role against a resume with Claude, publishes a private dashboard and messages the user only when a role clears their bar. One pipeline, no server, no database. Keep it that way.

**This is the public, MIT-licensed repo.** Users run it as a GitHub Action (`khubli/axia@v1`) from their own private repo. The maintainer's own settings live in a separate private repo and never come here.

## Where rules and decisions live
- **Engine rules:** this file. When a new rule about the engine, releases or docs is agreed, add it here in the same PR.
- **Engine decisions and why:** [CHANGELOG.md](CHANGELOG.md), one entry per release.
- **Everything personal** (the maintainer's resume, companies, settings, job-search decisions and open items) lives in the maintainer's own private settings repo, which has its own CLAUDE.md. Never copy anything from it here, and don't name it in this repo: examples call it `my-axia`.

## Read first
- [CONTRIBUTING.md](CONTRIBUTING.md): where everything lives, how to add a job site, PR rules
- [docs/how-it-works.md](docs/how-it-works.md), [docs/configuration.md](docs/configuration.md), [docs/setup.md](docs/setup.md)
- [CHANGELOG.md](CHANGELOG.md): what changed and why, newest first

## Non-negotiables
- **No personal data, ever.** That means no real resumes, settings, scores, company lists, run logs or role titles from the maintainer's own search. Test data uses fictional companies only (Woodgrove Bank, Contoso Pay, Fabrikam Capital…).
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
5. Adding a job site: a reader in `src/sources/` that reads the site's public JSON, with a recorded sample in `test/fixtures/` using made-up company details (see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-job-site)). Then list the platform in the README and `docs/configuration.md`.

## Releases
- Every user runs `@v1`, so a release has two steps:
  1. **Merge to `main`:** version bumped and CHANGELOG entry written, tests green on GitHub.
  2. **Move `v1` to `main`** (`git push origin origin/main:refs/heads/v1`, fast-forward only). This is a production deploy for every user. Do it only after the maintainer's explicit go-ahead for that exact step. A merged PR or an unanswered question is not a go-ahead.
- Versions: a feature takes the next free minor (1.36.0 → 1.37.0), a fix the next patch. When several branches release at once, whichever merges second takes the next number and rebases.
- Git tags and GitHub releases (`v1.x.y`) are made by the maintainer in the GitHub UI; automated sessions can't push tags.
- Users see a release only after their own next run, not when it merges.

## Docs with each release
Releases tend to update the CHANGELOG and `docs/configuration.md` and forget the rest. With each user-visible change, also check:
- README feature list and screenshots (retake from `npm run demo`: desktop 1440 wide in light mode, phone 390×844 @2x in dark mode)
- the CONTRIBUTING file map, SECURITY.md (anything that writes or stores data) and `examples/instance/`
- the overview image, whose source is `docs/images/how-it-works.html`
- Demo and example data stay made up: fictional companies, roles and candidate.
