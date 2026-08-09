import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const btns = await page.evaluate(() => [...document.querySelectorAll('button, input[type=button], input[type=submit], a.btn, .t-Button')].map(b => ({
  tag: b.tagName, type: b.type || '', id: b.id || '', cls: b.className.slice(0, 50),
  text: (b.innerText || b.value || b.textContent || '').trim().slice(0, 30),
  vis: !!(b.offsetWidth || b.offsetHeight),
})).filter(b => b.vis));
console.log('BUTTONS:', JSON.stringify(btns, null, 1));
// is there a form submit mechanism? check the login button onclick
const js = await page.evaluate(() => [...document.querySelectorAll('button, input[type=button]')].map(b => ({ tag: b.tagName, onclick: b.getAttribute('onclick') || '' })));
console.log('ONCLICKS:', JSON.stringify(js));
await browser.close();
