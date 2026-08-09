// bkash login flow on LOCAL Playwright Chromium (real Dhaka IP)
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';

const [email, password] = (process.argv[2] || '').split(':');
const OUT = '/tmp/bkash_flow.json';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: process.env.BROWSER === 'cloak' ? CLOAK : undefined });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await ctx.newPage();

const events = [];
page.on('request', r => {
  const u = r.url();
  if (u.includes('merchantportal.bkash.com/api') || u.includes('api.merchantportal') || u.includes('mrportal'))
    events.push({ t: 'req', m: r.method(), url: u, post: (r.postData() || '').slice(0, 1000) });
});
page.on('response', async r => {
  const u = r.url();
  if (u.includes('merchantportal.bkash.com/api') || u.includes('api.merchantportal') || u.includes('mrportal')) {
    let body = '';
    try { body = await r.text(); } catch (e) { body = 'ERR ' + e.message.slice(0, 60); }
    events.push({ t: 'resp', status: r.status(), url: u, body: body.slice(0, 3000) });
  }
});
page.on('requestfailed', r => { if (r.url().includes('api.merchantportal')) events.push({ t: 'fail', url: r.url().slice(0, 130), err: r.failure()?.errorText }); });
page.on('framenavigated', f => { if (f === page.mainFrame()) events.push({ t: 'nav', url: f.url() }); });

await page.goto('https://merchantportal.bkash.com/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(4000);
await page.fill('input[name=email]', email);
await page.fill('input[name=password]', password);

console.log('waiting for captcha (Turnstile) to resolve — button enable...');
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Log In'));
  return b && !b.disabled;
}, { timeout: 240000 }).then(() => console.log('button enabled')).catch(() => console.log('button stayed disabled'));

await page.waitForTimeout(1000);
await page.locator('button:has-text("Log In")').click();
console.log('clicked Log In — watching 20s of traffic...');
await page.waitForTimeout(20000);

let state = { url: page.url() };
try {
  state = await page.evaluate(() => ({
    url: location.href, title: document.title,
    toasts: [...document.querySelectorAll('[class*=toast], [role=alert], [class*=error-message], p, span')]
      .map(el => (el.textContent || '').trim()).filter(Boolean).filter(t => t.length < 250).slice(0, 12),
  }));
} catch (e) { state.err = e.message; }
events.push({ t: 'state', ...state });

const fs = await import('node:fs');
fs.writeFileSync(OUT, JSON.stringify(events, null, 1));
console.log('\n=== FLOW ===');
for (const e of events) {
  if (e.t === 'req') console.log('REQ ', e.m, e.url.slice(0, 110), e.post ? '| post: ' + e.post.slice(0, 100) : '');
  else if (e.t === 'resp') console.log('RESP', e.status, e.url.slice(0, 110), '|', e.body.slice(0, 100).replace(/\n/g, ' '));
  else if (e.t === 'fail') console.log('FAIL', e.url, '|', e.err);
  else if (e.t === 'nav') console.log('NAV ', e.url);
  else if (e.t === 'state') console.log('STATE url:', state.url, '| toasts:', JSON.stringify(state.toasts));
}
console.log('\nfull: ' + OUT);
await new Promise(r => setTimeout(r, 20000));
await browser.close();
