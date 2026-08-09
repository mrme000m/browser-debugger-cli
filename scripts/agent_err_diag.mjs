import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const [uid, pwd] = process.argv[2].split(':');
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3000);
// captcha via live imgs
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
    { type: 'text', text: 'Five captcha character images side by side. Output ONLY the 5 characters, no spaces.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }], max_tokens: 20 }),
});
const code = String((await vr.json())?.choices?.[0]?.message?.content).replace(/[^A-Za-z0-9]/g, '');
console.log('captcha code:', JSON.stringify(code));
await page.fill('input#P101_USERNAME', uid); await page.fill('input#P101_PASS', pwd); await page.fill('input#P101_CAPTCHA', code);
await page.click('button:has-text("Login")');
await page.waitForTimeout(7000);
const out = await page.evaluate(() => ({
  url: location.href,
  alerts: [...document.querySelectorAll('.t-Alert, .alert, #apexError, [role=alert], .a-Notification, .notification')].map(a => a.innerText.replace(/\s+/g, ' ').slice(0, 200)),
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  inputs: [...document.querySelectorAll('input')].map(i => i.name + '=' + i.value.slice(0, 20)),
}));
console.log('AFTER:', JSON.stringify(out, null, 1));
await browser.close();
