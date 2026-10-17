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

## calibration/roles.yml

Roles you have judged yourself, so you can measure how often the model agrees with you.

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
| `dashboard/README.md` | yes | the plain list, readable on GitHub |
| `.axia/` | no | the built dashboard and its publish settings |
