import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const [uid, pwd] = process.argv[2].split(':');
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('request', r => { if (r.method() === 'POST') console.log('POST', r.url().slice(0, 140), '|', (r.postData() || '').slice(0, 200).replace(/\n/g, ' ')); });
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const dom = await page.evaluate(() => ({
  url: location.href,
  recaptcha: !!document.querySelector('iframe[src*=recaptcha], .g-recaptcha, [data-sitekey]'),
  iframes: [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 80)),
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 250),
}));
console.log('DOM:', JSON.stringify(dom, null, 1));
await page.click('input#P101_USERNAME'); await page.type('input#P101_USERNAME', uid, { delay: 40 });
await page.click('input#P101_PASS'); await page.type('input#P101_PASS', pwd, { delay: 40 });
await page.waitForTimeout(500);
await page.click('button:has-text("Login")');
await page.waitForTimeout(8000);
const after = await page.evaluate(() => ({ url: location.href, bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) }));
console.log('AFTER:', JSON.stringify(after, null, 1));
await browser.close();
