import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const apis = [];
page.on('request', r => { const u = r.url(); if (/citytouch/.test(u) && r.resourceType() !== 'image' && r.resourceType() !== 'font') apis.push({ m: r.method(), url: u.slice(0, 160), post: (r.postData() || '').slice(0, 300) }); });
await page.goto('https://citytouch.com.bd/login', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(6000);
const dom = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  inputs: [...document.querySelectorAll('input')].map(i => ({ name: i.name, id: i.id, type: i.type, placeholder: i.placeholder })),
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim().slice(0, 40)).filter(Boolean).slice(0, 10),
  links: [...document.querySelectorAll('a')].map(a => a.innerText.trim().slice(0, 30)).filter(Boolean).slice(0, 10),
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
}));
console.log('DOM:', JSON.stringify(dom, null, 1));
console.log('\nAPIS:', JSON.stringify(apis.slice(-15), null, 1));
await new Promise(r => setTimeout(r, 30000)); // keep alive for manual look
await browser.close();
