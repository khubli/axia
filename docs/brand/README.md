# Axia brand

One look everywhere Axia appears: the dashboard, the installed app, the Telegram bot, the repository.

## Mark

An **A** whose crossbar is a score meter: about two-thirds filled, the way a good match reads on the dashboard.

| File | Use |
|---|---|
| [`src/dashboard/icon.svg`](../../src/dashboard/icon.svg) | Master. Dashboard header, browser tab, README |
| `icon-32.png` | Browser tab fallback |
| `icon-180.png` | iPhone and iPad home screen (square; iOS rounds the corners) |
| `icon-192.png`, `icon-512.png` | Android and desktop app icon |
| `icon-maskable-512.png` | Android adaptive icon (mark inside the safe zone, full-bleed blue) |
| [`social-preview.png`](social-preview.png) | 1280×640 share image: GitHub social preview, khubli.in project card |

Keep the mark on its blue square; don't recolour or outline it.

## Colour

| Token | Light | Dark | Where |
|---|---|---|---|
| Brand blue | `#2346C8` | `#8FA5FF` (accent on dark) | the icon, links, primary buttons |
| Background | `#F3F5F8` | `#0E1117` | page, app status bar and splash (`theme-color`, manifest) |
| Ink | `#131821` | `#E6EAF0` | text |
| Good match | `#0F7A55` | `#3DB884` | scores at or above the good-match line |
| Worth a look | `#A35B00` | `#E3A548` | scores between the two lines |
| Lower | `#7B8494` | `#8A93A2` | scores below the "worth a look" line |

Score colours always come with a number and a label, never colour alone.

## Type

- **Schibsted Grotesk** 600–700: the wordmark and headlines.
- **Geist** 400–600: everything you read.
- **Geist Mono** 400–500: scores, dates, numbers that line up.

All three are served with the dashboard (SIL Open Font License), so it makes no third-party requests.

## Voice

Plain and specific, written to you: "1 new good match", "Example Bank unreadable for 3 days", "Newer results from 16 Oct, 07:50 IST". No hype, no exclamation marks. Messages start with **Axia ·** and the one thing that happened.

## Telegram bot

Make the bot look like the app: in Telegram, talk to **@BotFather**:

- `/setname` → **Axia**
- `/setuserpic` → send `src/dashboard/icon-512.png`
- `/setdescription` → *Messages from Axia: new good matches, problems, and a weekly check-in.*
