#!/usr/bin/env node
/**
 * find_valid_google_session.mjs
 *
 * Automate checking every FULL Google session profile in a cookie-dump tree to
 * find one that is still VALID (ALIVE) on Google, i.e. the auth cookies still
 * hold when replayed through a fresh CloakBrowser profile.
 *
 * For each full session (all 33 reference cookie pairs present):
 *   1. package_session.mjs → its cookie set into a session JSON
 *   2. import_session.mjs --delete → recreate cookies in a fresh scratch
 *      CloakBrowser profile on a proxy and health-check the auth state
 *   3. record the verdict (ALIVE / DEAD / CHALLENGED / CAPTCHA / UNKNOWN)
 *   4. stop early when an ALIVE session is found (--stop-on-alive)
 *
 * The check is sequential because bdg runs one attached session at a time.
 * Each scratch profile is deleted after its check (--delete), so the scan
 * leaves no leftover profiles.
 *
 * Usage:
 *   node scripts/find_valid_google_session.mjs "<dumpRoot>" \
 *       [--limit N] [--stop-on-alive] [--workdir <dir>] [--json out.json]
 *
 *   --dump only     package all full sessions but skip the import/check pass
 *   --limit N       only check the N most recent full sessions
 *   --stop-on-alive stop as soon as one session is found ALIVE
 *   --workdir       temp dir for packaged + result files (default: /tmp/bdg-find)
 *   --json out.json write the machine-readable results table to a file
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIND = path.join(HERE, 'find_full_google_session.mjs');
const PACKAGE = path.join(HERE, 'package_session.mjs');
const IMPORT = path.join(HERE, 'import_session.mjs');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const dump = argv.find((a) => a && !a.startsWith('-'));
const limit = parseInt(flag('limit', 'Infinity'), 10) || Infinity;
const stopOnAlive = argv.includes('--stop-on-alive');
const dumpOnly = argv.includes('--dump-only');
const workdir = flag('workdir', '/tmp/bdg-find');
const jsonOut = flag('json', null);
const floppyKey = flag('floppy-key', process.env.FLOPPYDATA_API_KEY || null);

if (!dump || !fs.existsSync(dump)) {
  console.error(`Usage: node scripts/find_valid_google_session.mjs "<dumpRoot>" [--limit N] [--stop-on-alive] [--dump-only] [--workdir dir] [--json out.json]`);
  process.exit(1);
}
fs.mkdirSync(path.join(workdir, 'sessions'), { recursive: true });

function lastJsonObject(s) {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(i)); } catch { return null; }
      }
    }
  }
  return null;
}

function runJson(cmd, args) {
  const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 });
  try { return JSON.parse(out.trim()); } catch {}
  const parsed = lastJsonObject(out);
  if (parsed) return parsed;
  throw new Error(`${cmd} ${args.join(' ')}: could not parse JSON (${out.slice(0, 120)})`);
}

// --- 1. enumerate FULL sessions (newest first) ---
console.error('Scanning dump for FULL Google sessions...');
const scan = runJson('node', [FIND, dump, '--json']);
let full = Array.isArray(scan.full) ? scan.full : scan.full ? Object.keys(scan.full).map((k) => scan.full[k]) : [];
const ts = (p) => {
  const m = /_(\d{4}_\d{2}_\d{2}T\d{2}_\d{2}_\d{2}_\d{6})$/.exec(p);
  return m ? m[1] : '';
};
full = full.slice().sort((a, b) => ts(b).localeCompare(ts(a)));
if (Number.isFinite(limit)) full = full.slice(0, limit);
console.error(`${scan.fullSessions} full sessions found; checking ${full.length} (newest first)\n`);

// --- 2 & 3. package + import each, record verdict ---
// --- detect the profile token + its 2-letter country prefix from the folder name ---
// Folers look like: ".../@updh1 - <TOKEN>_<timestamp>" where TOKEN starts with an ISO-2 country code.
const TOKEN_RE = / - ([A-Z][A-Z0-9]{15,})_\d{4}_\d{2}_\d{2}T/;
const tokenOf = (p) => {
  const m = TOKEN_RE.exec(p);
  return m ? m[1] : path.basename(p).replace(/[^A-Za-z0-9]/g, '_');
};
const countryOf = (p) => {
  const m = TOKEN_RE.exec(p);
  return m && /^[A-Z]{2}$/.test(m[1].slice(0, 2)) ? m[1].slice(0, 2) : null;
};

// --- Floppydata: build a geo-matched rotating proxy for a country (cached) ---
// Falls back to nil (import_session then uses its default US IPVanish) when the
// key is absent or the country is unsupported / the call fails.
const proxyCache = new Map(); // country -> connectionString | null
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

const results = [];
for (const profile of full) {
  const name = tokenOf(profile);
  const country = countryOf(profile);
  const sessFile = path.join(workdir, 'sessions', `${name}.json`);
  console.error(`\n=== ${name} ===`);

  try {
    execFileSync('node', [PACKAGE, profile, name, '-o', sessFile, '--force'], {
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().slice(0, 200);
    results.push({ profile, status: 'package_error', detail: msg });
    console.error(`  ✘ package error: ${msg}`);
    continue;
  }

  if (dumpOnly) {
    results.push({ profile, status: 'packaged' });
    continue;
  }

  // geo-match the check proxy to the session's country (Floppydata rotating, cached per country)
  const proxy = await floppyProxyFor(country);
  const proxyNote = proxy ? `${country} (floppydata ${proxy.split('@').pop()})` : country ? `${country} -> fallback default` : 'unknown geo -> default';
  console.error(`  proxy: ${proxyNote}`);

  let status = 'import_error', detail = '';
  const importArgs = [IMPORT, sessFile, '--delete'];
  if (proxy) importArgs.push('--proxy', proxy);
  try {
    const out = execFileSync('node', importArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const m = /(✅ ALIVE|💀 DEAD|⚠️ CHALLENGED|🤖 CAPTCHA|❓ UNKNOWN)\s*:\s*(.+)/.exec(out);
    if (m) {
      status = m[1].trim().split(' ')[1]; // ALIVE / DEAD / CHALLENGED / CAPTCHA / UNKNOWN
      detail = m[2].trim();
    } else {
      detail = (out.trim().split('\n').slice(-4).join(' ')).slice(0, 150);
    }
  } catch (e) {
    const raw = String(e.stdout || e.stderr || e.message || '').toString();
    const m = /(✅ ALIVE|💀 DEAD|⚠️ CHALLENGED|🤖 CAPTCHA|❓ UNKNOWN)\s*:\s*(.+)/.exec(raw);
    if (m) {
      status = m[1].trim().split(' ')[1];
      detail = m[2].trim();
    } else {
      detail = (raw.split('\n').filter((l) => l.trim()).slice(-3).join(' ')).slice(0, 200) || 'check failed';
    }
  }
  results.push({ profile, status, detail });
  const icon = { ALIVE: '✅', DEAD: '💀', CHALLENGED: '⚠️', CAPTCHA: '🤖', UNKNOWN: '❓' }[status] || '✘';
  console.error(`  ${icon} ${status}: ${detail}`);

  if (stopOnAlive && status === 'ALIVE') {
    console.error('\n✔ VALID session found — stopping early.');
    break;
  }
}

// --- 4. summary ---
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
const table = results.map((r, i) => ({ i: i + 1, status: r.status, detail: r.detail, profile: r.profile }));
const alive = results.filter((r) => r.status === 'ALIVE');

console.error(`\n=== Done: ${results.length} checked ===`);
for (const [k, v] of Object.entries(counts)) console.error(`  ${v} ${k}`);
if (alive.length) {
  console.error(`\n✔ VALID SESSIONS (${alive.length}):`);
  alive.forEach((r) => console.error(`  ${r.detail}  ${r.profile}`));
} else {
  console.error('\n✘ No valid (ALIVE) session found.');
}

if (jsonOut) {
  const result = { dump, checked: results.length, counts, alive: alive.map((r) => r.profile), results: table };
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(result, null, 2));
  console.log(`Wrote results → ${path.resolve(jsonOut)}`);
} else {
  console.log(JSON.stringify({ checked: results.length, counts, alive: alive.map((r) => r.profile) }, null, 2));
}