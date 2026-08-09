#!/usr/bin/env node
/**
 * find_full_google_session.mjs
 *
 * Scan a cookie-dump tree and find profile folders that hold a COMPLETE Google
 * session — i.e. all 34 (name, domain) cookies a fully logged-in Gmail/Google
 * session carries (SID/SSID/SAPISID/LSID/1PSID/OSID/GAPS etc, with their
 * exact domain scoping).
 *
 * Reference set: the 34 (name, domain) pairs captured live from a signed-in
 * Google account. A profile folder is FULL when every reference pair is
 * present across its Cookies/*.txt files; otherwise we report which are
 * missing.
 *
 * Usage:
 *   node scripts/find_full_google_session.mjs <dumpRoot>
 *   node scripts/find_full_google_session.mjs <dumpRoot> --json
 */

import * as fs from 'fs';
import * as path from 'path';

/** The 34 (name, domain) pairs of a complete signed-in Google session. */
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

/** True if a cookie (name, domain) matches a reference pair (domain tolerant of leading dot). */
function matches(name, domain, refName, refDomain) {
  if (name !== refName) return false;
  const d = String(domain || '').toLowerCase();
  const r = String(refDomain || '').toLowerCase();
  return d === r || d === r.replace(/^\./, '') || '.' + d === r;
}

/** Recursively find every folder that has a Cookies/ subdir. */
function findProfiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(full, 'Cookies'))) found.push(full);
        stack.push(full);
      }
    }
  }
  return found;
}

/** Build a Map key->cookie of every (name[%domain]) present in a profile folder. */
function collectCourse(dir) {
  const out = [];
  const cookiesDir = path.join(dir, 'Cookies');
  if (!fs.existsSync(cookiesDir) || !fs.statSync(cookiesDir).isDirectory()) return out;
  for (const f of fs.readdirSync(cookiesDir)) {
    if (!f.endsWith('.txt')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(cookiesDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const p = t.split('\t');
      if (p.length < 7) continue;
      out.push({ name: p[5], domain: p[0], value: p.slice(6).join('\t'), expires: Number(p[4]) || 0 });
    }
  }
  return out;
}

/** Coverage: how many of the 34 reference pairs are present, and which missing. */
function coverage(dir) {
  const cookies = collectCourse(dir);
  let matched = 0;
  const missing = [];
  for (const [refName, refDomain] of REFERENCE_PAIRS) {
    const hit = cookies.some((c) => matches(c.name, c.domain, refName, refDomain));
    if (hit) matched++;
    else missing.push(`${refName} (${refDomain})`);
  }
  return { matched, total: REFERENCE_PAIRS.length, missing };
}

/**
 * Per-source-file analysis: for each .txt in Cookies/, score completeness.
 * Returns the best single-file score and flags cross-account mixing.
 */
function perFileAnalysis(dir) {
  const cookiesDir = path.join(dir, 'Cookies');
  if (!fs.existsSync(cookiesDir) || !fs.statSync(cookiesDir).isDirectory()) return { best: { matched: 0 }, perFile: [], crossAccount: false, fileCount: 0 };
  const files = fs.readdirSync(cookiesDir).filter(f => f.endsWith('.txt'));
  const perFile = [];
  for (const f of files) {
    const cookies = [];
    let text;
    try {
      text = fs.readFileSync(path.join(cookiesDir, f), 'utf8');
    } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const p = t.split('\t');
      if (p.length < 7) continue;
      cookies.push({ name: p[5], domain: p[0] });
    }
    let matched = 0;
    for (const [refName, refDomain] of REFERENCE_PAIRS) {
      if (cookies.some(c => matches(c.name, c.domain, refName, refDomain))) matched++;
    }
    perFile.push({ file: f, matched, total: REFERENCE_PAIRS.length });
  }
  perFile.sort((a, b) => b.matched - a.matched);
  const best = perFile[0] || { matched: 0 };
  const crossAccount = (best.matched < REFERENCE_PAIRS.length) && (coverage(dir).matched >= REFERENCE_PAIRS.length);
  return { best, perFile, crossAccount, fileCount: files.length };
}

// --- CLI ---
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const cc = (() => {
  const i = argv.indexOf('--country');
  if (i !== -1 && argv[i + 1]) return argv[i + 1].toUpperCase();
  return null;
})();
const dir = argv.find((a) => !a.startsWith('-'));
if (!dir) {
  console.error('Usage: node scripts/find_full_google_session.mjs <dumpRoot> [--country <CC>] [--json]');
  console.error('  --country CC  only show profiles whose 2-letter code (e.g. MA, US, ID) matches');
  process.exit(1);
}

let profiles = findProfiles(dir);
if (cc) {
  const before = profiles.length;
  const ccToken = ` - ${cc}[`;
  profiles = profiles.filter((p) => p.includes(ccToken));
  if (!profiles.length) console.error(`(no profiles with country code "${cc}" among ${before} scanned)`);
}

console.error(`Scanning ${profiles.length} profiles...`);
const rows = profiles
  .map((p) => ({ profile: p, ...coverage(p), perFile: perFileAnalysis(p) }))
  .sort((a, b) => b.matched - a.matched);

const full = rows.filter((r) => r.matched >= r.total);
const partial = rows.filter((r) => r.matched < r.total);
const crossAccount = full.filter(r => r.perFile.crossAccount);

if (json) {
  console.log(JSON.stringify({ root: dir, checked: rows.length, fullSessions: full.length, partial: partial.length, refCount: REFERENCE_PAIRS.length, full: full.map((r) => r.profile), rows }, null, 2));
} else {
  console.log(`Reference set: ${REFERENCE_PAIRS.length} (name, domain) pairs (full Google session)`);
  console.log(`Profiles checked: ${rows.length} (folders with a Cookies/ subdir)`);
  console.log(`\nFULL SESSION (all ${REFERENCE_PAIRS.length} pairs): ${full.length}`);
  // timestamp from the trailing [YYYY-MM-DDThh_mm_ss] in the profile dir name
  const ts = (p) => {
    const m = /\[(\d{4})-(\d{2})-(\d{2})T(\d{2})_(\d{2})_(\d{2})\]/.exec(p);
    if (!m) return 0;
    const [y, mo, da, h, mi, se] = m.slice(1).map(Number);
    return Date.UTC(y, mo - 1, da, h, mi, se);
  };
  const top = full.slice().sort((a, b) => ts(b.profile) - ts(a.profile)).slice(0, 5);
  console.log(`  most recent ${top.length} (by folder timestamp; --json for all):`);
  top.forEach((r, i) => {
    const dt = ts(r.profile) ? new Date(ts(r.profile)).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19) : '';
    console.log(`  ${i + 1}. [${dt}] ${r.profile}`);
  });
  if (full.length > 5) console.log(`  ... and ${full.length - 5} more (use --json for the full list)`);
  if (!full.length) console.log('  (none)');
  if (crossAccount.length) {
    console.log(`\n⚠ CROSS-ACCOUNT MIXING: ${crossAccount.length} profile(s) score 33/33 globally`);
    console.log('  but no SINGLE source file has all 33 pairs — tokens from different');
    console.log('  accounts are mashed together. These sessions will FAIL on import.');
    console.log('  Run package_session.mjs on these profiles — it now isolates the best source.');
    crossAccount.slice(0, 5).forEach((r) => {
      const best = r.perFile.best;
      console.log(`  [global 33/33, best file ${best.matched}/33: "${best.file}"] ${r.profile}`);
    });
    if (crossAccount.length > 5) console.log(`  ... and ${crossAccount.length - 5} more`);
  }
  console.log(`\nPARTIAL (missing >= 1): ${partial.length} (top by coverage:)`);
  partial.slice(0, 10).forEach((r) =>
    console.log(`  [${r.matched}/${r.total}] ${r.profile}\n      missing: ${r.missing.slice(0, 5).join(', ')}${r.missing.length > 5 ? ' …' : ''}`)
  );
  if (partial.length > 10) console.log(`  ... and ${partial.length - 10} more (use --json for the full list)`);
}