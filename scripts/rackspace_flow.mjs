import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CDP = 'wss://clk.mrme.tech/api/profiles/912925dd-a2fc-48db-b364-0259330952cd/cdp';
const [u, p] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(CDP, { timeout: 30000, headers: { Authorization: 'Bearer change-me-to-a-secure-token' } });
const ctxs = browser.contexts();
const ctx = ctxs[0];
const page = await ctx.newPage();
const reqs = [];
page.on('request', r => { if (r.method() === 'POST') reqs.push({ url: r.url().slice(0, 90), postData: (r.postData() || '').slice(0, 200) }); });
page.on('response', r => { if (r.request().method() === 'POST') reqs[reqs.length - 1].status = r.status(); });
await page.goto('https://apps.rackspace.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
await page.fill('#user-input', u);
await page.waitForTimeout(500);
await page.fill('#pass-input', p);
await page.waitForTimeout(500);
await page.click('#form button, button:has-text("Log In")');
await page.waitForTimeout(9000);
console.log('FINAL URL:', page.url());
const st = await page.evaluate(() => ({
  body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  hasCaptcha: !!document.querySelector('img[src*=captcha], #captcha, [name*=captcha]'),
  inputs: [...document.querySelectorAll('input')].map(i => i.name + ':' + i.type).join(','),
}));
console.log('STATE:', JSON.stringify(st, null, 1));
console.log('POSTS:', JSON.stringify(reqs, null, 1));
await page.close();
await browser.close();
