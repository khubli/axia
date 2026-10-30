# Changelog

## 1.28.0

- **Your to-do list, ticked off on the Insights tab.** Keep the things you mean to do for your search (a resume rewrite, a certification, people to write to) in a short `todo.yml` beside your settings, each with an optional group, priority (now, next or later), details and link. The **Insights** tab lists them by priority above the theme counts, so the gaps and what you are doing about them sit together. Tick an item when it is done, and tap it to read its details and add a short note (240 characters) such as "booked for 12 Nov". Ticks and notes save to the same Cloudflare store as your calls on roles, so they show on every device at once, and each run copies them into `data/todo.json` so they last. Done items fold into a **Done** group, newest first. No file, no list; `todo: false` turns it off. It costs no AI requests ([details](docs/configuration.md#your-to-do-list-and-todoyml)).

## 1.27.0

- **An Insights tab: what the roles ask for.** A new **Insights** tab shows, across every role Axia has scored, which themes the postings ask for (public cloud, payments, people leadership, Java, AI and about 20 more) and how often your resume shows each, as one bar per theme: green where your resume shows it, red where it doesn't. A line on top names your biggest gap and your strongest theme. Switch between your best-fit roles (`report.show_from`+) and all scored roles, and tap a theme to see the open roles that ask for it. Below that: the cities where your best-fit roles are, and how fast those roles close. It is counted from the must-haves each score already quotes, so it costs no AI requests and never changes a score. Change the themes, or the words that mark them, in `settings.yml` (`insights.themes`); `insights: false` hides the tab. A weekly snapshot of the shares is kept for trends in a later version. `axia insights` prints the counts ([details](docs/configuration.md#insights-what-the-roles-ask-for)).

- **"What keeps coming up" moved to the Insights tab**, beside the theme counts, so everything about your gaps is in one place. It works as before.

## 1.26.0

- **Rejected or Turned down, with a reason.** When you hear back on an application, open the role and set its **Outcome**: **Rejected** (the company said no) or **Turned down** (you said no), with a reason from your list, and if you like the stage it happened at and a note. A role you never marked Applied can be marked Rejected or Turned down straight away, which marks it Applied too. The **Your roles** tab shows Rejected and Turned down as their own groups under a running tally of the reasons. The reasons and stages are yours to change in `settings.yml` (`outcomes`). Outcomes are saved with the Applied call and kept in `data/feedback.json`, so they last after the posting closes. They cost no AI requests and never change a score ([details](docs/configuration.md#your-calls-on-the-dashboard)).

## 1.25.0

- **Workday filters carry over from the address.** Pick a filter on a Workday career site, such as a location, and copy the address: `https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One?locations=…` now reads only the roles that filter shows (search words in `q=` carry over too). Large sites that list most roles as "N Locations", such as Capital One's (about 2,000 roles, 1,360 of them US roles listed that way), no longer need every such posting opened and its title judged just to find the 19 in Bengaluru. Addresses without filters are read as before ([details](docs/configuration.md#companiesyml)).

## 1.24.0

- **Hiring heat: where to put extra effort.** Every company now gets a heat level (Hot, Warm, Cool or Quiet) from points Axia works out each run at no AI cost: new senior roles in your places in the last 14 days, open roles scoring 50+, the four-week trend in all its postings, hiring signals, less roles open 45+ days and layoffs in your `layoffs.yml`. Once a week, a free Google News search per company and, with an `X_BEARER_TOKEN`, recruiters' hiring posts on X (`heat.x_handles`, at most `heat.x_max_posts` a week) go to the model in one small request, which keeps only real hiring signals: a new GCC or office, a hiring drive, funding or a senior tech leader joining. You can add your own in `signals.yml`. The **Companies** tab gets a Heat column and a **Hiring heat** list with the reasons and links; the **Roles** tab gets **Where to put effort this week**, the five hottest with your `rank` in `companies.yml` breaking near ties; the weekly message names them. Heat never changes a score. `axia heat` previews it without writing anything ([details](docs/configuration.md#hiring-heat-and-signalsyml)).

## 1.23.0

- **Radancy (TalentBrew) career sites.** Employers whose careers site runs on Radancy, such as Charles Schwab's (`www.schwabjobs.com`), can now be read with `platform: radancy`. Open the site, search for the place you want (for example India), and copy that search page's address: the same search is read from the site's own results list, 100 roles a request (Schwab's 69 India roles take one). A posting's text and date are read from its own page only when the role is about to be scored ([details](docs/configuration.md#companiesyml)).

## 1.22.0

- **RippleHire career sites.** Employers whose careers site runs on RippleHire, such as Axis Bank's (`axisbank.ripplehire.com`), can now be read; the address is recognised on its own. Use the address the employer's careers page links to, which carries the site's token: `https://<company>.ripplehire.com/candidate/?token=…&source=CAREERSITE`. The whole list is read a thousand roles at a time (Axis Bank's 10,300 take 11 requests), and your `locations` keep the places you want. A posting's text and date are read from its own page only when the role is about to be scored ([details](docs/configuration.md#companiesyml)).

- **Oracle sites with more than 10,000 postings are read in full.** Oracle's job list stops at 10,000, so on a site listing more (Kotak Mahindra Bank lists about 11,600) the oldest postings were missed and could look closed. Such a site now also has its older postings read by posting date, in date ranges small enough for the list. Sites under 10,000 are read as before.

## 1.21.0

- **A label for recent layoffs.** Add a line to a new, optional `layoffs.yml` when you read that one of your companies is cutting jobs (company, date, India or elsewhere, size, link), and a **Layoffs** label shows on the company on the **Companies** tab and on each of its roles, with the details and the link in the role's details. Cuts in India are shown more strongly than cuts elsewhere. Each line drops off by itself 6 months after it was announced (`layoffs.months`). The label never changes a score or hides a role, and Axia does not search the news, so it costs no AI requests ([details](docs/configuration.md#recent-layoffs-and-layoffsyml)).

## 1.20.0

- **Talentsoft career sites.** Employers whose careers site runs on Talentsoft (Cegid), such as Crédit Agricole CIB's `jobs.ca-cib.com`, can now be read: add `platform: talentsoft` (sites on `<company>.talent-soft.com` are recognised on their own). Every role comes from the site's RSS feed with its full description, in one request. Copy the job list's address after picking a country in its filters (`?facet_JobCountry=96` is India) and only that country's roles are read. The reference number at the start of each title is left off ([details](docs/configuration.md#companiesyml)).

- **Groupe BPCE career sites.** `recrutement.natixis.com` (Natixis CIB) and `recrutement.bpce.fr` are recognised from the address and read through the search their own pages use, each role with its description. The site's filters carry over: `?tax_place=inde` reads only the roles in India. Some roles are posted only in French.

## 1.19.0

- **Avature career sites.** Employers whose careers site is on Avature (`<company>.avature.net/<portal>`, such as Bloomberg's `https://bloomberg.avature.net/careers`) can now be read; the address is recognised on its own. These sites have no public feed, so Axia reads their search pages, at the page size the site gives (Bloomberg's 336 roles take 28 small requests), and your `locations` keep the places you want. A posting's text is read from its page only when the role is about to be scored. The pages give no posting date ([details](docs/configuration.md#companiesyml)).

## 1.18.0

- **Edit your criteria without re-scoring everything.** A new `scoring.rescore_on_edit` in `settings.yml` says what an edit to `criteria.md` or your resume re-scores. `all` (the default) re-scores every open role, as before. `none` re-scores nothing: roles already scored keep their score, the second look keeps the title verdicts it already gave, and only roles scored from the next run on use the edit. A score such as `50` re-scores open roles scoring that much or more, and roles you marked Applied or Shortlist. The weekly review's pull request says which of these merging it will do. Ticking **Re-score** on the workflow still scores everything again ([details](docs/configuration.md#criteriamd)).

## 1.17.0

- **More AI scores for one run.** The action has a new `max-ai-scores` input, and the starter workflow puts it on the **Run workflow** form: type 100 to work through a long queue faster, and that run scores up to 100 roles. Every other run keeps `max_ai_scores_per_run` from `settings.yml`, and nothing in your repository changes. Left empty, it does nothing. On a Claude subscription, a few hundred scores in a row can reach the plan's usage limit; roles scored before that are kept. The same cap is `--max-ai N` on the command line, and a value that isn't a whole number stops the run before anything is read ([details](docs/setup.md#6-run-it)).

- **A preview button in the starter repository.** `examples/instance/.github/workflows/axia-preview.yml` adds **Actions → Axia preview → Run workflow**. It runs `second-look`, `calibrate` or `gaps` against your settings with any version of Axia, and the result goes in the run's log. It writes nothing, publishes nothing and sends no messages. Copy the file into your repository to get it.

## 1.16.0

- **Phenom career sites.** Employers whose careers site runs on Phenom (`careers.<company>.com/global/en/search-results`) can now be read: add `platform: phenom` to the company in `companies.yml`. Roles come from the same public search the site's own pages use, 100 a request, with each posting's full text for scoring; `?country=India` on the address reads only that country's roles. Requisition codes on the end of titles (`Technical Architect_3313`) are left off ([details](docs/configuration.md#companiesyml)).

- **iCIMS (Jibe) career sites.** Employers whose iCIMS careers site runs on Jibe (such as careers.axa.com and jobs.aon.com) can now be read: add `platform: jibe`. Roles come from the site's own `/api/jobs` list, 100 a request, each with its full description, so no posting is read separately. `?location=India` on the address carries over as the site's own filter ([details](docs/configuration.md#companiesyml)).

- **D. E. Shaw.** `https://www.deshawindia.com/careers` (D. E. Shaw India: Hyderabad, Bengaluru, Gurugram) and `https://www.deshaw.com/careers` are read from the role data inside the careers page, in one request with every description. Open applications ("All positions in …") are left out. The page gives no posting dates.

## 1.15.0

- **Shortlist a waiting role to score it next.** Tap Shortlist on a role still waiting for an AI score and the next run scores it first, within the usual `max_ai_scores_per_run`. Useful when you spot a role on a careers site that sits far back in a long queue.

- **Editing settings.yml re-ranks the waiting queue.** The title estimate that orders the queue was fixed the night a role was first seen, so adding a title term never moved roles already waiting. It is now worked out again on each run from your current settings (never lower than the estimate already saved).

## 1.14.0

- **Tailor for this role (optional, off by default).** With `tailor: true` in `settings.yml`, each role and each moonshot gets a **Tailor for this role** button, with an optional note. Axia doesn't write resumes. It queues the request for a tool of your own. Each run copies requests into `data/tailor.json`: for a role, the posting text and the score's must-haves quoted from the posting; for a moonshot, its requirements and gaps. When your tool records a request in `tailored.json`, the role shows when the tailored version was made and where to find it. **Tailor again** asks for a fresh one. Tailored versions never feed back into scoring, so every score stays against your one resume ([details](docs/configuration.md#tailored-applications)). The demo shows one done and one waiting.

- **Start the tailoring at the click (optional).** With `tailor.dispatch: owner/repo` and the action's new `tailor-dispatch-token` input, a click also starts that repository's workflow at once (`workflow_dispatch` of `tailor.yml` with inputs `id`, `note`, `at`; the token needs only Actions: read and write), instead of waiting for the next run. The new `axia tailor-request` command gives that workflow the one request with its posting text ([details](docs/configuration.md#start-the-tailoring-at-the-click-optional)).

## 1.13.0

- **The score chart keeps one height.** "Where your AI scores fall" used one dot per role stacked by score, so a few hundred low scores made columns taller than a phone screen. It now stays about the same height at any number of roles. Lower scores are bars showing how many roles scored each value (tap or hover one for the count). Worth a look and Good match keep one dot per role, tappable as before, and sit side by side within their band instead of in one tall column. Those two bands get two thirds of the width, so their dots have room, and the axis still marks 0, 50, 65 and 100.

## 1.12.0

- **Bad pay estimates show no pay.** An AI estimate the model marks "placeholder", or one whose yearly top is below a new optional `estimate_floor` in `pay.yml` (such as ₹5–8 lakh for a VP, a zero dropped), now shows no pay instead of a misleading range. Pay already saved is checked on each run with no AI request, and adding the floor doesn't refill pay on any role. Pay stated on a posting or taken from your table is never second-guessed ([details](docs/configuration.md#pay-range-per-role-and-payyml)).

## 1.11.0

- **Pay range per role.** Each AI score now also gives the role's likely pay as a range, shown under the role (₹58–87L) and in its details with where it came from: stated on the posting (in the posting's own words, checked against it), from your pay table, or a rough AI estimate (marked ~). It is part of the same request as the score, so a night's scoring sends no extra requests, only a few dozen more output tokens per role, and the score never depends on pay.

- **Your pay table, `pay.yml` (optional).** Pay figures you know of, by employer, job family and level. Each role's request carries only its own employer's lines, and the model picks the level that fits the role. Axia never fetches pay data from any site ([details](docs/configuration.md#pay-range-per-role-and-payyml)).

- Roles on the dashboard scored before this version get their pay range from the catch-up (1.10.0), in the same short request as the level when both are missing. Changing `pay.yml` refills it the same way. Nothing is re-scored.

## 1.10.0

- **Step up, same level or step down.** Each AI score now labels the role against your current level, with its equivalent on your own ladder ("≈ Executive Director at your bank"). Titles mislead across employers, so the model goes by an optional `levels.md` (your level and what it is called at the companies you watch) and by the scope the posting describes, not by the title alone. The label sits under the score, appears in the role's details and in new-match messages, and the Roles tab can filter by it. It is asked in the same request as the score, so it adds a few words of answer per role; it never changes the score ([details](docs/configuration.md#levelsmd-step-up-same-level-or-step-down)).

- **Catch-up for roles already scored.** Roles scored before this version, or before `levels.md` last changed, get their label from a short level-only request, up to 40 a run, and only for roles on the dashboard or marked Applied or Shortlist. Nothing is re-scored.

## 1.9.0

- **What changed in the last run.** A brief at the top of the Roles tab says in one line what the last run changed, for example "8 new roles and 2 closed. Scored 3 roles for the first time: 1 good match and 1 worth a look. 1 good match sent to you. Litware Insurance is readable again. 8 still waiting for a score, about 1 night at 40 a night." Show opens what is behind it: the roles scored for the first time that reached Worth a look (50 by default) or better, best first, scores that moved 10 or more points or into another band on a re-score, new roles by company, closed roles worth noting (scored Worth a look or better, or marked by you), roles listed again, job sites that broke or came back, and a table of the last 14 runs. It is worked out by comparing memory before and after the run and written from a template, so it adds no AI request and no tokens. The brief is kept with the run in `data/jobs.json` (`lastRun.changes`, plus a 14-line `history`), and the same line heads `dashboard/README.md`.

## 1.8.2

- **The model reads up to 15,000 characters of each posting, not 7,000.** Scoring several roles per request (Claude Code, OpenRouter and other OpenAI-compatible APIs) cut each posting at 7,000 characters. On one night's 40 scored roles that cut 10 postings, and two of them lost their whole skills and qualifications section. None of those 40 passed 15,000, so postings now reach the model whole, as they already did on the Claude API. A night's scoring sends about 14% more text. Roles already scored keep their score until they are next scored.

## 1.8.1

- **Labels under the score.** New, Long open, Second look and Not for me now sit under a role's score instead of after its title, so a long title can no longer push them out of sight. The Closed label on Your roles moved there too, with its date beside "marked".

- **Applied and Shortlist roles move to Your roles.** Once you mark a role Applied or Shortlist it leaves the Roles list, the way Not for me does, so the list holds only roles you haven't decided on. It stays in view until the list next redraws, and comes straight back if you clear the call. A link or chart dot for a marked role opens it on Your roles.

## 1.8.0

- **TurboHire career sites** (`<company>.turbohire.co`), which many Indian startups and fintechs use, such as Navi: `https://navi.turbohire.co/dashboardv2`. Every open role comes in one answer with its description, so no posting reads are needed. An address that names no TurboHire company is reported as an error, never as "no roles".

## 1.7.0

- **Amazon and Google.** Their own careers sites are read directly: `https://www.amazon.jobs/en/search?country=IND` and `https://www.google.com/about/careers/applications/jobs/results?location=India`. The search's filters on the address carry over, so a company with tens of thousands of roles is read for the country you want. Both come with each role's description, so no posting reads are needed.

- **Eightfold career sites**, such as `paypal.eightfold.ai` or an employer's own `portal.careers.<company>.com` (add `platform: eightfold` to that one). `?location=India` narrows the search. Both of Eightfold's APIs are supported ([details](docs/configuration.md#companiesyml)).

## 1.6.1

- **Long open, sooner.** A role posted 45 or more days ago now gets the Long open label (it was 180 days), and its details say it may already be filled, so check before putting time into it. Roles are still never hidden for their age: a role stays while its employer lists it, and senior roles often take two or three months to fill.

## 1.6.0

- **SAP SuccessFactors career sites.** Many banks and consultancies run their careers site on SuccessFactors under their own domain, so the address alone can't say how to read it. Add `platform: successfactors` to the company in `companies.yml` and give the address of the site's search page. `?locationsearch=India` on that address reads only the roles the site places in India, which keeps an employer with thousands of roles to a few dozen requests. Newer sites are read through their JSON search API, older ones from their search pages; a page without a job list is reported as an error, never as "no roles" ([details](docs/configuration.md#companiesyml)).

- **Oracle sites in the EU** (`*.oraclecloud.eu`) are read like the others, and an Oracle site is read up to 10,000 roles instead of 5,000.

## 1.5.0

- **What the posting requires.** Each AI score now lists up to four things the posting itself requires, in its own words, and whether your resume shows each: yes, partly or no. A requirement is kept only when its quote is really in the posting, so one the model made up never reaches the dashboard. The score itself is judged as before; roles get the list when they are next scored.

- **Gaps that keep coming up.** Once a week, when they have changed, the gaps and unmet requirements of your open roles scored 55 to 89 are grouped into a few themes, each with the roles behind it, shown at the top of the Roles tab and as one line in the weekly message. For each theme, add the evidence to your resume if you have it, or accept the gap in `criteria.md`; Axia changes neither. One small model request a week. Set the band with `gaps.min_score` and `gaps.max_score`; `gaps: false` turns it off ([details](docs/configuration.md#what-the-posting-requires-and-gaps-that-keep-coming-up)).

- **A Save button for your reason.** The one-line reason under Your call now has a Save button, and says "Not saved yet" while you type. Enter and leaving the box still save it too.

## 1.4.0

- **Your roles.** A new dashboard tab lists the roles you marked Applied or Shortlist, open or closed, with your one-line reason and the day you marked each. A role used to vanish from the dashboard as soon as the employer took the posting down, often right after you applied; now it stays on this tab with a Closed label, its score and reasons, and the buttons to change your call. Roles Axia has already forgotten (closed more than 45 days ago) are rebuilt from `data/feedback.json`. The tab appears with your first call. "Closed this week" now counts only roles closed in the last week.

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
