import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const net = [];
page.on('request', r => { if (r.method() === 'POST') net.push({ m: 'POST', u: r.url().slice(0, 150), d: (r.postData() || '').slice(0, 250).replace(/\n/g, ' ') }); });
page.on('response', r => { if (r.status() >= 400 || /login|auth|session/i.test(r.url())) net.push({ m: 'RESP', u: r.url().slice(0, 150), st: r.status() }); });
page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('NAV', f.url().slice(0, 120)); });

await page.goto('https://portal.alpha.net.bd/clientarea/', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);
const dom = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  forms: [...document.querySelectorAll('form')].map(f => ({
    action: f.action, method: f.method, id: f.id,
    inputs: [...f.querySelectorAll('input, select, button')].map(i => ({ t: i.tagName, type: i.type, id: i.id, name: i.name, placeholder: (i.placeholder || '').slice(0, 40), value: (i.value || '').slice(0, 20) })).slice(0, 20),
  })),
  iframes: [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 80)),
  links: [...document.querySelectorAll('a')].map(a => (a.href || '').replace(location.origin, '')).filter(h => h && h !== '#').slice(0, 30),
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  cookieNames: document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean),
  scripts: [...document.querySelectorAll('script[src]')].map(s => s.src.split('/').pop()).slice(0, 15),
}));
console.log('DOM:', JSON.stringify(dom, null, 1));
console.log('NET:', JSON.stringify(net, null, 1));
await browser.close();
