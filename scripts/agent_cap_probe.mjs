import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const cap = await page.evaluate(() => {
  const el = document.querySelector('#P101_CAPTCHA');
  const container = document.querySelector('#P101_CAPTCHA_CONTAINER, [data-id=P101_CAPTCHA], [id*=CAPTCHA]');
  const c = el?.parentElement?.parentElement;
  return {
    itemExists: !!el,
    itemVisible: !!el && !!(el.offsetWidth || el.offsetHeight),
    itemType: el?.type,
    containerHTML: (container || c || document.body).innerHTML.slice(0, 600),
    pageHTML: document.body.innerHTML.slice(0, 200),
  };
});
console.log('CAPTCHA:', JSON.stringify(cap, null, 1));
// find any img with captcha-ish source in whole doc
const imgs = await page.evaluate(() => [...document.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 100), w: i.width, h: i.height, vis: !!(i.offsetWidth || i.offsetHeight) })).filter(i => i.w > 0 || i.h > 0));
console.log('IMGS:', JSON.stringify(imgs, null, 1));
await page.screenshot({ path: '/tmp/agent_login.png' });
await browser.close();
