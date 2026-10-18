# Configuration

Everything lives in your private repository (see [setup.md](setup.md)). Paths are relative to the folder holding `settings.yml`.

## companies.yml

```yaml
companies:
  - name: Stripe
    url: https://job-boards.greenhouse.io/stripe
  - name: Big Bank                 # several boards, counted once per role
    url:
      - https://bigbank.wd3.myworkdayjobs.com/en-US/External
      - https://bigbank.wd3.myworkdayjobs.com/en-US/Campus
  - name: Paused Co
    url: https://jobs.lever.co/paused
    enabled: false                 # stops watching; its roles leave the dashboard
```

The address decides how a company is read:

| Job site | Address looks like |
|---|---|
| Workday | `https://<company>.wd<N>.myworkdayjobs.com/<site>` (a language part such as `/en-US` is fine) |
| Greenhouse | `https://job-boards.greenhouse.io/<company>` or `boards.greenhouse.io/<company>` |
| Lever | `https://jobs.lever.co/<company>` (also `jobs.eu.lever.co`) |
| Ashby | `https://jobs.ashbyhq.com/<company>` |
| SmartRecruiters | `https://jobs.smartrecruiters.com/<company>` |
| Oracle Recruiting Cloud | `https://<host>.oraclecloud.com/hcmUI/CandidateExperience/<lang>/sites/<site>` |
| Goldman Sachs | `https://higher.gs.com` |

Any other address is shown as "check by hand" with a link, so nothing silently drops out. A company whose board fails to load keeps its roles as they were; after 7 days without a successful read they close.

## settings.yml

Every key is optional except `titles.include`. Defaults in brackets.

```yaml
resume: cv.md                    # [cv.md] your resume in Markdown

titles:
  include: [Architect, Engineering Manager]   # a role is kept when its title has one of these
  exclude: [Intern, Sales]                    # ...and none of these (whole words)
  second_look: true                           # [true] titles in your places that miss your words get a look from the model; it can only let roles in

locations:
  include: [London, Remote]      # whole words, matched against the role's location
  keep_unknown: true             # [true] keep roles listed without a location

scoring:
  provider: auto                 # [auto] auto, claude-code, anthropic, openrouter, openai-compatible or keyword
                                 #   auto: Anthropic key, then Claude token, then OpenRouter key, then LLM_API_KEY + base_url
  model: sonnet                  # [sonnet] Claude: sonnet, opus or haiku. OpenRouter / OpenAI-compatible: the provider's model id
  effort: medium                 # [medium] low, medium or high: how hard the model thinks (Claude, and OpenRouter models that reason)
  base_url: ''                   # [none] openai-compatible only, e.g. https://api.openai.com/v1; openrouter defaults to its own
  criteria: criteria.md          # [criteria.md] what a good role looks like for you
  max_ai_scores_per_run: 40      # [40] the rest wait for the next run
  batch_size: 8                  # [8] roles per request (Claude subscription, OpenRouter, OpenAI-compatible)
  keywords: [payments, platform] # [] make a role more promising for the AI queue, and lift keyword estimates

report:
  timezone: Europe/London        # [UTC] for dates on the dashboard and in messages
  good_match: 65                 # [65] the dashboard's "good match" band
  show_from: 50                  # [50] the "worth a look" band starts here

notify:
  min_score: 65                  # [65] message when a role first scores this or more
  weekly: monday                 # [monday] the weekly "still running" note; false turns it off

dashboard:
  domain: jobs.example.com       # [none] your Cloudflare Access-protected address; empty uses workers.dev
  worker: axia                   # [axia] the Cloudflare Worker's name
  url: https://jobs.example.com  # [https://<domain>] used for links in messages
  public: false                  # [false] true skips the login check; only for a demo with no personal data
  feedback: true                 # [true] Applied / Shortlist / Not for me buttons on each role, saved to your Cloudflare account

review:
  day: sunday                    # [sunday] the weekly review of your calls; false turns it off
  max_roles: 60                  # [60] your most recent calls it checks against (plus everything in calibration/roles.yml)

moonshots:
  file: moonshots.json           # [moonshots.json] stretch roles you track elsewhere, shown on their own tab; false turns it off

gaps:                            # false turns it off
  min_score: 55                  # [55] the gaps that keep coming up are read from open roles scored this much or more…
  max_score: 89                  # [89] …up to this much
```

The GitHub variable `NOTIFY_MIN_SCORE` overrides `notify.min_score`, so you can change the message threshold without a commit.

Changing titles or locations applies to remembered roles on the next run: roles that no longer pass leave the dashboard.

## criteria.md

Plain prose that the model reads with your resume for every role. What helps most:

- **Hard stops**: functions or conditions that rule a role out whatever the title ("pre-sales", "needs visa sponsorship").
- **Soft gaps**: things that cost a few points but are not a reason to skip ("a specific tool I haven't used").
- **Level**: what counts as a step down for you, and what does not ("lead architect at a large bank is not below my level").
- **Title traps**: titles that match your words but mean something else ("Platform Architect when the platform is network infrastructure").

After editing it, run `axia calibrate` (below) before trusting the change.

## Your calls on the dashboard

Open a role and mark it **Applied**, **Shortlist** or **Not for me**, with a one-line reason if you like. Applied and Shortlist count as "worth applying", Not for me as "skip". Roles you mark Not for me leave the list; the **Not for me** chip brings them back.

The buttons save to a Workers KV store in your Cloudflare account, behind the same login as the dashboard. Each run copies the calls into `data/feedback.json` with the posting text, so they last after the role closes. They count as judged roles for `axia calibrate` and the weekly review. If a call can't be saved (offline, or signed out), it waits on your device and is sent the next time the dashboard opens online.

**The weekly review** (`review.day`) runs when some of your calls disagree with the scores: a role you skipped that scored `report.good_match` or more, or one you wanted that scored below. The model reads your calls, reasons and postings with your resume and `criteria.md`, and proposes the smallest edit to `criteria.md` that would fix them. Axia then scores every judged role twice in the same run, with today's criteria and with the proposal. Only if the proposal agrees with your calls more often, and loses none of your `calibration/roles.yml` roles, does it open a pull request with the edit and the numbers, and message you. Nothing changes until you merge it; one proposal is open at a time. It needs at least 3 calls with their posting saved. A review uses about two AI scores per judged role.

## What the posting requires, and gaps that keep coming up

Each AI score also lists up to four things the posting itself requires, in the posting's own words, and whether your resume shows each (yes, partly, no). Axia keeps one only when its quote is really in the posting, so a requirement the model made up never reaches the dashboard. They explain the score; they don't change it.

Once a week, when they have changed, the gaps and unmet must-haves of your open roles scored `gaps.min_score` to `gaps.max_score` are grouped by the model into a few themes, each with the roles behind it, shown at the top of the dashboard's Roles tab and as one line in the weekly message. For each theme, decide once: add the evidence to your resume if you have it, or accept the gap in `criteria.md`. Axia never edits either. It takes one small model request a week.

## moonshots.json

An optional short list of stretch roles you track outside Axia: roles beyond your companies' boards, picked for career upside rather than fit, by hand or by another tool such as a daily research task. When the file is there, each run shows it on the dashboard's **Moonshots** tab. Axia does not read or score these roles and never messages about them; it shows what the file says, cleaned up. No file, no tab.

```json
{
  "updatedAt": "2026-10-18T15:25:00Z",
  "summary": "One or two sentences on today's search.",
  "picks": [
    { "label": "Best overall", "role": "bluesky-principal-architect", "note": "Why, in a line." }
  ],
  "roles": [
    {
      "id": "bluesky-principal-architect",
      "company": "Bluesky Cloud",
      "title": "Principal Architect, Financial Services",
      "location": "London, United Kingdom",
      "category": "Big Tech",
      "status": "active",
      "fit": "medium",
      "why": "Why it would be a step up.",
      "requirements": ["15+ years in architecture"],
      "gaps": ["No public-cloud certification"],
      "url": "https://careers.example.com/123",
      "firstSeen": "2026-10-14",
      "lastVerified": "2026-10-18",
      "closesOn": "2026-10-27",
      "note": "Anything else worth a line."
    }
  ],
  "notes": ["What the search could not check today."]
}
```

- Only `company` and `title` are required for a role; a role without them is left out, with the reason in the run log.
- `status` is `new`, `active`, `closing` or `closed`, and `fit` is `high`, `medium` or `stretch` (words such as "🔥 ACTIVE" or "High/Medium" are understood). New, closing and open roles are listed in that order; closed ones fold away.
- `picks` point at a role by its `id`, or carry only a `note`.
- Dates are `YYYY-MM-DD`; links must start with `https://` or `http://`.
- If the file can't be read, the tab says why and the rest of the run carries on. If `updatedAt` is more than two days old, the tab says the report is stale.

Whatever writes the file commits it next to `settings.yml` (or where `moonshots.file` points); the next run publishes it.

## calibration/roles.yml

Roles you have judged yourself, so you can measure how often the model agrees with you. Your calls on the dashboard count too (above); this file is for roles you want to keep as fixed reference points, with a 1–5 score.

```yaml
- company: Example Bank
  title: Head of Platform Engineering
  location: London
  file: example-head-of-platform.md   # the job description, saved in calibration/
  your_score: 4                       # 1 to 5
  decision: Apply                     # Apply or Skip
```

`axia calibrate --dir <your folder>` scores each one and prints where the model's verdict (at `report.good_match`) differs from yours, the average distance from your scores, and whether every Apply ranks above every Skip.

## Secrets and variables (in your private repository)

| Name | Kind | What for |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | AI scoring on your Claude subscription (`claude setup-token`) |
| `ANTHROPIC_API_KEY` | secret | AI scoring with the Claude API, billed per use |
| `OPENROUTER_API_KEY` | secret | AI scoring with any model on OpenRouter (`scoring.provider: openrouter`) |
| `LLM_API_KEY` | secret | AI scoring with another OpenAI-compatible API (`scoring.provider: openai-compatible`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | secrets | messages on Telegram |
| `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_TO` | secrets | messages by email |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secrets | publishing the dashboard |
| `NOTIFY_MIN_SCORE` | variable | message threshold, overrides `notify.min_score` |

## Files Axia writes

| File | Committed | What it is |
|---|---|---|
| `data/jobs.json` | yes | every matching role, open or recently closed, with its score and when you were told about it |
| `data/feedback.json` | yes | your calls from the dashboard, with each posting's text and its latest score, and the date of the last weekly review |
| `dashboard/README.md` | yes | the plain list, readable on GitHub |
| `.axia/` | no | the built dashboard and its publish settings; `.axia/review/` holds what the last weekly review tried |
