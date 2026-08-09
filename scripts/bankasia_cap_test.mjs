import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://mybank.bankasia-bd.com/mybank/logIn.do', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[name=userID]', 'xxtestxx');
await page.fill('input[name=password]', 'xxtestxx');
await page.fill('input[name=capchaText]', 'WRONGCODE');
await page.evaluate(() => { document.logInForm.action = '/mybank/logInSubmit.do'; document.logInForm.submit(); });
await page.waitForTimeout(7000);
const r = await page.evaluate(() => ({
  url: location.href,
  errorCode: document.querySelector('input[name=errorCode]')?.value,
  errorMessage: document.querySelector('input[name=errorMessage]')?.value,
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
}));
console.log('WRONG-CAPTCHA RESULT:', JSON.stringify(r, null, 1));
await browser.close();
