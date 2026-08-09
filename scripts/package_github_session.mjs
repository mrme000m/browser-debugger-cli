#!/usr/bin/env node
/**
 * package_github_session.mjs
 *
 * Package the GitHub cookies from ONE cookie file (Netscape format) into a
 * bdg session JSON whose schema matches `bdg session export` byte-for-byte
 * (name, value, domain, path, expires, size, httpOnly, secure, session,
 * sameSite, priority, sourceScheme, sourcePort).
 *
 * Usage:
 *   node scripts/package_github_session.mjs "<cookiesDir>" "<file.txt>" <name> [-o out.json]
 *
 *   cookiesDir  the profile's Cookies/ dir
 *   file.txt    the source file inside it holding the GitHub session
 *   name        session name (used as default outfile in ~/.bdg/sessions/)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const argv = process.argv.slice(2);
const dir = argv[0];
const file = argv[1];
const name = argv[2];
const oFlag = argv.indexOf('-o');
const out = oFlag !== -1 ? argv[oFlag + 1] : undefined;

if (!dir || !file || !name) {
  console.error('Usage: node scripts/package_github_session.mjs "<cookiesDir>" "<file.txt>" <name> [-o out.json]');
  process.exit(1);
}
const full = path.join(dir, file);
if (!fs.existsSync(full)) { console.error(`No such file: ${full}`); process.exit(1); }

/** Full-schema cookie row matching bdg session export output. */
function row(c) {
  const persistent = c.expires > 0;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: persistent ? c.expires : -1,
    size: String(c.value).length,
    httpOnly: c.httpOnly,
    secure: c.secure,
    session: !persistent,
    sameSite: 'Lax',
    priority: 'Medium',
    sourceScheme: 'Secure',
    sourcePort: 443,
  };
}

const gh = [];
for (const raw of fs.readFileSync(full, 'utf8').split('\n')) {
  const t = raw.trim();
  if (!t || t.startsWith('#')) continue;
  const p = t.split('\t');
  if (p.length < 7) continue;
  const domain = p[0].toLowerCase();
  if (!/github/.test(domain)) continue;
  gh.push({ domain, hostOnly: p[1] !== 'TRUE', path: p[2] || '/', secure: p[3] === 'TRUE', expires: Number(p[4]) || 0, name: p[5], value: p.slice(6).join('\t'), httpOnly: /github/.test(domain) });
}

// dedupe by (domain, path, name), keep freshest expiry
const dedupe = new Map();
for (const c of gh) {
  const key = `${c.domain}\u0000${c.path}\u0000${c.name}`;
  const ex = dedupe.get(key);
  if (!ex || c.expires > ex.expires) dedupe.set(key, c);
}
const cookies = [...dedupe.values()].map(row);

const session = { name, capturedAt: new Date().toISOString(), cookies };

let outFile = out;
if (!outFile) outFile = path.join(os.homedir(), '.bdg', 'sessions', `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(session, null, 2));

const user = cookies.find((c) => c.name === 'dotcom_user')?.value || null;
const sess = cookies.find((c) => c.name === 'user_session');
const loggedIn = cookies.find((c) => c.name === 'logged_in')?.value;
console.log(`Packaged ${cookies.length} GitHub cookies → ${outFile}`);
console.log(`  dotcom_user: ${user} | user_session: ${sess ? 'present' : 'MISSING'} | logged_in: ${loggedIn}`);
if (!sess || loggedIn !== 'yes' || !user) console.error(`  ⚠ not an authenticated session by our markers`);