import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const [uid, pwd] = process.argv[2].split(':');
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const posts = [];
page.on('request', r => { if (r.method() === 'POST' && /gateway/.test(r.url())) posts.push({ url: r.url().slice(0, 120), post: (r.postData() || '').slice(0, 120) }); });
page.on('response', async r => { if (/oauth2\/token/.test(r.url())) { try { console.log('TOKEN RESP', r.status()); } catch {} } });
await page.goto('https://citytouch.com.bd/', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
await page.click('input[name="User ID"]'); await page.type('input[name="User ID"]', uid, { delay: 40 });
await page.click('input[name="Password"]'); await page.type('input[name="Password"]', pwd, { delay: 40 });
await page.click('button:has-text("Login")');
await page.waitForTimeout(8000);
const dom = await page.evaluate(() => ({
  url: location.href,
  inputs: [...document.querySelectorAll('input')].map(i => ({ name: i.name, id: i.id, type: i.type, placeholder: i.placeholder })),
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim().slice(0, 40)).filter(Boolean).slice(0, 8),
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
}));
console.log('DEVICE SCREEN:', JSON.stringify(dom, null, 1));
console.log('POSTS:', JSON.stringify(posts, null, 1));
await page.screenshot({ path: '/tmp/citytouch_device.png' });
await browser.close();
