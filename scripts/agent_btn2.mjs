import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const info = await page.evaluate(() => {
  const all = [...document.querySelectorAll('button, input[type=button], input[type=submit], [onclick]')];
  return all.map(b => ({
    tag: b.tagName, id: b.id || '', type: b.type || '', cls: (b.className || '').slice(0, 40),
    text: (b.innerText || b.value || '').trim().slice(0, 25),
    onclick: (b.getAttribute('onclick') || '').slice(0, 80),
    vis: !!(b.offsetWidth || b.offsetHeight),
    rect: b.getBoundingClientRect().width > 0 ? `${Math.round(b.getBoundingClientRect().x)},${Math.round(b.getBoundingClientRect().y)} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}` : '',
  }));
});
console.log(JSON.stringify(info, null, 1));
// check for overlay elements covering the login button
const cov = await page.evaluate(() => {
  const btn = document.querySelector('#login');
  if (!btn) return 'no #login';
  const r = btn.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return { topTag: top.tagName, topId: top.id || '', topCls: (top.className || '').slice(0, 50), topText: (top.innerText || '').trim().slice(0, 20) };
});
console.log('COVERING:', JSON.stringify(cov));
await browser.close();
