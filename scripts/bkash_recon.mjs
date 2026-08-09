// Recon: load bkash merchant portal login in Firefox, dump structure
import { firefox } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';

const URL = 'https://merchantportal.bkash.com/login';
const browser = await firefox.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const reqLog = [];
page.on('request', r => {
  if (r.resourceType() !== 'image' && r.resourceType() !== 'font')
    reqLog.push({ m: r.method(), url: r.url().slice(0, 160) });
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000); // let SPA settle

console.log('TITLE:', await page.title());
console.log('FINAL URL:', page.url());

// All inputs
const inputs = await page.evaluate(() =>
  [...document.querySelectorAll('input, select, textarea')].map(el => ({
    tag: el.tagName, type: el.type || '', id: el.id, name: el.name,
    placeholder: el.placeholder || '', cls: (el.className + '').slice(0, 60),
    visible: !!(el.offsetWidth || el.offsetHeight),
  }))
);
console.log('\nINPUTS:', JSON.stringify(inputs, null, 1));

// Buttons / clickable submit
const buttons = await page.evaluate(() =>
  [...document.querySelectorAll('button, [role=button], input[type=submit], a.btn, .btn')].map(el => ({
    tag: el.tagName, text: (el.textContent || el.value || '').trim().slice(0, 50),
    id: el.id, cls: (el.className + '').slice(0, 60), type: el.type || '',
  })).filter(b => b.text || b.id)
);
console.log('\nBUTTONS:', JSON.stringify(buttons, null, 1));

// Text snippets that hint at auth flow
const text = await page.evaluate(() => document.body.innerText.slice(0, 2500));
console.log('\nBODY TEXT:\n', text);

// Form actions
const forms = await page.evaluate(() =>
  [...document.querySelectorAll('form')].map(f => ({ action: f.action, method: f.method, id: f.id }))
);
console.log('\nFORMS:', JSON.stringify(forms));

await page.screenshot({ path: '/tmp/bkash_login.png', fullPage: false });
console.log('\nREQUESTS:');
for (const r of reqLog) console.log(r.m, r.url);
console.log('\nREQ COUNT:', reqLog.length);

await browser.close();
