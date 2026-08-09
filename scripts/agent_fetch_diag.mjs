import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(8000); // mimic typing delay
await page.click('input#P101_USERNAME'); await page.type('input#P101_USERNAME', 'ZZZZ', { delay: 40 });
await page.waitForTimeout(2000);
const result = await page.evaluate(async () => {
  const src = document.querySelector('img[src*=get_image]').src;
  try {
    const r = await fetch(src, { credentials: 'include' });
    const b = await r.blob();
    return { ok: true, status: r.status, type: b.type, size: b.size };
  } catch (e) { return { ok: false, err: String(e) }; }
});
console.log('in-page fetch:', JSON.stringify(result));
await browser.close();
