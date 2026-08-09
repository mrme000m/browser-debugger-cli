// Probe bankasia login via logInSubmit.do with cleartext captcha code
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const [userID, password] = process.argv[2].split(':');
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const log = [];
page.on('request', r => { const u = r.url(); if (u.includes('bankasia') && r.resourceType() !== 'image' && r.resourceType() !== 'font' && r.resourceType() !== 'stylesheet') log.push({ t: 'req', m: r.method(), url: u.slice(0, 130), post: (r.postData() || '').slice(0, 250) }); });
page.on('response', async r => { const u = r.url(); if (u.includes('bankasia') && r.request().resourceType() === 'document') log.push({ t: 'doc', status: r.status(), url: u.slice(0, 130) }); });

await page.goto('https://mybank.bankasia-bd.com/mybank/logIn.do', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);

// read the embedded captcha code
const capchaCode = await page.evaluate(() => document.querySelector('input[name=capchaCode]')?.value || '');
console.log('embedded capchaCode:', capchaCode);

await page.fill('input[name=userID]', userID);
await page.fill('input[name=password]', password);
await page.fill('input[name=capchaText]', capchaCode);

// submit exactly like doSignIn: action -> logInSubmit.do
await page.evaluate(() => { document.logInForm.action = '/mybank/logInSubmit.do'; document.logInForm.submit(); });
await page.waitForTimeout(8000);

console.log('URL after submit:', page.url());
const result = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  errorCode: document.querySelector('input[name=errorCode]')?.value,
  errorMessage: document.querySelector('input[name=errorMessage]')?.value,
  capchaCode: document.querySelector('input[name=capchaCode]')?.value,
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
}));
console.log('RESULT:', JSON.stringify(result, null, 1));
const fs = await import('node:fs');
fs.writeFileSync('/tmp/bankasia_probe.json', JSON.stringify({ capchaCode, log, result }, null, 1));
await browser.close();
