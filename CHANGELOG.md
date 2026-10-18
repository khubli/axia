# Changelog

## 1.4.0

- **What the posting requires.** Each AI score now lists up to four things the posting itself requires, in its own words, and whether your resume shows each: yes, partly or no. A requirement is kept only when its quote is really in the posting, so one the model made up never reaches the dashboard. The score itself is judged as before; roles get the list when they are next scored.

- **Gaps that keep coming up.** Once a week, when they have changed, the gaps and unmet requirements of your open roles scored 55 to 89 are grouped into a few themes, each with the roles behind it, shown at the top of the Roles tab and as one line in the weekly message. For each theme, add the evidence to your resume if you have it, or accept the gap in `criteria.md`; Axia changes neither. One small model request a week. Set the band with `gaps.min_score` and `gaps.max_score`; `gaps: false` turns it off ([details](docs/configuration.md#what-the-posting-requires-and-gaps-that-keep-coming-up)).

## 1.3.0

- **Moonshots.** A new dashboard tab for stretch roles you track outside Axia: roles beyond your companies' boards, picked for career upside rather than fit, kept in a `moonshots.json` next to your settings by hand or by another tool such as a daily research task. Each run shows the latest file: top picks, then new, closing-soon and open roles with why each is a step up, key requirements, gaps, your estimated fit and the posting link; closed roles fold away. Axia does not score these roles or message about them. No file, no tab; `moonshots: false` turns it off ([format](docs/configuration.md#moonshotsjson)).

## 1.2.0

- **Your calls, and a weekly review.** Each role on the dashboard has **Applied**, **Shortlist** and **Not for me** buttons, with an optional one-line reason. They save to a Workers KV store in your Cloudflare account through the dashboard's Worker, behind your login, and each run copies them into `data/feedback.json` with the posting text. Not for me roles leave the list (a chip brings them back). Once a week (`review.day`, default Sunday) Axia checks its scores against your calls; when some disagree, the model proposes the smallest edit to `criteria.md`, Axia scores your judged roles with and without it, and only if the edit agrees with you more often does it open a pull request with the numbers. `axia calibrate` now counts your calls too. Setup: allow GitHub Actions to create pull requests in your repository, and add `pull-requests: write` to the workflow ([setup](docs/setup.md#6-run-it)).

- **Left out.** The dashboard's Companies tab now lists what your filters dropped, for quick spot checks: titles in your places that your title words missed and the second look didn't let in, titles with one of your excluded words, and the places outside your list where roles with a title you want turned up (a different spelling of your city shows up there). Each title links to its posting; a search box narrows the list.

## 1.1.0

- **Second look.** Roles in your places whose titles have none of your title words (and none of your excluded words) are no longer simply dropped: the model reads their titles, in batches, against your resume and criteria, and lets through the ones that could plausibly be in scope, such as an employer's "Executive Manager" or "Chief Engineer". It can only let roles in: they are read and scored in full like any other role, and when the model is unsure, wrong or unavailable nothing changes. Each title is asked about once. Roles found this way are labelled **Second look** on the dashboard. Preview it with `axia second-look`; turn it off with `titles.second_look: false`.

## 1.0.1

- **Fixed: different jobs merged as duplicates.** Postings with the same title and place were counted once even when they described different jobs (one bank's three "Engineering Manager" openings in one city), so all but one were never scored or shown. Now two postings count as one job only when their descriptions are essentially the same; otherwise both are kept.
- **Fixed: titles joined by underscores** ("Lead _Vice President _Software Engineering") did not match your title words.
- **Fixed: the dashboard said "Read today"** the morning after an evening run. Read status, warnings and posting ages now count from your own date.

## 1.0.0

First public release.

- **Reads** Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Oracle Recruiting Cloud and Goldman Sachs career sites through their public JSON feeds. Any other site is listed as "check by hand".
- **Filters** by title words and places, free. The same role posted twice counts once.
- **Scores** each remaining posting from 0 to 100: with Claude on a Pro or Max subscription (via Claude Code) or an API key, with any model on OpenRouter, or with any OpenAI-compatible API. Hard stops are kept apart from soft gaps. Each role is scored once, and again only when your resume or criteria change.
- **Remembers** every role in your repository. A role closes when it is taken down, when its site can't be read for 7 days, or when you remove the company.
- **Messages** at most once per run on Telegram or email:
  - new good matches, each sent once ever;
  - problems that last;
  - a silent weekly check-in.
- **Dashboard** on your own domain behind a Cloudflare Access login, checked after every publish. Installable as an app: works offline, refreshes itself, follows a light/dark switch.
- **Calibrate** with `axia calibrate`, which compares Claude's verdicts with roles you judged yourself.
- **GitHub Action** (`khubli/axia@v1`), docs for the two-repository setup, and a starter private repository in `examples/instance/`.
