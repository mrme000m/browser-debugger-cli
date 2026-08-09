#!/usr/bin/env node
/**
 * find_github_sessions.mjs
 *
 * Scan a stealer-log cookie dump for profiles whose cookie files carry the full
 * GitHub session cookie set (the 14 cookies captured from an authenticated
 * browser), and report which of those are AUTHENTICATED (i.e. the session
 * tokens are present: user_session + logged_in=yes + dotcom_user).
 *
 * Usage:
 *   node scripts/find_github_sessions.mjs "<dumpRoot>" \
 *       [--auth-only] [--limit N] [--json out.json]
 *
 *   --auth-only  only list files whose GitHub session is authenticated
 *   --limit N    cap the printed detail rows (summary always prints)
 *   --json       write machine-readable results to a file
 */

import * as fs from 'fs';
import * as path from 'path';

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(`--${name}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const root = argv.find((a) => a && !a.startsWith('-'));
const authOnly = argv.includes('--auth-only');
const limit = parseInt(flag('limit', '30'), 10) || 30;
const jsonOut = flag('json', null);

// The 14 cookies of an authenticated GitHub session (13 unique names; `tz` appears on two domains).
const GH_ALL = ['_octo', 'cpu_bucket', 'preferred_color_mode', 'tz', '_device_id', 'saved_user_sessions',
  'user_session', '__Host-user_session_same_site', 'color_mode', 'logged_in', 'dotcom_user', 'last_write_ms', '_gh_sess'];
const GH_AUTH = ['user_session', 'logged_in', 'dotcom_user']; // present only when signed in

if (!root || !fs.existsSync(root)) {
  console.error('Usage: node scripts/find_github_sessions.mjs "<dumpRoot>" [--auth-only] [--limit N] [--json out.json]');
  process.exit(1);
}

function parseNetscape(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split('\t');
    if (p.length < 7) continue;
    out.push({ domain: p[0].toLowerCase(), secure: p[3] === 'TRUE', expires: Number(p[4]) || 0, name: p[5], value: p.slice(6).join('\t') });
  }
  return out;
}

// --- walk profiles ---
const profiles = [];
const stack = [root];
while (stack.length) {
  const dir = stack.pop();
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (fs.existsSync(path.join(full, 'Cookies'))) profiles.push(full);
      stack.push(full);
    }
  }
}
console.error(`Scanning ${profiles.length} profiles...`);

// --- scan each cookie file ---
const rows = []; // {profile, file, full: bool, auth: bool, user: string|null}
let fullFiles = 0, authFiles = 0;
for (const profile of profiles) {
  const cdir = path.join(profile, 'Cookies');
  for (const f of fs.readdirSync(cdir)) {
    if (!f.endsWith('.txt')) continue;
    const cookies = parseNetscape(path.join(cdir, f));
    const names = new Set(cookies.map((c) => c.name));
    if (!GH_ALL.every((n) => names.has(n))) continue; // not the full set
    fullFiles++;
    const user = cookies.find((c) => c.name === 'dotcom_user')?.value || null;
    const loggedIn = cookies.find((c) => c.name === 'logged_in')?.value;
    const auth = names.has('user_session') && loggedIn === 'yes' && !!user;
    if (auth) authFiles++;
    rows.push({ profile, file: f, auth, user, count: GH_ALL.length });
  }
}

// --- report ---
const authRows = rows.filter((r) => r.auth);
const shown = (authOnly ? authRows : rows).slice(0, limit);
console.log(`\nFiles with ALL ${GH_ALL.length} GitHub cookies: ${fullFiles}  (authenticated: ${authFiles})`);
for (const r of shown) {
  console.log(`  ${r.auth ? '✅' : '—'} [${path.basename(r.profile).slice(0, 46)}] ${r.file}  user: ${r.user || '—'}${r.auth ? '  (AUTHENTICATED)' : ''}`);
}
if ((authOnly ? authRows.length : rows.length) > shown.length) console.log(`  … and ${(authOnly ? authRows.length : rows.length) - shown.length} more (--limit ${limit})`);
if (authOnly && authRows.length === 0) console.log('✘ No authenticated GitHub session files found.');
else if (!authOnly && authFiles === 0) console.log('✘ No authenticated GitHub session files found.');

if (jsonOut) {
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ dump: root, fullCookieFiles: fullFiles, authenticated: authFiles, files: rows, authenticatedFiles: authRows }, null, 2));
  console.log(`\nWrote results → ${path.resolve(jsonOut)}`);
}