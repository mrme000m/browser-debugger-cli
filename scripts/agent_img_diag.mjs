import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('framenavigated', f => console.log('NAVIGATED:', f.url().slice(0, 100)));
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3500);
const src = await page.evaluate(() => document.querySelector('img[src*=get_image]').src);
console.log('img src:', src.slice(0, 120));
const resp = await ctx.request.get(src);
console.log('status:', resp.status(), '| ct:', resp.headers()["content-type"] || "", '| len:', (await resp.body()).length);
const ct = resp.headers()["content-type"] || "" || '';
if (!ct.includes('image')) console.log('BODY PREVIEW:', (await resp.text()).slice(0, 200));
// now check page still alive
try { await page.evaluate(() => 1 + 1); console.log('page context alive'); } catch (e) { console.log('page context DEAD:', e.message.slice(0, 80)); }
await browser.close();
