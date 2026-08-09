import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const posts = [];
page.on('request', r => { if (r.method() === 'POST') posts.push(r.url().split('/').pop().split('?')[0]); });
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3500);
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const typeField = async (sel, text) => { await page.click(sel); await sleep(rand(150, 450)); await page.type(sel, text, { delay: rand(20, 70) }); };
await typeField('input#P101_USERNAME', 'RANA85');
await sleep(400);
await typeField('input#P101_PASS', 'BSs3022');
await sleep(500);
// read captcha like the script does
const b64 = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img[src*=get_image]')];
  const cell = 140; const c = document.createElement('canvas'); c.width = cell * imgs.length; c.height = cell;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  imgs.forEach((img, i) => x.drawImage(img, i * cell + (cell - img.width) / 2, (cell - img.height) / 2, img.width, img.height));
  return c.toDataURL('image/png').split(',')[1];
});
const vr = await fetch('https://api.mistral.ai/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.MISTRAL_API_KEY },
  body: JSON.stringify({ model: 'pixtral-12b-2409', messages: [{ role: 'user', content: [
    { type: 'text', text: 'Five captcha character images side by side. Output ONLY the 5 characters exactly.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }], max_tokens: 20 }),
});
const code = String((await vr.json())?.choices?.[0]?.message?.content).replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
console.log('code:', code);
await typeField('input#P101_CAPTCHA', code);
await sleep(1000);
console.log('clicking #login...');
await page.click('button#login');
await sleep(6000);
console.log('POSTs:', JSON.stringify(posts));
const st = await page.evaluate(() => ({ url: location.href, err: (document.body.innerText.match(/error has occurred[^.]+/i) || [''])[0], captchaVal: document.querySelector('#P101_CAPTCHA')?.value }));
console.log('STATE:', JSON.stringify(st));
await browser.close();
