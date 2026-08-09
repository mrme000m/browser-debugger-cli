// Grab fresh captcha image + ground-truth code from live page, then Mistral OCR
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://mybank.bankasia-bd.com/mybank/logIn.do', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2000);

const truth = await page.evaluate(() => {
  const img = document.querySelector('#GSDigit1');
  const src = img?.getAttribute('src') || '';
  return { code: document.querySelector('input[name=capchaCode]')?.value, b64: src.replace(/^data:image\/[^;]+;base64,/, '') };
});
console.log('ground truth code:', truth.code, '| img bytes:', truth.b64.length);
await import('node:fs').then(fs => fs.promises.writeFile('/tmp/ba_cap_live.png', Buffer.from(truth.b64, 'base64')));

// Mistral OCR
const key = process.env.MISTRAL_API_KEY || 'TLlIUOIuh6tcApbkjKg61iB3nj6LrwEm';
const resp = await fetch('https://api.mistral.ai/v1/ocr', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
  body: JSON.stringify({ model: 'mistral-ocr-latest', document: { type: 'image_url', image_url: 'data:image/png;base64,' + truth.b64 } }),
});
const data = await resp.json();
const text = JSON.stringify(data).slice(0, 600);
console.log('OCR status:', resp.status);
console.log('OCR response:', text);
// try to extract code from markdown
const md = data?.pages?.[0]?.markdown || '';
const m = md.match(/([A-Za-z0-9]{5,8})/);
console.log('markdown:', JSON.stringify(md));
console.log('MATCH:', m ? m[1] : 'none', '| truth:', truth.code, '| match?', m && m[1] === truth.code);
await browser.close();
