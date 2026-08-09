#!/usr/bin/env node
/**
 * import_session.mjs
 *
 * Load a packaged bdg session (package_session.mjs output) into a FRESH
 * CloakBrowser profile on a given proxy, then optionally navigate to confirm.
 *
 * Orchestrates bdg cloak end-to-end:
 *   create (US proxy default) → launch → connect → setCookies → [navigate]
 *   → [--delete] stop+delete the scratch profile
 *
 * Usage:
 *   node scripts/import_session.mjs <session.json> \
 *       [--proxy-credential <id>] [--proxy-group <gid>] [--url <url>] \
 *       [--name <label>] [--delete] [--no-check]
 *
 * After injecting cookies it navigates to a Google endpoint and reports whether
 * the session is ALIVE (signed in), DEAD (account recognized but signed out),
 * or CHALLENGED (needs password/2FA). Pass --no-check to skip that probe.
 *
 * Default proxy credential: first US IPVanish in `bdg cloak proxy-credentials`.
 * Prefer a proxy geo-matched to the session's source region for best results.
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
const url = flag('url', null);
const proxyCredId = flag('proxy-credential', null);
const proxyGroup = flag('proxy-group', null);
const proxyUrl = flag('proxy', null);
const provider = flag('provider', 'google').toLowerCase();
let name = flag('name', null);
const doDelete = argv.includes('--delete');
const noCheck = argv.includes('--no-check');

// Quiet sh executor: captures stdout, throws on provider error, returns JSON.
function run(args) {
  let out;
  try {
    out = execFileSync('bdg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`bdg ${args.join(' ')} failed: ${(e.stderr || e.message || '').trim().slice(0, 400)}`);
  }
  const parsed = parseJson(out);
  if (!parsed) throw new Error(`bdg ${args[1]} returned no JSON: ${out.slice(0, 300)}`);
  if (parsed && parsed.success === false) throw new Error(parsed.error || `bdg ${args[1]} failed`);
  return parsed;
}

// Extract the last balanced top-level JSON object embedded in a stream.
function parseJson(out) {
  const end = out.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0, start = end;
  for (; start >= 0; start--) {
    const ch = out[start];
    if (ch === '}') depth++;
    else if (ch === '{') { depth--; if (depth === 0) break; }
  }
  if (start < 0) return null;
  try { return JSON.parse(out.slice(start, end + 1)); } catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cdp(method, params) {
  const r = execFileSync('bdg', ['cdp', method, '--params', JSON.stringify(params)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = parseJson(r);
  if (!parsed) throw new Error(`${method} returned no JSON`);
  if (parsed.success === false) throw new Error(parsed.error || `${method} failed`);
  return parsed;
}

// --- defaults ---
if (!file || !fs.existsSync(file)) {
  console.error(`Usage: node scripts/import_session.mjs <session.json> [--proxy-credential <id>] [--proxy-group <gid>] [--proxy <socks5://u:p@host:port>] [--url <url>] [--name <label>] [--delete] [--no-check]`);
  process.exit(1);
}

let credId = proxyCredId || proxyGroup;
// an inline --proxy URL short-circuits saved-credential lookup
if (proxyUrl) {
  console.log(`  proxy: ${proxyUrl.split('@').pop()}`);
} else if (!credId) {
  // pick the first healthy US-IPVanish credential
  const creds = run(['cloak', 'proxy-credentials', '--json']);
  const us = (creds.data || []).filter((c) => /US|United States|ipvanish/i.test(c.provider_location || c.name || ''));
  // prefer IPVanish, else any US entry
  const pick = us.find((c) => /ipvanish/i.test(c.name)) || us[0];
  if (!pick) throw new Error('No US proxy credential found. Pass --proxy-credential <id>.');
  credId = pick.id;
  console.log(`  proxy: ${pick.name}`);
}

if (!name) {
  name = `import-${path.basename(file, '.json')}`;
}

// --- create ---
const createArgs = ['cloak', 'create', '--name', name, '--json'];
if (proxyUrl) createArgs.push('--proxy', proxyUrl);
else if (credId) createArgs.push('--proxy-credential', credId);
const created = run(createArgs);
const pid = created.data.id;
console.log(`  created profile ${pid} (${name})`);

let launched;
try {
  launched = run(['cloak', 'launch', pid, '--json']);
  console.log(`  launched (VNC ${launched.data.vnc_ws_port})`);
} catch (e) {
  if (doDelete) execFileSync('bdg', ['cloak', 'delete', pid], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 15000 });
  throw e;
}

// connect bdg to it (non-JSON; reads text, but that's fine)
execFileSync('bdg', ['cloak', 'connect', pid], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });

// --- inject (scoped to the 34-cookie Google session only) ---
// Reference = the 33 unique (name, domain) pairs of a complete signed-in Google
// session (34 cookie rows; COMPASS appears under two paths). Only cookies matching
// a reference pair are injected; the rest of the jar (ads trackers, other sites)
// is ignored.
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
function isRefCookieGoogle(c) {
  const d = String(c.domain || '').toLowerCase();
  return REF.some(([n, rd]) =>
    c.name === n && (d === rd || d === rd.replace(/^\./, '') || '.' + d === rd)
  );
}
// Yahoo auth: primary session cook is SID, tied together by AS/Y/T on .yahoo.com
const YAHOO_CORE = ['SID', 'AS', 'Y', 'T'];
const YAHOO_ALL = new Set(['SID', 'AS', 'Y', 'T', 'YP', 'Y1', 'Y3', 'PH', 'GUC', 'A3', 'IMP', 'IMPRESSION_PROCESSOR', 'ap', 'b', 'c', 'gid', 'Resed', 'sst', 'thx', 'BBTH', 'auid']);
function yahooIsRef(c) {
  return YAHOO_ALL.has(c.name) && /yahoo/.test(String(c.domain || ''));
}
// Microsoft: auth lives in ESTSAUTHPERSISTENT (login.microsoftonline.com); inject
// the whole microsoft-family cookie set so the SSO redirect chain can replay.
const MS_DOMAIN = /(live\.com|outlook|microsoft|msn\.com|office\.com|cloud\.microsoft)/;
function microsoftIsRef(c) {
  return MS_DOMAIN.test(String(c.domain || ''));
}
// select injection filter by provider (Google = strict 33-pair REF, Yahoo = name-by-domain)
const isRefCookie = provider === 'yahoo' ? yahooIsRef : provider === 'microsoft' ? microsoftIsRef : isRefCookieGoogle;

const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const raw = (s.cookies || []).filter(isRefCookie);
const cookies = raw.map((c) => {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
  if (c.expires !== undefined && c.expires !== -1) out.expires = c.expires;
  if (c.httpOnly !== undefined) out.httpOnly = c.httpOnly;
  if (c.secure !== undefined) out.secure = c.secure;
  return out;
});

const CHUNK = 300;
let ok = 0;
for (let i = 0; i < cookies.length; i += CHUNK) {
  cdp('Network.setCookies', { cookies: cookies.slice(i, i + CHUNK) });
  ok += Math.min(CHUNK, cookies.length - i);
  process.stdout.write(`  injected ${String(ok).padStart(cookies.length.toString().length)}/${cookies.length}\r`);
}
console.log(`\nInjected ${ok} cookies.`);

// --- session health check ---
// Navigate to a Google endpoint and classify the cookie session's auth state.
// A reused session that was logged out server-side still injects fine but Google
// shows the account on the chooser as "Signed out" -> session is DEAD.
async function detectGoogleState() {
  const checkUrl = url || 'https://accounts.google.com/';
  cdp('Page.navigate', { url: checkUrl });

  let title = '', finalUrl = '', body = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(5000);
    try {
      const ev = cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({title:document.title,url:location.href,body:(document.body?.innerText||"").slice(0,500)})',
        returnByValue: true,
      });
      const val = ev.data?.result?.result?.value;
      if (val && val.length > 10) {
        const p = JSON.parse(val);
        ({ title, body } = p);
        finalUrl = p.url;
        // A transient error page is not a verdict — retry after a reload.
        if (/Error [0-9]/.test(title) || /Error [0-9]/.test(body)) {
          await sleep(2000);
          cdp('Page.navigate', { url: checkUrl });
          continue;
        }
        if (title || body) break;
      }
    } catch {}
  }

  let status, detail;
  const low = body.toLowerCase();
  if (/myaccount\.google/.test(finalUrl) || (/Google Account/i.test(title) && !/sign|signed out/i.test(body))) {
    status = 'alive';
    detail = title;
  } else if (/signed out|Choose an account/i.test(body) && !/enter your password|sign in to continue|password/i.test(low) && !/myaccount/i.test(finalUrl)) {
    // Account is present (cookies recognized) but Google reports it Signed out.
    status = 'dead';
    detail = 'Account recognized but signed out (cookies revoked/expired)';
  } else if (/enter your password|sign in to continue|recovery|2-step|two-step|verify it.s you|challenge/i.test(low)) {
    status = 'challenged';
    detail = 'Google requires password / 2-step verification';
  } else if (/unusual traffic|not a robot|captcha/i.test(low)) {
    status = 'captcha';
    detail = 'CAPTCHA / bot detection triggered';
  } else {
    status = 'unknown';
    detail = title || finalUrl || body.slice(0, 80) || 'Page did not load';
  }
  return { status, detail, url: finalUrl };
}

// Yahoo health check: a valid session loads the mailbox at mail.yahoo.com (the
// SPA renders a Compose button). Dead/invalid cookies redirect to login.yahoo.com.
async function detectYahooState() {
  const checkUrl = url || 'https://mail.yahoo.com/';
  cdp('Page.navigate', { url: checkUrl });

  const WAIT = 8000;
  const TRIES = 6; // up to ~48s for the SPA to render the mailbox
  let title = '', body = '', finalUrl = '';
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    await sleep(WAIT);
    try {
      const ev = cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({title:document.title,url:location.href,ready:document.readyState,body:(document.body?.innerText||"").slice(0,1200)})',
        returnByValue: true,
      });
      const val = ev.data?.result?.result?.value;
      if (val && val.length > 10) {
        const p = JSON.parse(val);
        ({ title, body } = p);
        finalUrl = p.url;
        const ready = p.ready || '';
        const u = finalUrl.toLowerCase();
        const low = body.toLowerCase();
        if (/Error [0-9]|504|502|gateway/i.test(title) || /Error [0-9]/i.test(body)) {
          await sleep(2000);
          cdp('Page.navigate', { url: checkUrl });
          continue;
        }
        // Definitive states: mailbox rendered (Compose) or kicked to the login page.
        // Otherwise keep waiting for the SPA so a slow mailbox isn't misread as DEAD.
        if (/\bcompose\b/.test(low)) break;
        if (/login\.yahoo\.com/.test(u)) break;
        if (ready === 'complete' && body.trim().length > 20 && attempt >= TRIES) break;
      }
    } catch {}
  }

  // One last settle window if the page never produced body content (slow shell).
  if (!body.trim()) {
    await sleep(WAIT);
    try {
      const ev = cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({title:document.title,url:location.href,body:(document.body?.innerText||"").slice(0,1200)})',
        returnByValue: true,
      });
      const val = ev.data?.result?.result?.value;
      if (val && val.length > 10) { const p = JSON.parse(val); title = p.title; body = p.body; finalUrl = p.url; }
    } catch {}
  }

  let status, detail;
  const u = finalUrl.toLowerCase();
  const low = body.toLowerCase();
  if (/captcha|not a robot|unusual (traffic|activity)/i.test(low)) {
    status = 'captcha';
    detail = 'CAPTCHA / bot detection triggered';
  } else if (/\bcompose\b/.test(low) || (/mail\.yahoo/.test(u) && !/login/.test(u))) {
    status = 'alive';
    detail = 'Mailbox loaded (Compose visible)';
  } else if (/login\.yahoo\.com/.test(u) || /sign in to continue to yahoo mail|continue to yahoo mail|create account/i.test(low)) {
    if (/enter your password|verification code|two-step|2-step|protect your account|security check|recovery/i.test(low) && !/create account/i.test(low)) {
      status = 'challenged';
      detail = 'Yahoo requires password / 2FA';
    } else {
      status = 'dead';
      detail = 'Redirected to Yahoo sign-in (cookies not valid)';
    }
  } else {
    status = 'unknown';
    detail = title || finalUrl || body.slice(0, 100) || 'Page did not load';
  }
  return { status, detail, url: finalUrl };
}

async function detectMicrosoftState() {
  const checkUrl = url || 'https://outlook.live.com/mail/';
  const WAIT = 10000;
  const TRIES = 8; // up to ~80s for the SSO chain + mailbox SPA
  cdp('Page.navigate', { url: checkUrl });

  let title = '', body = '', finalUrl = '';
  let seenLogin = 0; // consecutive ticks showing a real sign-in form (SSO hops won't)
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    await sleep(WAIT);
    try {
      const ev = cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({title:document.title,url:location.href,ready:document.readyState,body:(document.body?.innerText||"").slice(0,1400)})',
        returnByValue: true,
      });
      const val = ev.data?.result?.result?.value;
      if (val && val.length > 10) {
        const p = JSON.parse(val);
        ({ title, body } = p);
        finalUrl = p.url;
        const ready = p.ready || '';
        const u = finalUrl.toLowerCase();
        const low = body.toLowerCase();
        if (/Error [0-9]|504|502|gateway/i.test(title) || /Error [0-9]/i.test(body)) {
          await sleep(2000);
          cdp('Page.navigate', { url: checkUrl });
          seenLogin = 0;
          continue;
        }
        // Mailbox rendered -> alive (ONLY the real webmail hosts count)
        const mailboxUrl = /outlook\.live\.com\/(mail|calendar|people)/.test(u) || /outlook\.office\.com\/mail/.test(u);
        const mailboxBody = /\bnew mail\b|\bfolders\b|\bdrafts\b|\binbox\b/.test(low);
        if (mailboxUrl && mailboxBody) break;
        // Signed-out terminal states: Microsoft's Outlook landing page (www.microsoft.com
        // .../outlook?deeplink=/mail/) is what outlook.live.com/mail redirects to when
        // the cookie session is not accepted — treat as final DEAD once it has content.
        if (/www\.microsoft\.com/.test(u) && /outlook|deeplink/.test(u)) {
          if (body.trim().length > 20) break;
        }
        // Sign-in is only FINAL if the actual form renders (SSO hops through
        // login.live.com carry no email field and auto-redirect within a tick)
        const onLogin = /login\.(live|microsoftonline)\.com/.test(u);
        const hasForm = /no account\? create one|email, phone, or skype|sign in to continue/i.test(low);
        if (onLogin && hasForm) {
          seenLogin++;
          if (seenLogin >= 2) break;
        } else if (!onLogin) {
          seenLogin = Math.max(0, seenLogin - 1);
        }
        if (ready === 'complete' && body.trim().length > 20 && attempt >= TRIES) break;
      }
    } catch {}
  }

  if (!body.trim()) {
    await sleep(WAIT);
    try {
      const ev = cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({title:document.title,url:location.href,body:(document.body?.innerText||"").slice(0,1400)})',
        returnByValue: true,
      });
      const val = ev.data?.result?.result?.value;
      if (val && val.length > 10) { const p = JSON.parse(val); title = p.title; body = p.body; finalUrl = p.url; }
    } catch {}
  }

  let status, detail;
  const u = (finalUrl || '').toLowerCase();
  const low = body.toLowerCase();
  if (/captcha|not a robot|unusual (traffic|activity)/i.test(low)) {
    status = 'captcha';
    detail = 'CAPTCHA / bot detection triggered';
  } else if (/outlook\.live\.com\/(mail|calendar|people)/.test(u) || /outlook\.office\.com\/mail/.test(u)) {
    if (/\bnew mail\b|\bfolders\b|\bdrafts\b|\binbox\b/.test(low)) {
      status = 'alive';
      detail = 'Mailbox loaded (Outlook UI visible)';
    } else {
      status = 'unknown';
      detail = `On webmail host but mailbox not rendered: ${finalUrl}`;
    }
  } else if (/login\.(live|microsoftonline)\.com/.test(u)) {
    if (/enter your password|two-step|2-step|verification|protect your account|help us protect|recovery/i.test(low)) {
      status = 'challenged';
      detail = 'Microsoft requires password / 2FA';
    } else {
      status = 'dead';
      detail = 'Landed on Microsoft sign-in (cookies not valid)';
    }
  } else if (/www\.microsoft\.com/.test(u) && /outlook|deeplink/.test(u)) {
    status = 'dead';
    detail = 'Redirected to Outlook landing page (cookies not accepted)';
  } else {
    status = 'unknown';
    detail = title || finalUrl || body.slice(0, 100) || 'Page did not load';
  }
  return { status, detail, url: finalUrl };
}

if (!noCheck) {
  console.log('\nChecking session health ...');
  const r = provider === 'yahoo' ? await detectYahooState() : provider === 'microsoft' ? await detectMicrosoftState() : await detectGoogleState();
  const icon = r.status === 'alive' ? '✅ ALIVE' : r.status === 'dead' ? '💀 DEAD' : r.status === 'challenged' ? '⚠️ CHALLENGED' : r.status === 'captcha' ? '🤖 CAPTCHA' : '❓ UNKNOWN';
  console.log(`${icon}: ${r.detail}`);
}

console.log(`\nProfile ${pid} is ready. Keep it connected (VNC:${launched.data.vnc_ws_port}); stop later with: bdg cloak stop ${pid}`);
if (doDelete) {
  // disconnect first so delete can stop cleanly; delete prints human text (not JSON)
  console.log(`\nDeleting scratch profile ${pid}...`);
  try {
    execFileSync('bdg', ['cloak', 'delete', pid], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 15000 });
  } catch (e) {
    const msg = (e.stderr || '').toString().trim();
    throw new Error(`Failed to delete profile ${pid}: ${msg || e.message}`);
  }
  console.log('Deleted.');
}