# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** (Security tab → Advisories) on this repository, with steps to reproduce. You'll get a reply within a week.

## How Axia keeps your data private

- **Your data stays in your accounts.** Resume, criteria, company list, scores and run logs live in your own private repository. This repository holds only code.
- **The dashboard requires a login.** It is published to your Cloudflare account on your domain, with the `workers.dev` address and preview URLs switched off. After every publish Axia requests it as a stranger. Unless a Cloudflare Access login answers, it immediately replaces the page with one that holds no data and fails the run.
- **Your calls are written only through your login.** The dashboard's Applied / Shortlist / Not for me buttons save to a Workers KV store in your Cloudflare account, through the dashboard's own Worker on the same Access-protected address. The Worker also refuses requests that carry no Access token, writes from any other site, and anything malformed. Each run copies the calls, with the posting text, into your private repository.
- **The Tailor token can only start workflows.** With `tailor.dispatch` set, the token you give the action is saved as a secret of your dashboard's Worker and never reaches the page. Create it fine-grained, for the one repository that holds your tailoring workflow, with only Actions: read and write: it can start workflows there but not change your files.
- **The weekly review changes nothing by itself.** It proposes `criteria.md` edits as a pull request in your own repository, with the workflow's own token; you merge or close it.
- **Secrets are never printed.** Tokens reach the action as inputs from your repository's secrets; GitHub masks them in logs.
- **What leaves your accounts:** each scored posting, with your resume and criteria (and `levels.md`, plus that employer's lines from `pay.yml`, if you have them), goes to the AI provider you chose (Claude, OpenRouter or another OpenAI-compatible API). Messages go to your Telegram bot or your email. A Tailor click with `tailor.dispatch` set sends the role's id and your note to GitHub to start your workflow.
- **On your devices:** the installed app keeps the last results it loaded so it works offline. Remove the app or clear site data to delete them.

## Supported versions

Fixes go into the latest `v1` release.
