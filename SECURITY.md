# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** (Security tab → Advisories) on this repository, with steps to reproduce. You'll get a reply within a week.

## How Axia keeps your data private

- **Your data stays in your accounts.** Resume, criteria, company list, scores and run logs live in your own private repository. This repository holds only code.
- **The dashboard requires a login.** It is published to your Cloudflare account on your domain, with the `workers.dev` address and preview URLs switched off. After every publish Axia requests it as a stranger. Unless a Cloudflare Access login answers, it immediately replaces the page with one that holds no data and fails the run.
- **Secrets are never printed.** Tokens reach the action as inputs from your repository's secrets; GitHub masks them in logs.
- **What leaves your accounts:** each scored posting, with your resume and criteria, goes to the AI provider you chose (Claude, OpenRouter or another OpenAI-compatible API). Messages go to your Telegram bot or your email.
- **On your devices:** the installed app keeps the last results it loaded so it works offline. Remove the app or clear site data to delete them.

## Supported versions

Fixes go into the latest `v1` release.
