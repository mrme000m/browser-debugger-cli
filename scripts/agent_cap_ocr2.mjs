import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const browser = await chromium.launch({ headless: false, executablePath: CLOAK, args: ['--window-size=1440,900'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://agent.bankasia-bd.com:8089/emob/f?p=106:101::::::', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3500);
const b64s = await page.evaluate(async () => {
  const imgs = [...document.querySelectorAll('img[src*=get_image]')].map(i => ({ src: i.src, cls: i.className, id: i.id }));
  const out = [];
  for (const im of imgs) {
    const r = await fetch(im.src); const b = await r.blob();
    const url = URL.createObjectURL(b);
    const img = new Image();
    await new Promise(res => { img.onload = res; img.src = url; });
    const cell = 160;
    const c = document.createElement('canvas'); c.width = cell; c.height = cell;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cell, cell);
    x.drawImage(img, (cell - img.width) / 2, (cell - img.height) / 2, img.width, img.height);
    out.push({ meta: im, b64: c.toDataURL('image/png').split(',')[1] });
  }
  return out;
});
const key = process.env.MISTRAL_API_KEY;
for (let i = 0; i < b64s.length; i++) {
  const { meta, b64 } = b64s[i];
  const resp = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: 'mistral-ocr-latest', document: { type: 'image_url', image_url: 'data:image/png;base64,' + b64 } }),
  });
  const j = await resp.json();
  console.log(`img ${i}: pos=${meta.src.match(/p_position=(\d)/)?.[1]} id=${meta.id} cls="${meta.cls}" -> OCR: ${JSON.stringify(j.pages?.[0]?.markdown)}`);
}
await browser.close();
