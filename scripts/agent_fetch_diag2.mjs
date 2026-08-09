import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(8000);
await page.click('input#P101_USERNAME'); await page.type('input#P101_USERNAME', 'ZZZZ', { delay: 40 });
const result = await page.evaluate(async () => {
  const imgs = [...document.querySelectorAll('img[src*=get_image]')];
  if (!imgs.length) return { ok: false, err: 'no imgs' };
  const cell = 140;
  const c = document.createElement('canvas'); c.width = cell * imgs.length; c.height = cell;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  imgs.forEach((img, i) => x.drawImage(img, i * cell + (cell - img.width) / 2, (cell - img.height) / 2, img.width, img.height));
  return { ok: true, n: imgs.length, sizes: imgs.map(i => i.width + 'x' + i.height), b64len: c.toDataURL('image/png').split(',')[1].length };
});
console.log('composite from live imgs:', JSON.stringify(result));
await browser.close();
