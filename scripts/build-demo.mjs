#!/usr/bin/env node
// Builds the public demo dashboard from made-up data: fictional companies,
// fictional roles, a fictional candidate. Nothing here comes from a real run.
//   node scripts/build-demo.mjs <out-dir>

import { resolve } from 'node:path';
import { buildSite } from '../src/site.mjs';
import { isoDate } from '../src/text.mjs';
import { normalizeMoonshots } from '../src/moonshots.mjs';
import { briefLine } from '../src/changes.mjs';

const out = resolve(process.argv[2] ?? '_site');
const TZ = 'Europe/London';
const now = new Date();
const today = isoDate(now, TZ);

// Deterministic "randomness", so the demo looks the same on every build.
let seed = 20261015;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (list) => list[Math.floor(rand() * list.length)];
const daysAgo = (n) => isoDate(new Date(now.getTime() - n * 864e5), TZ);

const COMPANIES = [
  { name: 'Woodgrove Bank', url: 'https://woodgrove.wd3.myworkdayjobs.com/Careers', source: 'workday', listed: 1240 },
  { name: 'Contoso Pay', url: 'https://job-boards.greenhouse.io/contosopay', source: 'greenhouse', listed: 312 },
  { name: 'Fabrikam Capital', url: 'https://jobs.smartrecruiters.com/FabrikamCapital', source: 'smartrecruiters', listed: 488 },
  { name: 'Northwind Fintech', url: 'https://jobs.lever.co/northwind', source: 'lever', listed: 96 },
  { name: 'Tailspin Wealth', url: 'https://jobs.ashbyhq.com/tailspin', source: 'ashby', listed: 74 },
  { name: 'Litware Insurance', url: 'https://litware.wd5.myworkdayjobs.com/External', source: 'workday', listed: 655 },
  { name: 'Proseware Payments', url: 'https://job-boards.greenhouse.io/proseware', source: 'greenhouse', listed: 141 },
  { name: 'Adventure Works Bank', url: 'https://abcd.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1', source: 'oracle', listed: 402 },
  { name: 'Alpine Exchange', url: 'https://careers.example.com/alpine', source: null, listed: 0 },
];
const CITIES = ['London, United Kingdom', 'Manchester, United Kingdom', 'Edinburgh, United Kingdom', 'Dublin, Ireland', 'Amsterdam, Netherlands', 'Remote, United Kingdom', 'London, United Kingdom; Manchester, United Kingdom'];

// The fictional candidate: a platform engineering leader in payments.
const SCORED = [
  [86, 'Woodgrove Bank', 'Head of Payments Platform Engineering', 'A payments platform leadership role at the level you work at now, with a clear modernisation mandate.', ['Led a payments platform team of similar size', 'ISO 20022 and real-time payments depth', 'Design authority experience'], ['Expects card-scheme certification experience']],
  [81, 'Contoso Pay', 'Principal Architect, Real-Time Payments', 'Architecture ownership for instant payments, close to the work you have done on account-to-account rails.', ['Real-time payments architecture', 'Integration and event-driven design', 'Regulatory delivery'], ['Kafka at very high volume is named; yours is moderate']],
  [74, 'Northwind Fintech', 'Engineering Director, Core Platform', 'Director-level platform role at a growing fintech; the scope fits, the company is smaller than you are used to.', ['Platform ownership and roadmap', 'Leading managers of teams'], ['Startup pace and hands-on expectations', 'Equity-heavy compensation']],
  [68, 'Proseware Payments', 'Lead Solution Architect, ISO 20022 Migration', 'A focused migration role where your ISO 20022 work is the core requirement.', ['ISO 20022 migration end to end', 'Vendor and stakeholder management'], ['Narrower than your current scope', 'Contract-to-permanent']],
  [62, 'Fabrikam Capital', 'Platform Product Lead, Payments APIs', 'A technical product role on the payments API platform; product ownership rather than engineering leadership.', ['API platform depth', 'Works closely with engineering'], ['Formal product management experience is expected']],
  [58, 'Woodgrove Bank', 'Senior Engineering Manager, Card Issuing', 'Engineering management in card issuing; the level fits but card processing is a soft gap.', ['Team leadership', 'Regulated delivery'], ['No card issuing processor experience', 'One level below your current scope']],
  [56, 'Litware Insurance', 'Enterprise Architect, Finance Systems', 'Enterprise architecture in insurance finance systems; transferable governance, outside payments.', ['Architecture governance', 'Target-state roadmaps'], ['Insurance domain is new to you', 'General ledger depth expected']],
  [54, 'Tailspin Wealth', 'Delivery Lead, Open Banking', 'Delivery leadership for open banking integrations in wealth management.', ['Open banking APIs', 'Delivery leadership'], ['Agile coaching emphasis', 'Smaller team than you lead today']],
  [52, 'Adventure Works Bank', 'Engineering Manager, Fraud Platform', 'Fraud platform engineering management; good level fit, but fraud analytics is the core.', ['Platform leadership'], ['Fraud models and data science are central']],
  [51, 'Contoso Pay', 'Staff Engineer, Settlement Services', 'A senior individual-contributor role in settlement; strong domain fit, less leadership scope.', ['Settlement and reconciliation knowledge'], ['Hands-on Go development every day']],
  [47, 'Litware Insurance', 'Platform Architect, Cloud Landing Zones', 'Infrastructure platform architecture; the title matches, the platform is cloud infrastructure.', ['Architecture governance'], ['Terraform and landing zones are the core', 'No insurance or payments platform']],
  [44, 'Fabrikam Capital', 'Vice President, Treasury Operations', 'A treasury operations leadership role rather than technology.', ['Banking domain'], ['Operations management, not engineering', 'Treasury products are the core']],
  [41, 'Northwind Fintech', 'Senior Software Engineer, Payments', 'An individual engineering role, two levels below your scope.', ['Payments domain'], ['Mostly hands-on coding', 'Level mismatch']],
  [38, 'Woodgrove Bank', 'Data Platform Engineer', 'Data engineering on the analytics platform; outside your background.', ['Banking domain'], ['Spark and streaming pipelines are the core']],
  [34, 'Proseware Payments', 'Solutions Consultant (Pre-sales)', 'A customer-facing pre-sales role, which your criteria rule out.', ['Payments knowledge'], ['Pre-sales and quota']],
  [31, 'Tailspin Wealth', 'QA Automation Lead', 'Test automation leadership; your criteria rule out QA roles.', ['Delivery experience'], ['Test automation is the core']],
  [29, 'Adventure Works Bank', 'Network Security Architect', 'Security engineering for networks; not your function.', ['Architecture practice'], ['Network security is the core']],
  [26, 'Litware Insurance', 'Product Designer, Claims', 'A design role outside your field.', [], ['Design function', 'Insurance claims domain']],
  [22, 'Contoso Pay', 'Sales Engineer, Enterprise', 'A sales role; your criteria rule these out.', [], ['Sales function']],
];
const WAITING = [
  ['Woodgrove Bank', 'Head of Integration Architecture', 63],
  ['Fabrikam Capital', 'Director, Platform Engineering', 60],
  ['Litware Insurance', 'Solution Architect, Payments Modernisation', 58],
  ['Proseware Payments', 'Engineering Manager, Payments Gateway', 55],
  ['Adventure Works Bank', 'Lead Architect, Core Banking', 53],
  ['Tailspin Wealth', 'Platform Owner, Client Portal', 48],
  ['Northwind Fintech', 'Technical Product Manager, Ledger', 45],
  ['Contoso Pay', 'Architect, Merchant Onboarding', 42],
];

const jobs = {};
let n = 1000;
for (const [score, company, title, summary, strengths, gaps] of SCORED) {
  const key = `${company.toLowerCase().replace(/\W+/g, '')}:${n++}`;
  const posted = pick([1, 2, 3, 5, 8, 12, 15, 21, 28, 35, 44, 220]);
  jobs[key] = {
    key, company, title, location: pick(CITIES), url: `https://careers.example.com/${key.replace(':', '/')}`,
    postedAt: daysAgo(posted), firstSeen: daysAgo(Math.min(posted, 1 + Math.floor(rand() * 10))), status: 'open',
    score: { value: score, scorer: 'ai', summary, strengths, gaps, model: 'claude-sonnet-5-5', resumeHash: 'a1b2c3d4e5f6', scoredOn: daysAgo(Math.floor(rand() * 5)) },
  };
}
for (const [company, title, value] of WAITING) {
  const key = `${company.toLowerCase().replace(/\W+/g, '')}:${n++}`;
  jobs[key] = {
    key, company, title, location: pick(CITIES), url: `https://careers.example.com/${key.replace(':', '/')}`,
    postedAt: daysAgo(Math.floor(rand() * 4)), firstSeen: today, status: 'open',
    score: { value, scorer: 'keyword', summary: 'Keyword estimate', strengths: [], gaps: [], scoredOn: today },
  };
}
// Two roles closed this week, to show the count.
for (const title of ['Platform Lead, Payments Hub', 'Engineering Manager, Payouts']) {
  const key = `contosopay:${n++}`;
  jobs[key] = { key, company: 'Contoso Pay', title, location: CITIES[0], url: 'https://careers.example.com/', postedAt: daysAgo(30), firstSeen: daysAgo(20), status: 'closed', closedOn: today, score: { value: 70, scorer: 'ai', summary: '', strengths: [], gaps: [] } };
}

const byTitle = (t) => Object.values(jobs).find((j) => j.title === t);

// The posting's own must-haves, on the roles a visitor is likely to open first.
const MUSTS = {
  'Head of Payments Platform Engineering': [
    ['12+ years in payments technology', '12+ years in payments technology, including real-time schemes', 'yes'],
    ['Leading engineering managers', 'lead a group of engineering managers across several teams', 'yes'],
    ['Card-scheme certification', 'hands-on experience certifying with the major card schemes', 'no'],
  ],
  'Principal Architect, Real-Time Payments': [
    ['Instant payments architecture', 'own the target architecture for our instant payments platform', 'yes'],
    ['Kafka at high volume', 'event streaming with Kafka at tens of thousands of messages a second', 'partly'],
  ],
  'Engineering Director, Core Platform': [
    ['Platform roadmap ownership', 'own the core platform roadmap and its budget', 'yes'],
    ['Hands-on coding', 'stay hands-on, reviewing and writing code every week', 'partly'],
  ],
};
for (const j of Object.values(jobs)) {
  if (MUSTS[j.title]) j.score.musts = MUSTS[j.title].map(([requirement, quote, match]) => ({ requirement, quote, match }));
}

// The role's level against the candidate's (Lead Architect at a bank), as the model would label it.
const levelFor = (title) =>
  /\b(Head|Director|VP|Vice President|Chief)\b/.test(title) ? { vs: 'up', note: '≈ one grade above Lead Architect; leads managers' }
  : /\b(Principal|Lead|Staff|Architect)\b/.test(title) ? { vs: 'same', note: '≈ Lead Architect at your bank' }
  : /\b(Manager|Engineer|Analyst|Specialist)\b/.test(title) ? { vs: 'down', note: '≈ one grade below; asks 8+ years' }
  : null;
for (const j of Object.values(jobs)) {
  const level = j.score.scorer === 'ai' && levelFor(j.title);
  if (level) j.score.level = level;
}

// Pay ranges: one stated on the posting, one from the pay table, the rest AI estimates.
const PAY = {
  'Head of Payments Platform Engineering': { source: 'posting', currency: 'GBP', low: 140000, high: 165000, period: 'year', quote: 'Salary: £140,000 to £165,000 plus bonus' },
  'Principal Architect, Real-Time Payments': { source: 'table', currency: 'GBP', low: 118000, high: 135000, period: 'year', basis: 'Solution Architect, Principal' },
  'Engineering Director, Core Platform': { source: 'estimate', currency: 'GBP', low: 130000, high: 160000, period: 'year', basis: 'director level, fintech, London' },
  'Platform Product Lead, Payments APIs': { source: 'estimate', currency: 'GBP', low: 95000, high: 115000, period: 'year', basis: 'product lead, payments, London' },
};
for (const j of Object.values(jobs)) if (PAY[j.title]) j.score.pay = PAY[j.title];

// Gaps that keep coming up across the roles scored 55 to 89, as the weekly roll-up would group them.
const keysOf = (...titles) => titles.map((t) => byTitle(t).key);
const gaps = {
  on: daysAgo(2),
  sig: 'demo',
  total: Object.values(jobs).filter((j) => j.status === 'open' && j.score.scorer === 'ai' && j.score.value >= 55 && j.score.value <= 89).length,
  themes: [
    { theme: 'Card issuing and card-scheme experience', keys: keysOf('Head of Payments Platform Engineering', 'Senior Engineering Manager, Card Issuing') },
    { theme: 'A narrower scope than your current role', keys: keysOf('Lead Solution Architect, ISO 20022 Migration', 'Senior Engineering Manager, Card Issuing') },
    { theme: 'Experience outside payments (formal product work, insurance)', keys: keysOf('Platform Product Lead, Payments APIs', 'Enterprise Architect, Finance Systems') },
  ],
};

const settings = {
  report: { timezone: TZ, good_match: 65, show_from: 50 },
  scoring: { max_ai_scores_per_run: 40 },
  dashboard: { url: '' },
  gaps: { enabled: true, min_score: 55, max_score: 89 },
};
const companies = Object.fromEntries(COMPANIES.filter((c) => c.source).map((c) => [c.name, { lastReadOk: today }]));
const summary = {
  runAt: now.toISOString(),
  today,
  companies: COMPANIES.map((c) => ({ company: c.name, url: c.url, source: c.source, status: c.source ? 'ok' : 'manual', error: null, listed: c.listed })),
  counts: { listed: COMPANIES.reduce((s, c) => s + c.listed, 0) },
  ai: { enabled: true, pending: WAITING.length, stoppedBecause: null },
  // What the filters left out, shown on the Companies tab for spot checks.
  nearMisses: {
    titles: [
      ['Adventure Works Bank', 'Executive Manager, Data Governance', 'second-look', 1],
      ['Adventure Works Bank', 'Senior Software Engineer, Payments', 'second-look', 3],
      ['Contoso Pay', 'Chapter Lead, Merchant Onboarding', 'unchecked', 1],
      ['Contoso Pay', 'Account Executive, Enterprise Sales', 'excluded', 2, 'Sales'],
      ['Fabrikam Capital', 'Associate, Credit Risk Analytics', 'second-look', 2],
      ['Litware Insurance', 'Claims Handler', 'second-look', 4],
      ['Litware Insurance', 'Graduate Intern, Technology', 'excluded', 6, 'Intern'],
      ['Woodgrove Bank', 'Business Analyst, Card Issuing', 'second-look', 2],
      ['Woodgrove Bank', 'Relationship Manager, Corporate Banking', 'second-look', 1],
    ].map(([company, title, why, roles, word]) => ({ company, title, url: 'https://careers.example.com/', roles, why, ...(word ? { word } : {}) })),
    titlesTotal: 9,
    places: [
      { place: 'New York, United States', roles: 7, example: 'Director, Platform Engineering · Fabrikam Capital' },
      { place: 'Bengaluru, India', roles: 4, example: 'Engineering Manager, Payments · Woodgrove Bank' },
      { place: 'Glasgow, United Kingdom', roles: 2, example: 'Solution Architect, Payments · Litware Insurance' },
    ],
    placesTotal: 3,
    placeRoles: 13,
  },
};

// What the last run changed, as the brief at the top of the Roles tab shows it.
const firstScored = ['Principal Architect, Real-Time Payments', 'Delivery Lead, Open Banking', 'Data Platform Engineer'].map((t) => byTitle(t).key);
for (const key of firstScored) Object.assign(jobs[key], { firstSeen: today, score: { ...jobs[key].score, scoredOn: today } });
const changes = {
  since: new Date(now.getTime() - 24 * 36e5).toISOString(),
  new: [...firstScored, ...WAITING.slice(0, 5).map(([, t]) => byTitle(t).key)],
  scored: firstScored,
  moved: [{ key: byTitle('Lead Solution Architect, ISO 20022 Migration').key, from: 59 }],
  closed: ['Platform Lead, Payments Hub', 'Engineering Manager, Payouts'].map((t) => byTitle(t).key),
  reopened: [],
  notified: [byTitle('Principal Architect, Real-Time Payments').key],
  companies: { unreadable: [], stillUnreadable: [], recovered: ['Litware Insurance'], added: [], removed: [] },
  pending: { before: 11, now: WAITING.length },
};
summary.changes = { ...changes, line: briefLine({ changes, state: { jobs }, settings, aiPerRun: settings.scoring.max_ai_scores_per_run }) };
const history = [[0, 8, 2, 3, 1, 1, 8], [1, 4, 1, 6, 0, 2, 6], [2, 11, 0, 9, 2, 3, 3], [3, 2, 3, 2, 0, 1, 1], [4, 0, 1, 1, 0, 0, 0]]
  .map(([d, n, c, sc, g, l, p]) => ({ runAt: new Date(now.getTime() - d * 24 * 36e5).toISOString(), today: daysAgo(d), new: n, closed: c, scored: sc, good: g, look: l, pending: p }));

// A few calls on roles, as if made on the dashboard's buttons.
const calls = [['Head of Payments Platform Engineering', 'applied'], ['Engineering Director, Core Platform', 'shortlist'], ['Vice President, Treasury Operations', 'not-for-me', 'Operations, not technology'], ['Platform Lead, Payments Hub', 'applied', 'Recruiter call booked']];
const feedback = { roles: Object.fromEntries(calls.map(([t, verdict, reason = '']) => { const j = byTitle(t); return [j.key, { id: j.key.replace(/[^A-Za-z0-9]+/g, '-'), verdict, reason, at: now.toISOString() }]; })) };

// Stretch roles from a research task outside Axia, shown on the Moonshots tab (made up too).
const moonshots = {
  file: 'moonshots.json',
  report: normalizeMoonshots({
    updatedAt: new Date(now.getTime() - 9 * 36e5).toISOString(),
    summary: 'One new role since yesterday. The Bluesky Cloud architect role is still the best overall pick; Lucerne Bank\'s CTO search closes next week.',
    picks: [
      { label: 'Best overall', role: 'bluesky-principal-architect', note: 'Platform scale and brand you do not have today, with your integration work as the bridge.' },
      { label: 'Best executive role', role: 'lucerne-cto', note: 'A first CTO seat at a mid-size bank.' },
      { label: 'Best realistic stretch', role: 'margie-director-payments', note: 'Same domain, one level up.' },
    ],
    roles: [
      { id: 'bluesky-principal-architect', company: 'Bluesky Cloud', title: 'Principal Architect, Financial Services', location: 'London, United Kingdom', category: 'Big Tech', status: 'active', fit: 'Medium', why: 'Moves you from one bank\'s platforms to shaping how many banks run on a hyperscaler.', requirements: ['15+ years in architecture', 'Customer-facing advisory to banks', 'Cloud migration programmes'], gaps: ['No public-cloud certification', 'Little pre-sales experience'], url: 'https://careers.example.com/bluesky/123', firstSeen: daysAgo(4), lastVerified: daysAgo(0) },
      { id: 'lucerne-cto', company: 'Lucerne Bank', title: 'Chief Technology Officer', location: 'Edinburgh, United Kingdom', category: 'C-suite', status: 'closing', fit: 'Stretch', why: 'A step from leading a platform to owning the whole technology function.', requirements: ['Executive technology leadership', 'Board-level reporting', 'Regulated banking'], gaps: ['Has not held a P&L', 'No board exposure yet'], url: 'https://careers.example.com/lucerne/cto', firstSeen: daysAgo(9), lastVerified: daysAgo(0), closesOn: daysAgo(-6) },
      { id: 'margie-director-payments', company: 'Margie Payments', title: 'Director of Engineering, Real-Time Payments', location: 'London, United Kingdom', category: 'Fintech', status: 'new', fit: 'High', why: 'The domain you know at a fast-growing payments company, one level above your role today.', requirements: ['Leads managers of teams', 'Instant payments at scale'], gaps: ['Startup pace'], url: 'https://careers.example.com/margie/412', firstSeen: daysAgo(0), lastVerified: daysAgo(0) },
      { id: 'trey-staff-engineer', company: 'Trey Research', title: 'Staff Engineer, Developer Platform', location: 'Remote, United Kingdom', category: 'Big Tech', status: 'closed', fit: 'Stretch', why: 'A top-tier engineering brand.', url: 'https://careers.example.com/trey/9', firstSeen: daysAgo(12), note: 'The posting now says it has been filled.' },
    ],
    notes: ['Two companies\' careers sites could not be read today; their roles are carried over from yesterday.'],
  }),
};

buildSite({ state: { jobs, companies, gaps, history }, summary, settings, feedback, moonshots }, out, { minScore: 65, demo: true });
console.log(`Demo dashboard written to ${out}`);
