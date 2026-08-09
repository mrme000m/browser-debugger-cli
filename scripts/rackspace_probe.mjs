import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CDP = 'wss://clk.mrme.tech/api/profiles/912925dd-a2fc-48db-b364-0259330952cd/cdp';
const browser = await chromium.connectOverCDP(CDP, { timeout: 30000, headers: { Authorization: 'Bearer change-me-to-a-secure-token' } });
const ctxs = browser.contexts();
console.log('contexts:', ctxs.length, ctxs.map(c => c.pages().map(p => p.url().slice(0, 60))));
let page = ctxs[0]?.pages().find(p => p.url() && !p.url().startsWith('devtools')) || ctxs[0]?.pages()[0];
if (!page) page = await ctxs[0].newPage();
console.log('current:', page.url());
await page.goto('https://apps.rackspace.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto err:', e.message.slice(0, 100)));
await page.waitForTimeout(6000);
console.log('AFTER NAV:', page.url());
const dump = await page.evaluate(() => ({
  title: document.title,
  inputs: [...document.querySelectorAll('input')].map(i => ({ id: i.id, name: i.name, type: i.type, placeholder: i.placeholder })),
  forms: [...document.querySelectorAll('form')].map(f => ({ action: f.action, method: f.method, id: f.id })),
  buttons: [...document.querySelectorAll('button, input[type=submit]')].filter(b => b.offsetWidth).map(b => ({ text: (b.innerText || b.value || '').trim().slice(0, 30), cls: (b.className || '').slice(0, 50) })),
  links: [...document.querySelectorAll('a')].filter(a => a.offsetWidth && a.href).map(a => a.textContent.trim().slice(0, 25) + ' -> ' + a.href.slice(0, 70)).slice(0, 12),
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 350),
}));
console.log(JSON.stringify(dump, null, 1));
await browser.close();
