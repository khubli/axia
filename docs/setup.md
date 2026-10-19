# Set up Axia

About 30 minutes, once. You end up with:

- **this repository** (Axia's code), which you use but never change;
- **your own private repository** holding your resume, your companies and Axia's memory, with a workflow that runs Axia every morning;
- a private dashboard on your own domain, behind a Cloudflare login only you can pass;
- a Telegram message whenever a role first scores above your threshold, and a short weekly note that it is still running.

Why two repositories: your resume, your target companies and how every role scored against you are personal. They stay in a repository only you can see, and so do the run logs, which list role titles and scores. Axia's code holds nothing about you, so it can be public.

## What you need

| | Needed for | Cost |
|---|---|---|
| GitHub account | running everything (GitHub Actions) | free for a private repo at this volume |
| An AI model: a Claude Pro or Max subscription, an Anthropic API key, an OpenRouter key or another OpenAI-compatible API | AI scoring | your existing plan, or pay per use |
| Telegram | messages (email works too) | free |
| Cloudflare account with your domain on it | the hosted dashboard | free plan |

Without an AI model, Axia still works with title-and-keyword estimates. Without Cloudflare, the plain list in your repository's `dashboard/README.md` is still updated every day.

## 1. Create your private repository

1. On GitHub, create a new repository, for example `my-axia`, and set it to **Private**.
2. Copy everything in [`examples/instance/`](../examples/instance/) into it, including the hidden `.github/` and `.gitignore`. From a terminal:
   ```sh
   npx degit khubli/axia/examples/instance my-axia
   cd my-axia && git init && git add -A && git commit -m "Axia settings"
   git remote add origin https://github.com/<you>/my-axia.git && git push -u origin main
   ```
   Or download this repository as a ZIP and upload the files through GitHub's web page.

If you prefer to keep these files in a folder of an existing private repository, put them in a folder (say `axia/`) and set `config-dir: axia` in the workflow. Move `.github/workflows/axia.yml` to the repository's own `.github/workflows/`.

## 2. Describe yourself and your targets

Edit four files in your repository. [configuration.md](configuration.md) explains every setting.

- **`cv.md`**: your resume in Markdown. Everything the scorer knows about you comes from here and from `criteria.md`.
- **`criteria.md`**: what a good role looks like for you, in plain words. Spell out hard stops ("no pre-sales") and soft gaps ("missing a specific tool costs a few points"). This file does more for score quality than anything else.
- **`companies.yml`**: each company's name and careers page address. Open the company's careers site, click through to the job list, and copy that address. Axia reads Workday, Greenhouse, Lever, Ashby, SmartRecruiters and Oracle Recruiting Cloud boards, Amazon's and Google's careers sites, and SAP SuccessFactors and Eightfold sites ([details](configuration.md#companiesyml)); anything else is listed as "check by hand".
- **`settings.yml`**: the title words and places to keep, your time zone, and the dashboard address.

## 3. Choose the AI that scores roles

Pick one. Secrets go in your private repository: **Settings → Secrets and variables → Actions → New repository secret**. With `scoring.provider: auto` (the default) Axia uses whichever secret it finds.

**A. Your Claude Pro or Max subscription** (no API billing; what Axia was tuned with)

1. Install Claude Code on your computer and run `claude setup-token`. Sign in when asked. It prints a token valid for about a year.
2. Add it as the secret `CLAUDE_CODE_OAUTH_TOKEN`.

Put a reminder in your calendar for when the token expires. Until you replace it, AI scoring stops and Axia sends you a message saying so.

**B. An Anthropic API key** (billed per use): add it as the secret `ANTHROPIC_API_KEY`.

**C. Any model on OpenRouter** (Claude, GPT, Gemini, Llama, Mistral…; billed per use by OpenRouter, some models are free)

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys) and add it as the secret `OPENROUTER_API_KEY`.
2. In `settings.yml`, set the model to an id from [openrouter.ai/models](https://openrouter.ai/models):
   ```yaml
   scoring:
     provider: openrouter
     model: provider/model-name     # copy the id from the model's page
   ```
3. Pass the secret to the action in `.github/workflows/axia.yml`: `openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}` (already there in the starter workflow).

**D. Any other OpenAI-compatible API** (OpenAI, Groq, Together, a self-hosted model): set `scoring.provider: openai-compatible`, `scoring.base_url` (for example `https://api.openai.com/v1`) and `scoring.model`, and add the key as `LLM_API_KEY`. A model on your own computer (Ollama, LM Studio) works when you run Axia on that computer or on a self-hosted runner; GitHub's runners can't reach your laptop.

Scores differ between models. When you switch, run `axia calibrate` (below) on roles you have judged, and adjust `criteria.md` until it agrees with you.

## 4. Get messages on Telegram

1. In Telegram, talk to **@BotFather**, send `/newbot` and follow the steps. It gives you a bot token.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<token>/getUpdates` in a browser. Your chat id is the number after `"chat":{"id":`.
3. Add the secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
4. Optional, so messages come from "Axia" with its icon: with @BotFather, `/setname` Axia and `/setuserpic` with [`src/dashboard/icon-512.png`](../src/dashboard/icon-512.png).

Email works as well or instead: add `SMTP_USER` (for example a Gmail address), `SMTP_PASSWORD` (a Gmail [app password](https://myaccount.google.com/apppasswords)) and optionally `EMAIL_TO`.

What you will receive, at most one message per run:

- **New good matches:** when a role's first AI score reaches your threshold (65 unless you change it). Each role is sent once, ever.
- **Problems:** a company whose site could not be read for 3 days running, or AI scoring failing on two runs in a row. Once per problem.
- **Weekly check-in:** every Monday, a few lines saying Axia is running, with the week's numbers; silent when it is the only news. Change the day or turn it off with `notify.weekly` in `settings.yml`.
- **Broken run:** if a run fails, a message with the reason and a link to the log.

To change the threshold without editing files: **Settings → Secrets and variables → Actions → Variables → New repository variable**, name `NOTIFY_MIN_SCORE`, value for example `70`.

## 5. Publish the dashboard, privately

The dashboard shows your scores and gaps, so it must never be public. Set up the login **before** the first publish.

**a. Protect the address first.** In the Cloudflare dashboard open **Zero Trust → Access → Applications → Add an application → Self-hosted**.

- Application domain: the address you want, for example `jobs.example.com` (a subdomain of a domain already on your Cloudflare account).
- Session duration: 1 month is comfortable on a phone.
- Policy: action **Allow**, include **Emails**: your email address.
- Login method: the default one-time PIN by email is enough.

**b. Let GitHub publish.** In Cloudflare, **My Profile → API Tokens → Create Token**, use the **Edit Cloudflare Workers** template, limit *Account resources* to your account and *Zone resources* to your domain, and create it. In your private repository add the secrets `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the right of **Workers & Pages → Overview**). The template also lets Axia create the small Workers KV store where the dashboard's Applied / Shortlist / Not for me buttons save your calls; if you build the token by hand, include **Account → Workers KV Storage → Edit**.

**c. Tell Axia the address.** In `settings.yml`:

```yaml
dashboard:
  domain: jobs.example.com
  worker: axia
```

After each run Axia publishes the dashboard and then opens it as a stranger would. If it does not get a Cloudflare login page, it replaces the dashboard straight away with a page that holds no data, and the run fails with a message telling you what to fix. Your data is never left on a public page.

**Install it as an app.** On iPhone or iPad: open the address in Safari, Share → Add to Home Screen. On Android or a computer: **Install app** at the top of the dashboard (or Install in the browser menu). The app opens straight to your results, works offline with the last results it loaded, and offers a refresh when newer ones are published.

## 6. Run it

In your private repository, open **Actions → Axia → Run workflow**. The first run reads every company and scores up to 40 roles; the rest are scored over the next days. After that it runs every morning on its own (change the time in `.github/workflows/axia.yml`).

To re-score everything after changing your resume a lot, run the workflow with **Re-score** ticked. Changes to `cv.md` or `criteria.md` are picked up automatically, 40 roles a day.

**Let the weekly review propose changes.** Mark roles on the dashboard (Applied, Shortlist or Not for me, with a one-line reason if you like). Once a week Axia checks its scores against your calls and, when a change to `criteria.md` agrees with them more often, opens a pull request in your repository. To allow that: in your private repository, **Settings → Actions → General → Workflow permissions**, tick **Allow GitHub Actions to create and approve pull requests**, and keep `pull-requests: write` in the workflow's `permissions` (the example has it). Without it, the change is left on a branch and the message links to it. To run a review straight away: **Run workflow** with **Review** ticked.

## Keeping Axia up to date

The workflow uses `khubli/axia@v1`: you get fixes and improvements within version 1, never a breaking change. To stay on an exact release, use for example `@v1.0.0` instead.

If you keep your own copy of Axia in a **private** repository, allow your other repositories to use it: in that copy, **Settings → Actions → General → Access → Accessible from repositories owned by you**, and point `uses:` at your copy.

## Running it on your computer

Useful to try settings before committing them, or to check the scorer against roles you have judged.

```sh
git clone https://github.com/khubli/axia && cd axia && npm ci
node src/cli.mjs run --dir ../my-axia --dry-run            # read and filter only; writes and sends nothing
AXIA_SCORER=claude-code node src/cli.mjs calibrate --dir ../my-axia   # uses your logged-in Claude Code
```

`calibrate` scores the roles you have judged (your `calibration/roles.yml`, and your calls on the dashboard saved in `data/feedback.json`) and shows where the model disagrees with your own Apply/Skip verdicts. Run it after editing `criteria.md`. `node src/cli.mjs review --dir ../my-axia --now` runs the weekly review and writes what it would propose to `.axia/review/`.

## Responsible use

Axia reads the same public job feeds that each company's careers page loads in your browser, once a day, with a clear user agent. It does not log in anywhere, does not read LinkedIn, and does not apply to anything. Keep the company list to the employers you actually want, and check that a site's terms allow automated reading before you add it.
