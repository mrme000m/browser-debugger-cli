import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3500);
const b64 = await page.evaluate(async () => {
  const imgs = [...document.querySelectorAll('img[src*=get_image]')].map(i => i.src);
  const loads = await Promise.all(imgs.map(async src => {
    const r = await fetch(src); const url = URL.createObjectURL(await r.blob());
    const img = new Image(); await new Promise(res => { img.onload = res; img.src = url; });
    return img;
  }));
  const cell = 140;
  const c = document.createElement('canvas'); c.width = cell * loads.length; c.height = cell;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  loads.forEach((img, i) => x.drawImage(img, i * cell + (cell - img.width) / 2, (cell - img.height) / 2, img.width, img.height));
  return c.toDataURL('image/png').split(',')[1];
});
const key = process.env.MISTRAL_API_KEY;
const url = 'data:image/png;base64,' + b64;
// vision read
const vr = await fetch('https://api.mistral.ai/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
  body: JSON.stringify({ model: 'pixtral-12b-2409', messages: [{ role: 'user', content: [
    { type: 'text', text: 'Five captcha character images side by side. Output ONLY the 5 characters, no spaces, no explanation.' },
    { type: 'image_url', image_url: { url } }] }], max_tokens: 20 }),
});
const vj = await vr.json();
let code = String(vj.choices?.[0]?.message?.content).replace(/\s+/g, '');
console.log('vision code:', JSON.stringify(code));
// try submit with fake creds: "Invalid Login Credentials" => captcha passed
await page.fill('input#P101_USERNAME', 'ZZZZ9999');
await page.fill('input#P101_PASS', 'ZZZZ9999');
if (code) await page.fill('input#P101_CAPTCHA', code);
await page.click('button:has-text("Login")');
await page.waitForTimeout(7000);
const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
console.log('RESULT:', t.includes('Invalid Login Credentials') ? 'CAPTCHA PASSED (creds rejected)' : t.includes('Verification Code') ? 'CAPTCHA WRONG' : t.slice(0, 200));
await browser.close();
