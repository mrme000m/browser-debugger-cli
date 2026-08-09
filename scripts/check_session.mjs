#!/usr/bin/env node
/**
 * check_session.mjs
 *
 * Test whether a packaged Google session holds when replayed through
 * different IPVanish proxy countries.  Creates a scratch CloakBrowser
 * profile for each proxy, injects Google auth cookies, navigates to Gmail,
 * and reports the auth state.
 *
 * Usage:
 *   node scripts/check_session.mjs <session.json> \
 *       [--countries US,GB,DE] [--keep] [--timeout-sec 20] [--json]
 *
 *   --countries  comma-separated 2-letter codes to test (default: all
 *                IPVanish countries available in proxy-credentials)
 *   --keep       don't delete scratch profiles after test
 *   --timeout-sec  max seconds to wait for page load (default: 15)
 *   --json       machine-readable output
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

const file = argv.find((a) => a && !a.startsWith('-'));
const keep = argv.includes('--keep');
const json = argv.includes('--json');
const timeoutSec = parseInt(flag('timeout-sec', '15'), 10);
const countriesFilter = flag('countries', null);
const wantedCodes = countriesFilter ? new Set(countriesFilter.toUpperCase().split(',').map(s => s.trim())) : null;

if (!file || !fs.existsSync(file)) {
  console.error('Usage: node scripts/check_session.mjs <session.json> [--countries US,GB] [--keep] [--json]');
  process.exit(1);
}

// --- helpers ---
function run(args, ignoreErrors) {
  let out;
  try {
    out = execFileSync('bdg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (ignoreErrors) return null;
    throw new Error(`bdg ${args.join(' ')}: ${(e.stderr || e.message || '').trim().slice(0, 300)}`);
  }
  const parsed = parseJson(out);
  return parsed || (ignoreErrors ? null : out);
}

function parseJson(out) {
  const end = out.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0, start = end;
  for (; start >= 0; start--) {
    if (out[start] === '}') depth++;
    else if (out[start] === '{') { depth--; if (depth === 0) break; }
  }
  if (start < 0) return null;
  try { return JSON.parse(out.slice(start, end + 1)); } catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cdp(method, params) {
  let r;
  try {
    r = execFileSync('bdg', ['cdp', method, '--params', JSON.stringify(params)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    });
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).slice(0, 200) : '';
    throw new Error(`cdp ${method}: ${e.message.slice(0, 100)}${stderr ? ' stderr:'+stderr : ''}`);
  }
  const parsed = parseJson(r);
  if (!parsed) throw new Error(`cdp ${method}: no JSON in response (${String(r).slice(0, 100)})`);
  if (parsed.success === false) throw new Error(parsed.error || `${method} failed`);
  return parsed;
}

// --- load session ---
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const REF = [
  ['ACCOUNT_CHOOSER', 'accounts.google.com'], ['APISID', '.google.com'], ['COMPASS', 'mail.google.com'],
  ['GMAIL_AT', 'mail.google.com'], ['HSID', '.google.com'], ['LSID', 'accounts.google.com'],
  ['NID', '.google.com'], ['OSID', 'mail.google.com'], ['OTZ', 'accounts.google.com'],
  ['OTZ', 'contacts.google.com'], ['OTZ', 'ogs.google.com'], ['SAPISID', '.google.com'],
  ['SEARCH_SAMESITE', '.google.com'], ['SID', '.google.com'], ['SIDCC', '.google.com'],
  ['SSID', '.google.com'], ['__Host-1PLSID', 'accounts.google.com'], ['__Host-3PLSID', 'accounts.google.com'],
  ['__Host-GAPS', 'accounts.google.com'], ['__Host-GMAIL_SCH', 'mail.google.com'],
  ['__Host-GMAIL_SCH_GML', 'mail.google.com'], ['__Host-GMAIL_SCH_GMN', 'mail.google.com'],
  ['__Host-GMAIL_SCH_GMS', 'mail.google.com'], ['__Secure-1PAPISID', '.google.com'],
  ['__Secure-1PSID', '.google.com'], ['__Secure-1PSIDCC', '.google.com'], ['__Secure-1PSIDTS', '.google.com'],
  ['__Secure-3PAPISID', '.google.com'], ['__Secure-3PSID', '.google.com'], ['__Secure-3PSIDCC', '.google.com'],
  ['__Secure-3PSIDTS', '.google.com'], ['__Secure-OSID', 'mail.google.com'], ['__Secure-STRP', '.google.com'],
];
function isRefCookie(c) {
  const d = String(c.domain || '').toLowerCase();
  return REF.some(([n, rd]) =>
    c.name === n && (d === rd || d === rd.replace(/^\./, '') || '.' + d === rd)
  );
}

const rawCookies = (s.cookies || []).filter(isRefCookie);
const injectCookies = rawCookies.map((c) => {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
  if (c.expires !== undefined && c.expires !== -1) out.expires = c.expires;
  if (c.httpOnly !== undefined) out.httpOnly = c.httpOnly;
  if (c.secure !== undefined) out.secure = c.secure;
  return out;
});

console.error(`Session: ${s.name || path.basename(file)}  (${injectCookies.length} auth cookies loaded)`);

// --- discover proxies ---
const creds = run(['cloak', 'proxy-credentials', '--json']);
const allProxies = (creds.data || []).filter(c =>
  /ipvanish/i.test(c.name) && c.last_status === 'ok'
);

// group by country code
const countryMap = new Map(); // "US" -> [{id, name, location}]
for (const p of allProxies) {
  const loc = p.provider_location || '';
  const code = loc.split('-')[0]?.toUpperCase();
  if (!code || code.length !== 2) continue;
  if (wantedCodes && !wantedCodes.has(code)) continue;
  if (!countryMap.has(code)) countryMap.set(code, []);
  countryMap.get(code).push({ id: p.id, name: p.name, location: loc, code });
}

const countries = [...countryMap.keys()].sort();
console.error(`Testing ${countries.length} countries: ${countries.join(', ')}\n`);

// --- test each proxy ---
const results = [];
for (const [code, proxies] of countryMap) {
  // pick the first proxy for this country
  const proxy = proxies[0];
  const profileName = `check-${code.toLowerCase()}-${Date.now().toString(36)}`;

  console.error(`[${code}] ${proxy.name} ...`);

  let pid, result = { code, proxy: proxy.name, status: 'error', detail: '' };
  try {
    // create
    const created = run(['cloak', 'create', '--name', profileName, '--proxy-credential', proxy.id, '--json']);
    pid = created.data.id;
    await sleep(2000); // daemon needs time to write profile data to disk

    // launch
    run(['cloak', 'launch', pid, '--json']);

    // connect bdg
    execFileSync('bdg', ['cloak', 'connect', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(2000); // let CDP session warm up

    // verify connection with a trivial eval
    try {
      const ping = cdp('Runtime.evaluate', { expression: '"bdg_ok"', returnByValue: true });
      const got = ping?.data?.result?.result?.value;
      if (got !== 'bdg_ok') throw new Error(`CDP ping returned: ${JSON.stringify(got)} (full: ${JSON.stringify(ping?.data?.result).slice(0,200)})`);
    } catch (e) {
      result.status = 'cdp_error';
      result.detail = 'CDP connection failed: ' + e.message.slice(0, 120);
      throw e;
    }

    // inject cookies
    const CHUNK = 300;
    for (let i = 0; i < injectCookies.length; i += CHUNK) {
      cdp('Network.setCookies', { cookies: injectCookies.slice(i, i + CHUNK) });
    }

    // navigate to account chooser (lightweight check — Gmail would redirect anyway)
    cdp('Page.navigate', { url: 'https://accounts.google.com/' });

    // wait and retry up to 3 times for page to load
    let pageInfo = {};
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sleep(Math.ceil(timeoutSec / 3) * 1000);
      try {
        const ev = cdp('Runtime.evaluate', {
          expression: 'JSON.stringify({title:document.title,url:location.href,body:(document.body?.innerText||"").slice(0,400)})',
        });
        const val = ev.data?.result?.result?.value;
        if (val && val.length > 10) {
          pageInfo = JSON.parse(val);
          if (pageInfo.title || pageInfo.body) break;
        }
      } catch {} 
    }

    const title = pageInfo.title || '';
    const url = pageInfo.url || '';
    const body = pageInfo.body || '';

    // classify
    if (/myaccount|myaccount\.google/.test(url) || /Google Account/i.test(title) && !/sign|Sign in|signed out/i.test(body)) {
      result.status = 'signed_in';
      result.detail = title;
    } else if (/signed out|Signed out|Choose an account/i.test(body) && !/sign in|password/i.test(body.toLowerCase())) {
      result.status = 'signed_out';
      result.detail = 'Account recognized but signed out';
    } else if (/sign in|password|challenge|verify|2-step|2FA|confirm|recovery/i.test(body)) {
      result.status = 'challenged';
      result.detail = 'Google requires re-authentication';
    } else if (/unusual traffic|robot|CAPTCHA|not a robot/i.test(body)) {
      result.status = 'captcha';
      result.detail = 'CAPTCHA / bot detection triggered';
    } else {
      // fallback: check for account name
      const knownNames = ['Chasity Thiem', 'Nex Powers', 'Google Account'];
      const foundName = knownNames.find(n => body.includes(n));
      if (foundName) {
        result.status = body.includes('Signed out') ? 'signed_out' : 'partial';
        result.detail = `Found "${foundName}" / title="${title}"`;
      } else {
        result.status = 'unknown';
        result.detail = title || url?.slice(0, 80) || 'Page did not load';
      }
    }

    console.error(`  → ${result.status.toUpperCase()}: ${result.detail}`);

  } catch (e) {
    // don't overwrite cdp_error set above
    if (result.status === 'error' || !result.status) {
      result.status = 'error';
      result.detail = e.message.slice(0, 120);
    }
    console.error(`  → ${result.status.toUpperCase()}: ${result.detail}`);
  } finally {
    if (pid && !keep) {
      try {
        execFileSync('bdg', ['cloak', 'stop', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      } catch {}
      await sleep(2000);
      try {
        execFileSync('bdg', ['cloak', 'delete', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      } catch {}
    } else if (pid && keep) {
      result.pid = pid;
    }
  }
  results.push(result);
}

// --- summary ---
const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

if (json) {
  console.log(JSON.stringify({ session: file, results, summary: byStatus }, null, 2));
} else {
  console.log(`\n=== Results ===`);
  for (const r of results) {
    const icon = r.status === 'signed_in' ? '✅' : r.status === 'signed_out' ? '🚫' : r.status === 'challenged' ? '⚠️' : r.status === 'captcha' ? '🤖' : '❌';
    console.log(`${icon} [${r.code}] ${r.proxy}: ${r.status} — ${r.detail}`);
  }
  console.log(`\nSummary: ${Object.entries(byStatus).map(([k,v]) => `${v} ${k}`).join(', ')}`);
}
