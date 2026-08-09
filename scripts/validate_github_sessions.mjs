#!/usr/bin/env node
/**
 * validate_github_sessions.mjs
 *
 * Replay dumped GitHub cookie sessions through fresh CloakBrowser profiles and
 * report which ones GitHub still accepts (ALIVE) vs rejects (DEAD).
 *
 * Input: the JSON written by find_github_sessions.mjs (has .authenticatedFiles
 * with {profile, file, user}). For each entry (optionally skipping users with
 * --skip <user>):
 *   1. package_github_session.mjs → schema-exact bdg session JSON
 *   2. create a fresh CBM profile on a geo-matched proxy (Floppydata, cached
 *      per country; falls back to the default US proxy when unsupported)
 *   3. launch, connect, `bdg session import <name> --url https://github.com/`
 *   4. after settle, read dotcom_user / logged_in / Sign out markers
 *   5. delete the scratch profile, record the verdict
 *
 * Usage:
 *   node scripts/validate_github_sessions.mjs <scan.json> \
 *       [--skip user1,user2] [--json out.json]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(HERE, 'package_github_session.mjs');

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(`--${name}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const scanFile = argv.find((a) => a && !a.startsWith('-'));
const skip = (flag('skip', '') || '').split(',').filter(Boolean);
const jsonOut = flag('json', null);
const floppyKey = flag('floppy-key', process.env.FLOPPYDATA_API_KEY || null);

if (!scanFile || !fs.existsSync(scanFile)) {
  console.error(`Usage: node scripts/validate_github_sessions.mjs <scan.json> [--skip user1,user2] [--json out.json]`);
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
const targets = (scan.authenticatedFiles || []).filter((r) => !skip.includes(r.user));
if (!targets.length) { console.error('Nothing to validate (check --skip / scan.json).'); process.exit(1); }

function lastJsonObject(s) {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i)); } catch { return null; } } }
  }
  return null;
}
function run(args) {
  const out = execFileSync('bdg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return lastJsonObject(out) || {};
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const TOKEN_RE = / - ([A-Z][A-Z0-9]{15,})_\d{4}_\d{2}_\d{2}T/;
const countryOf = (p) => { const m = TOKEN_RE.exec(p); return m && /^[A-Z]{2}$/.test(m[1].slice(0, 2)) ? m[1].slice(0, 2) : null; };

const proxyCache = new Map();
async function floppyProxyFor(country) {
  if (proxyCache.has(country)) return proxyCache.get(country);
  let url = null;
  if (floppyKey && country) {
    try {
      const res = await fetch('https://api.floppydata.net/v2/proxy/rotating/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': floppyKey },
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
for (const t of targets) {
  const name = `gh-${t.user.replace(/[^A-Za-z0-9]/g, '-')}`;
  const sessFile = path.join(os.homedir(), '.bdg', 'sessions', `${name}.json`);
  const country = countryOf(t.profile);
  console.error(`\n=== ${t.user} [${country}] (${t.file}) ===`);

  // 1. package
  try {
    execFileSync('node', [PACK, path.join(t.profile, 'Cookies'), t.file, name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const msg = String(e.stderr || e.message || '').slice(0, 200);
    results.push({ user: t.user, status: 'package_error', detail: msg });
    console.error(`  ✘ package error: ${msg}`);
    continue;
  }
  // format check: schema must match bdg export exactly
  const packed = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  const want = ['name', 'value', 'domain', 'path', 'expires', 'size', 'httpOnly', 'secure', 'session', 'sameSite', 'priority', 'sourceScheme', 'sourcePort'];
  const keys = Object.keys(packed.cookies[0] || {});
  if (keys.join(',') !== want.join(',')) {
    results.push({ user: t.user, status: 'format_error', detail: `cookie keys mismatch: ${keys.join(',')}` });
    console.error(`  ✘ format error: ${keys.join(',')} != ${want.join(',')}`);
    continue;
  }

  // 2-3. create + launch + connect + import
  const proxy = await floppyProxyFor(country);
  const proxyNote = proxy ? `${country} (floppydata ${proxy.split('@').pop()})` : country ? `${country} -> fallback default` : 'default';
  console.error(`  proxy: ${proxyNote}`);
  let pid;
  try {
    const createArgs = ['cloak', 'create', '--name', name, '--json'];
    if (proxy) createArgs.push('--proxy', proxy);
    pid = run(createArgs).data?.id;
    if (!pid) throw new Error('create returned no id');
    execFileSync('bdg', ['stop'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    await sleep(500);
    execFileSync('bdg', ['cloak', 'launch', pid, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(2000);
    execFileSync('bdg', ['cloak', 'connect', pid], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
    await sleep(1000);
    execFileSync('bdg', ['session', 'import', name, '--url', 'https://github.com/'], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 60000 });
  } catch (e) {
    if (pid) { try { execFileSync('bdg', ['cloak', 'delete', pid], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 15000 }); } catch {} }
    results.push({ user: t.user, status: 'import_error', detail: String(e.message || '').slice(0, 200) });
    console.error(`  ✘ import error: ${String(e.message || '').slice(0, 200)}`);
    continue;
  }

  // 4. check signed-in state
  await sleep(9000);
  let status = 'unknown', detail = '', liveUser = null;
  try {
    const ev = run(['cdp', 'Runtime.evaluate', '--params', JSON.stringify({
      expression: 'JSON.stringify({user:document.querySelector("meta[name=user-login]")?.content||null,signout:document.body?.innerText.includes("Sign out"),loginBtn:!!document.querySelector("a[href=\\"/login\\"]"),url:location.href})',
      returnByValue: true,
    })]);
    const v = ev.data?.result?.result?.value;
    const p = v ? JSON.parse(v) : {};
    liveUser = p.user || null;
    const cookies = run(['cdp', 'Network.getAllCookies']).data?.result?.cookies || [];
    const loggedIn = cookies.find((c) => c.name === 'logged_in')?.value;
    const hasSession = cookies.some((c) => c.name === 'user_session');
    if (liveUser && p.signout) { status = 'ALIVE'; detail = `GitHub user ${liveUser}`; }
    else if (hasSession && loggedIn === 'yes') { status = 'ALIVE'; detail = `user_session + logged_in=yes (user: ${liveUser || '?'})`; }
    else if (loggedIn === 'no') { status = 'DEAD'; detail = 'GitHub cleared session (logged_in=no)'; }
    else { status = 'UNKNOWN'; detail = `user:${liveUser} logged_in:${loggedIn} hasSession:${hasSession}`; }
  } catch (e) {
    detail = String(e.message || '').slice(0, 150);
  }
  results.push({ user: t.user, country, status, detail });
  const icon = status === 'ALIVE' ? '✅' : status === 'DEAD' ? '💀' : '❓';
  console.error(`  ${icon} ${status}: ${detail}`);

  // 5. cleanup
  try { execFileSync('bdg', ['cloak', 'delete', pid], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 15000 }); } catch {}
}

console.error(`\n=== Done: ${results.length} validated ===`);
for (const r of results) console.error(`  ${r.status.padEnd(12)} ${r.user.padEnd(22)} ${r.detail}`);
if (jsonOut) {
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ checked: results.length, results }, null, 2));
  console.log(`Wrote results → ${path.resolve(jsonOut)}`);
}