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
  - name: Branded Co               # a SuccessFactors site on the employer's own domain
    url: https://careers.branded.example/search/?locationsearch=India
    platform: successfactors
  - name: JP Morgan
    url: https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs
    rank: 4                        # optional: your own ranking, 1 = favourite (for hiring heat)
    news: JPMorgan Chase           # optional: the name the news uses, when it differs (for hiring heat)
```

The address decides how a company is read:

| Job site | Address looks like |
|---|---|
| Workday | `https://<company>.wd<N>.myworkdayjobs.com/<site>` (a language part such as `/en-US` is fine) |
| Greenhouse | `https://job-boards.greenhouse.io/<company>` or `boards.greenhouse.io/<company>` |
| Lever | `https://jobs.lever.co/<company>` (also `jobs.eu.lever.co`) |
| Ashby | `https://jobs.ashbyhq.com/<company>` |
| SmartRecruiters | `https://jobs.smartrecruiters.com/<company>` |
| Oracle Recruiting Cloud | `https://<host>.oraclecloud.com/hcmUI/CandidateExperience/<lang>/sites/<site>` (also `.oraclecloud.eu`) |
| Goldman Sachs | `https://higher.gs.com` |
| Amazon | `https://www.amazon.jobs/en/search?country=IND` (the search's filters carry over) |
| Google | `https://www.google.com/about/careers/applications/jobs/results?location=India` (filters carry over) |
| Eightfold | `https://<company>.eightfold.ai/careers?location=India`; on the employer's own domain add `platform: eightfold` |
| TurboHire | `https://<company>.turbohire.co/dashboardv2` (every open role, with descriptions) |
| Phenom | the site's search page, such as `https://careers.<company>.com/global/en/search-results?country=India`, plus `platform: phenom` |
| iCIMS (Jibe) | the site's job list, such as `https://jobs.<company>.com/jobs?location=India`, plus `platform: jibe` |
| D. E. Shaw | `https://www.deshawindia.com/careers` (India) or `https://www.deshaw.com/careers` |
| Avature | `https://<company>.avature.net/<portal>`, such as `https://bloomberg.avature.net/careers` |
| Talentsoft | the site's job list, such as `https://jobs.ca-cib.com/job/list-of-jobs.aspx?facet_JobCountry=96`, plus `platform: talentsoft` (not needed on `<company>.talent-soft.com`) |
| Groupe BPCE | `https://recrutement.natixis.com/en/our-job-offers/?tax_place=inde` or `https://recrutement.bpce.fr/…` (filters carry over) |
| RippleHire | `https://<company>.ripplehire.com/candidate/?token=<token>&source=CAREERSITE` (the link on the employer's careers page) |
| Radancy (TalentBrew) | the site's search page for the place you want, such as `https://www.schwabjobs.com/search-jobs/India/33995/2/1269750/22/79/50/2`, plus `platform: radancy` |

Eightfold sites on the employer's own domain (`portal.careers.<company>.com`) also need the platform named: `platform: eightfold`. `?location=` narrows the search, and `?domain=` names the company domain the site uses when it isn't the address's own; for `<company>.eightfold.ai` it is taken to be `<company>.com`.

SAP SuccessFactors career sites usually sit on the employer's own domain (`careers.<company>.com`), so the address can't identify them: add `platform: successfactors` and use the address of the site's search page. You can tell one by the `/search/` and `/job/…/<number>/` addresses and "Results 1 – 25 of N" above the list. Search terms on the address narrow what is read: `?locationsearch=India` reads only the roles the site places in India, which keeps an employer with thousands of roles to a few dozen requests, and `?q=` adds keywords. Add `&locale=en_GB` if the site's roles are in another language. Newer sites are read through their JSON search API, older ones from their search pages, 25 roles a page.

Phenom career sites also sit on the employer's own domain, so add `platform: phenom`. You can tell one by `/<country>/<language>/search-results` and `/job/<id>` addresses, and `phenompeople.com` in the page's source. The country and language in the address (`/global/en/`) are kept; a site without them is read as `/us/en/`. Terms on the address work like the site's own filters: `?country=India` reads only the roles the site places in India, and other filter names the site uses (such as `city=Pune`) can be added the same way; `?keywords=` adds search words. Requisition codes some employers add to the end of a title (`Technical Architect_3313`) are left off.

iCIMS career sites built on Jibe (`/jobs` and `/jobs/<number>` addresses, and an `/api/jobs` list behind the page) need `platform: jibe` too. Terms on the address carry over as the site's own filters, so `?location=India` reads only the roles the site places in India. Each role comes with its description, so no posting is read separately. The older iCIMS portals on `<company>.icims.com` are a different site and are not read.

Avature career sites (`<company>.avature.net/<portal>`) have no public feed, so their search pages are read, at whatever page size the site gives (Bloomberg's is 12), and every role worldwide is listed; your `locations` then keep the ones you want. A posting's text is read from its own page only when the role is about to be scored. The pages give no posting date. Avature sites on the employer's own domain, and portals that don't use Avature's standard search page, are not read.

Talentsoft (Cegid) career sites publish every role, with its description, in an RSS feed, so one request reads the whole list. On the employer's own domain add `platform: talentsoft`; `<company>.talent-soft.com` is recognised on its own. Click a country in the site's filters and copy the address: `facet_JobCountry=96` (or the feed's own `Rss_JobCountry=96`) reads only that country's roles. `LCID` picks the language (2057, English, unless the address says otherwise).

Groupe BPCE's career sites (`recrutement.natixis.com`, `recrutement.bpce.fr`) are read through the search their own pages use, each role with its description. The site's filters carry over from the address, so `?tax_place=inde` reads only the roles in India. Some roles are posted only in French.

RippleHire career sites (`<company>.ripplehire.com`) are read through the list their own pages use. Copy the link from the employer's careers page: its `token` names the company's public job list, and an address without one (such as a sign-in page) is not read. Every role is listed, a thousand per request, and your `locations` keep the ones you want. A posting's text and date are read from its own page only when the role is about to be scored. If the employer changes its token, the company shows as unreadable until the address is updated.

Radancy (TalentBrew) career sites sit on the employer's own domain, so they need `platform: radancy`. Search the site for a place or keyword and copy the address of that results page: the page says which search it shows, and that search is then read from the site's results list, 100 roles a request. A posting's text and date are read from its own page only when the role is about to be scored. Radancy pages often show the city and state without the country (Schwab's say "Hyderabad, Telangana"), so keep the city in your `locations`.

Oracle's job list pages only as far as 10,000 postings. On a site listing more, the older postings are read by posting date as well, in date ranges small enough for the list, so none are missed.

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
  levels: levels.md              # [levels.md] your level and what it is called at the companies you watch; optional
  pay: pay.yml                   # [pay.yml] optional pay figures you know of (below); false leaves the table out
  max_ai_scores_per_run: 40      # [40] the rest wait for the next run; the action's max-ai-scores input raises it for one run
  rescore_on_edit: all           # [all] what an edit to cv.md or criteria.md re-scores: all, none, or a score such as 50 (below)
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

layoffs:                         # false turns it off
  file: layoffs.yml              # [layoffs.yml] recent layoffs at your companies, kept by hand (below); no file, no labels
  months: 6                      # [6] a label shows for this many calendar months after the month it was announced

heat:                            # hiring heat per company (below); false turns it off
  news: true                     # [true] once a week, a free Google News search per company for hiring news
  signals: signals.yml           # [signals.yml] hiring signals you add by hand (below); no file, none
  days: 60                       # [60] how long a signal counts
  x_handles: []                  # [[]] recruiters on X whose hiring posts to read weekly (needs X_BEARER_TOKEN)
  x_companies: 10                # [10] also read X posts naming your top companies by rank with hiring words
  x_max_posts: 40                # [40] posts read from X a week at most (X bills per post read)

tailor:                          # true is short for enabled: true
  enabled: false                 # [false] a Tailor for this role button on each role and moonshot, queued for your own tailoring tool
  done: tailored.json            # [tailored.json] the file your tool writes when a request is done
  dispatch: ''                   # [''] owner/repo: a click also starts that repo's tailoring workflow at once
  workflow: tailor.yml           # [tailor.yml] that workflow's file name
  ref: main                      # [main] the branch it runs on

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

An edit to `criteria.md` or your resume re-scores your open roles, up to `max_ai_scores_per_run` a run, new roles first. With hundreds of open roles that takes weeks of daily runs, so `scoring.rescore_on_edit` says how far an edit reaches:

- `all` (the default): every open role is scored again, and the second look asks again about every title your words rejected.
- `none`: nothing already scored is scored again, and title verdicts already given stand. Only roles scored from the next run on use the edit. Good for small edits, such as the weekly review's.
- a score such as `50`: open roles scoring that much or more, and those you marked Applied or Shortlist, are scored again. The rest keep their score, and title verdicts stand.

Ticking **Re-score** on the workflow (`--rescore`) still scores everything again, whatever this says.

## levels.md: step up, same level or step down

Each AI score also labels the role against your current level: **Step up**, **Same level** or **Step down**, with its equivalent on your own ladder ("≈ Executive Director at your bank"). It is a label beside the score, on the dashboard and in messages, and it doesn't move the score. The dashboard can filter by it.

Titles mislead across employers: a Vice President at one bank is a Director at another, and a payments company's Vice President leads a whole organisation. So the model reads the full posting, including the years asked, team size and who the role reports to, and your optional `levels.md`:

- **Where you are now**: your title, employer, team size and years.
- **The same level as you** at the companies you watch, with one step down and one step up. levels.fyi's level pages are a good place to look these up.
- **When the title doesn't settle it**: the scope signals that mean a step up or down for you.

See `examples/instance/levels.md`. Without the file the model goes by your resume alone. The level comes in the same request as the score, so it costs a few words of answer per role.

Editing `levels.md` doesn't re-score anything. Instead, each run catches up up to 40 roles whose label is missing or was given with an older `levels.md`, in short requests that ask for the level only. Only roles you would look at are caught up: those scored `report.show_from` or more, and those you marked Applied or Shortlist. Roles scored before 1.10.0 get their label the same way.

## Your calls on the dashboard

Open a role and mark it **Applied**, **Shortlist** or **Not for me**, with a one-line reason if you like. Applied and Shortlist count as "worth applying", Not for me as "skip". Roles you mark Applied or Shortlist move from the Roles list to the **Your roles** tab. Roles you mark Not for me leave the list; the **Not for me** chip brings them back.

The buttons save to a Workers KV store in your Cloudflare account, behind the same login as the dashboard. Each run copies the calls into `data/feedback.json` with the posting text, so they last after the role closes. They count as judged roles for `axia calibrate` and the weekly review. If a call can't be saved (offline, or signed out), it waits on your device and is sent the next time the dashboard opens online.

**The weekly review** (`review.day`) runs when some of your calls disagree with the scores: a role you skipped that scored `report.good_match` or more, or one you wanted that scored below. The model reads your calls, reasons and postings with your resume and `criteria.md`, and proposes the smallest edit to `criteria.md` that would fix them. Axia then scores every judged role twice in the same run, with today's criteria and with the proposal. Only if the proposal agrees with your calls more often, and loses none of your `calibration/roles.yml` roles, does it open a pull request with the edit and the numbers, and message you. Nothing changes until you merge it; one proposal is open at a time. It needs at least 3 calls with their posting saved. A review uses about two AI scores per judged role.

## What the posting requires, and gaps that keep coming up

Each AI score also lists up to four things the posting itself requires, in the posting's own words, and whether your resume shows each (yes, partly, no). Axia keeps one only when its quote is really in the posting, so a requirement the model made up never reaches the dashboard. They explain the score; they don't change it.

Once a week, when they have changed, the gaps and unmet must-haves of your open roles scored `gaps.min_score` to `gaps.max_score` are grouped by the model into a few themes, each with the roles behind it, shown at the top of the dashboard's Roles tab and as one line in the weekly message. For each theme, decide once: add the evidence to your resume if you have it, or accept the gap in `criteria.md`. Axia never edits either. It takes one small model request a week.

## Pay range per role, and pay.yml

Each AI score also gives the role's likely pay as a range, in the currency of its place. It comes from the same request as the score, so it costs a few dozen output tokens per role and no extra requests, and it never changes the score. Where a range comes from, most trusted first:

- **Stated on the posting.** The posting gives pay. Axia keeps the posting's own words and checks they are really in the posting; a figure it can't find there is shown as an estimate.
- **From your pay table.** `pay.yml` has figures for the employer, and the model picks the level that fits the role.
- **AI estimate.** The model's own rough estimate for this kind of role, employer and place, with a few words on what it rests on.

The dashboard shows the range under each role (`~` marks anything not stated on the posting) and where it came from in the role's details. Ranges are total yearly pay (base, bonus and stock) unless the posting says otherwise.

`pay.yml` is optional. Each role's request carries only its own employer's lines, so the table can grow without making runs heavier. Amounts are whole numbers in the table's currency, or free text:

```yaml
currency: INR                          # [INR] for every company that doesn't name its own
companies:
  Example Bank:
    source: Levels.fyi, India, median total pay, read 21 Oct 2026   # shown to the model; say where figures came from
    Software Engineering Manager: { L5: 8700000, L6: 5800000 }
    Solution Architect: about 50 to 70 lakh
  Example Tech:
    currency: USD
    Software Engineer: { L5: 185000, L6: 240000 }
estimate_floor: 1500000                # [none] AI estimates whose yearly top is below this show no pay
```

Fill it from what you can see yourself: offers, recruiters, colleagues, or salary sites you read (credit them in `source`; many, such as Levels.fyi, ask for attribution and don't allow bulk collection). Axia never fetches pay data from any site. `estimate_floor` catches a model's slip, such as ₹5 to 8 lakh for a VP role (a zero dropped). An AI estimate in the table's currency whose yearly top is below it shows no pay instead; so does an estimate the model marks "placeholder". Pay stated on a posting or taken from your table is never checked against it. Setting or changing the floor asks the model nothing: pay already saved is checked on the next run, and the floor's line doesn't count as a change to the table. Pay is filled on roles as they are scored. Roles scored before, and roles on the dashboard after you change `pay.yml`, get it from the same catch-up as the level (see levels.md above).

## Recent layoffs, and layoffs.yml

A short file you keep by hand that puts a **Layoffs** label on companies that have announced job cuts: on the company's row on the **Companies** tab (with where and when), on each of its roles under the score, and in a role's details with your note and a link to the report. The Companies tab also lists them all under **Recent layoffs**, cuts in India first. The label is a heads-up for you only. It never changes a score, never hides a role and is not in any message.

Axia does not add layoffs from the news. (The weekly hiring heat scan may flag layoff news on a company for you to check; only this file lowers its heat.) You add a line when you read a report, so the label costs nothing at run time and no AI request. Each run reads the file again, and a line drops off by itself `layoffs.months` (6) calendar months after the month it was announced: a line for October 2026 shows until the end of March 2027.

```yaml
layoffs:
  - company: Example Bank          # as named in companies.yml (any capitals)
    announced: 2026-10-22          # the date, or just the month: 2026-10
    where: global                  # india, global, or a place such as UK or US
    size: about 5,000 jobs (5%)    # optional, in your words
    note: mostly UK retail         # optional
    link: https://news.example.com/example-bank-cuts   # the report you read
  - company: Example Bank
    announced: 2026-08
    where: India
    size: about 200 roles at the Pune centre
```

A company can have several lines; the newest leads. When any line says India, the label is filled in rather than outlined and names India first, because cuts where you would work matter more than cuts elsewhere. A line for a company that isn't in `companies.yml`, without a usable date, or dated in the future is skipped with the reason in the run log, and a file that isn't valid YAML only means no labels that run.

## Hiring heat, and signals.yml

How hard each of your companies seems to be hiring right now, so you can see where an extra push (a note to a hiring manager or an ex-colleague, a cold email) is most likely to land. Axia only points; the outreach is yours. Heat never changes a score, never hides a role and never decides which roles are messaged.

Each company gets points, worked out every run from Axia's own memory at no AI cost:

| Signal | Points |
|---|---|
| New senior roles in your places in the last 14 days (roles found in a company's first week in Axia don't count) | +1 each, up to +10 |
| Open roles scoring `report.show_from` (50) or more | +3 each, up to +15 |
| All the postings on its site against about four weeks ago (once three weeks of history exist) | +5 when up a third, −5 when down a third |
| Hiring signals from the last `heat.days` (60) days | +5 each, up to +10 |
| Open roles posted 45 days ago or more | −1 each, down to −3 |
| Layoffs in your `layoffs.yml` | −5, or −8 when they mention India |

**Hot** is 20 points or more, **Warm** 10 to 19, **Cool** 1 to 9 and **Quiet** 0 or less. The **Companies** tab has a Heat column (the table is sorted by it) and a **Hiring heat** list of the hot and warm companies with what earned the points and the signals behind them. The **Roles** tab has **Where to put effort this week**: the five hottest, with your `rank` in `companies.yml` breaking near ties (up to 10 extra points for your favourite), each with a button to show its roles. The weekly message names them too.

Hiring signals come from three places:

- **News**, once a week (`heat.news`): a Google News search per company for hiring words (hiring, new office, GCC, expansion, funding, appoints, layoffs and so on) over the last seven days. Only headlines that name the company are kept, up to five each. The search is free and needs no key; `news:` in `companies.yml` sets the name searched for.
- **X**, once a week, with an `X_BEARER_TOKEN` secret (the action's `x-bearer-token`): posts from the recruiters in `heat.x_handles` that use hiring words, and posts naming your `heat.x_companies` (10) top-ranked companies with hiring words, since the last scan. X bills per post read, so `heat.x_max_posts` (40) is a cap on the cost, split between the two searches. A token that is refused or out of credits is named on the dashboard and the rest goes on.
- **Your own `signals.yml`**, read every run, for anything the others miss, such as a post you saw:

```yaml
signals:
  - company: Razorpay              # as named in companies.yml (any capitals)
    date: 2026-10-29
    note: a recruiter lists Razorpay as hiring
    link: https://x.com/…          # optional
    kind: hiring                   # optional: gcc, hiring, funding or leader (hiring when left out)
```

The news and posts go to the model in one small request a week, which keeps only real signals: a new GCC, tech centre or office; a hiring drive; funding; a senior technology leader joining; or job cuts. Product launches, partnerships, results and passing mentions are left out. Layoff news shows as a flag on the company for you to check and add to `layoffs.yml` if it is real; it doesn't change the heat by itself. When the request fails, the posts already read wait for the next run so they are not paid for twice.

`axia heat --dir <your folder>` (or **Axia preview** with `heat`) runs the weekly scan now and prints every company's heat with its signals. It writes nothing and sends nothing; with an X token it does read up to `heat.x_max_posts` posts.

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

## Tailored applications

Off unless you turn it on (`tailor: true`). Each role and each moonshot then gets a **Tailor for this role** button, with an optional note (what to stress, or a contact name). It saves to the same Cloudflare store as your calls.

Axia doesn't write resumes or cover letters. The button queues the role for a tool of your own: a script, or a scheduled AI task that reads your resume. Each run copies the requests into `data/tailor.json`, with what that tool needs:

- for a role: the posting text, and the score's summary, strengths, gaps and must-haves quoted from the posting;
- for a moonshot: its requirements, gaps, fit and closing date from `moonshots.json`.

When your tool finishes one, it records it in `tailored.json` next to `settings.yml`. Axia only reads that file, so the two never edit the same one:

```json
{ "greenhouse-acme-1": { "at": "2026-10-22T03:10:00Z", "folder": "Applications/Acme Bank/Solution Architect", "note": "cover letter names the hiring manager" } }
```

The next run marks the request done, and the role shows when it was made and where to find it. A request counts as done only when `at` is later than the click. **Tailor again** asks for a fresh version, and cancelling a fresh request goes back to the last version.

Tailored versions never feed back into scoring. Every score stays against your one resume, so nothing is re-scored.

### Start the tailoring at the click (optional)

Without more setup, a click waits for the next run. To start your tool at once, set `tailor.dispatch` to the repository that holds your tailoring workflow, and give the action a token that may start workflows there:

```yaml
# settings.yml
tailor: { enabled: true, dispatch: you/my-axia }
```

```yaml
# your workflow that runs Axia
- uses: khubli/axia@v1
  with:
    tailor-dispatch-token: ${{ secrets.AXIA_TAILOR_TOKEN }}   # fine-grained, Actions: read and write on that repository, nothing else
```

Deploy saves the token as a secret of your dashboard's Worker; it never reaches the page. It can start workflows but not change the repository's files. Each click (not a cancel) then starts `tailor.workflow` on `tailor.ref` (`workflow_dispatch`) with the string inputs `id`, `note` and `at`, so the workflow declares those three inputs. In that workflow, `npx axia tailor-request --dir <folder> --id <id> --note <note> --at <at> --out request.json` writes the one request as `data/tailor.json` would hold it, with the posting text (from what Axia saved, else one read of the role's board). Record the result in `tailored.json` as above. If the dispatch fails, the click is still saved and the next run queues it as usual.

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
| `AXIA_TAILOR_TOKEN` | secret | optional, with `tailor.dispatch`: lets a Tailor click start your tailoring workflow at once (passed as the action's `tailor-dispatch-token`) |
| `X_BEARER_TOKEN` | secret | optional, for hiring heat: reads recruiters' hiring posts on X once a week (passed as the action's `x-bearer-token`) |
| `NOTIFY_MIN_SCORE` | variable | message threshold, overrides `notify.min_score` |

## Files Axia writes

| File | Committed | What it is |
|---|---|---|
| `data/jobs.json` | yes | every matching role, open or recently closed, with its score and when you were told about it |
| `data/feedback.json` | yes | your calls from the dashboard, with each posting's text and its latest score, and the date of the last weekly review |
| `data/tailor.json` | yes | with `tailor` on: your Tailor requests, each with its posting or moonshot details, and whether your tool has done it |
| `dashboard/README.md` | yes | the plain list, readable on GitHub |
| `.axia/` | no | the built dashboard and its publish settings; `.axia/review/` holds what the last weekly review tried |
