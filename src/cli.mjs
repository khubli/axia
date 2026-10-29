#!/usr/bin/env node
// axia <command> [--dir <folder with settings.yml>] [options]
//
//   run        read the boards, score, message you, write memory + dashboard   (--dry-run, --no-notify, --rescore, --company X, --max-ai N)
//   deploy     publish the dashboard to Cloudflare and check that it asks for a login
//   calibrate  score the roles in calibration/roles.yml and compare with your own verdicts
//   second-look  show which titles your title words reject today that the second look would let through (writes nothing)
//   gaps       group the gaps of your open roles scored 55 to 89 into themes now, and print them (writes nothing)
//   heat       run the weekly hiring-news (and X) scan now and print each company's hiring heat (writes nothing)
//   review     on review.day: check the scores against your dashboard calls; propose a criteria.md change   (--now)
//   tailor-request  one Tailor request as JSON, with the posting text, for a tailoring job   (--id ID, --note TEXT, --out FILE)
//   alert      tell you a run broke (used by the GitHub Action)                (--link URL)

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadSettings } from './config.mjs';

const HELP = `Usage: axia <run|deploy|calibrate|second-look|gaps|heat|review|tailor-request|alert> [--dir <folder>] [options]
Docs: https://github.com/khubli/axia#readme`;

/** Pull --dir out of the arguments; everything else goes to the command. */
export function splitDir(argv) {
  const rest = [];
  let dir = '.';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i] ?? '.';
    else if (argv[i].startsWith('--dir=')) dir = argv[i].slice(6);
    else rest.push(argv[i]);
  }
  return { dir: resolve(dir), rest };
}

const errorFile = (dir) => join(dir, '.axia', 'last-error.txt');

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  const { dir, rest } = splitDir(args);
  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return 0;
  }
  if (command !== 'alert') rmSync(errorFile(dir), { force: true });
  try {
    switch (command) {
      case 'run': {
        const { run } = await import('./run.mjs');
        const out = await run(rest, env, { dir });
        if (out.reason) throw new Error(out.reason);
        return out.exitCode;
      }
      case 'second-look': {
        const { run } = await import('./run.mjs');
        const out = await run(['--second-look-preview', ...rest], env, { dir });
        if (out.reason) throw new Error(out.reason);
        return out.exitCode;
      }
      case 'gaps': {
        const { previewGaps } = await import('./gaps.mjs');
        await previewGaps({ dir, env });
        return 0;
      }
      case 'heat': {
        const { previewHeat } = await import('./heat.mjs');
        await previewHeat({ dir, env });
        return 0;
      }
      case 'deploy': {
        const { deploy } = await import('./deploy.mjs');
        await deploy({ dir, env, settings: loadSettings(dir) });
        return 0;
      }
      case 'calibrate': {
        const { calibrate } = await import('./calibrate.mjs');
        await calibrate({ dir, env });
        return 0;
      }
      case 'review': {
        const { review } = await import('./review.mjs');
        await review(rest, env, { dir });
        return 0;
      }
      case 'tailor-request': {
        const { values } = parseArgs({ args: rest, options: { id: { type: 'string' }, note: { type: 'string', default: '' }, at: { type: 'string' }, out: { type: 'string' } } });
        if (!values.id) throw new ConfigError('tailor-request needs --id <role id>');
        const settings = loadSettings(dir);
        const { loadCompanies } = await import('./config.mjs');
        const { loadState } = await import('./state.mjs');
        const { loadFeedback } = await import('./feedback.mjs');
        const { loadMoonshots } = await import('./moonshots.mjs');
        const { loadTailor, tailorRequest } = await import('./tailor.mjs');
        const { isoDate } = await import('./text.mjs');
        const http = await import('./http.mjs');
        const quiet = () => {};
        const req = await tailorRequest({
          dir, id: values.id, note: values.note, at: values.at || new Date().toISOString(), settings,
          companies: loadCompanies(dir), state: loadState(resolve(dir, 'data/jobs.json')),
          moonshots: loadMoonshots(dir, settings, { log: quiet })?.report?.roles ?? [],
          feedback: loadFeedback(dir), tailor: loadTailor(dir), http, today: isoDate(new Date(), settings.report.timezone),
        });
        const json = JSON.stringify(req, null, 1) + '\n';
        if (values.out) writeFileSync(values.out, json);
        else process.stdout.write(json);
        return 0;
      }
      case 'alert': {
        const { values } = parseArgs({ args: rest, options: { link: { type: 'string', default: '' } } });
        const { sendAlert } = await import('./notify.mjs');
        const reason = existsSync(errorFile(dir)) ? readFileSync(errorFile(dir), 'utf8').trim() : '';
        await sendAlert({ title: "today's run failed", detail: reason, link: values.link }, env);
        return 0;
      }
      default:
        console.error(`Unknown command "${command}".\n${HELP}`);
        return 2;
    }
  } catch (err) {
    const message = err instanceof ConfigError ? `Configuration problem: ${err.message}` : err.message;
    console.error(err instanceof ConfigError ? message : err);
    try {
      mkdirSync(join(dir, '.axia'), { recursive: true });
      writeFileSync(errorFile(dir), message.slice(0, 600));
    } catch {}
    return err instanceof ConfigError ? 2 : 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/axia')) {
  main().then((code) => process.exit(code));
}
