import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';

const CDP = 'http://127.0.0.1:9222';

async function getPage() {
  return new Promise((res,rej)=>{
    const req=http.request(`${CDP}/json/new?about:blank`,{method:'PUT'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));});
    req.on('error',rej);req.end();
  });
}

const accounts = JSON.parse(fs.readFileSync('/tmp/bd_google_cookies.json','utf8'));

for (let i = 0; i < accounts.length; i++) {
  const acct = accounts[i];
  console.log(`\n━━━ [${i+1}/${accounts.length}] ${acct.email} ━━━`);

  // Fresh page per account (clean cookie jar)
  const page = await getPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
  let wk=0; const pend=new Map();
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
  const send=(method,params={})=>new Promise(res=>{const id=++wk;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});

  await send('Network.enable');
  await send('Page.enable');

  // First navigate to google.com to establish domain context for cookies
  await send('Page.navigate', {url: 'https://accounts.google.com'});
  await new Promise(r => setTimeout(r, 5000));

  // Set all Google auth cookies
  let setCount = 0;
  for (const c of acct.cookies) {
    try {
      await send('Network.setCookie', {
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
        path: c.path || '/',
        secure: c.secure || false,
        httpOnly: c.httpOnly || false,
        expires: c.expiry,
      });
      setCount++;
    } catch(e) {
      // cookie might be invalid for this domain
    }
  }
  console.log(`  Set ${setCount}/${acct.cookies.length} cookies`);

  // Navigate to Google account page to test session
  await send('Page.navigate', {url: 'https://myaccount.google.com/'});
  await new Promise(r => setTimeout(r, 8000));

  // Check if we're logged in (look for email on page, or check URL)
  const check = await send('Runtime.evaluate', {
    expression: `(() => {
      const url = location.href;
      // If redirected to login, session is dead
      if (url.includes('signin') || url.includes('ServiceLogin') || url.includes('accounts.google.com/signin')) {
        return 'DEAD: redirected to signin';
      }
      // Try to find the signed-in email
      const els = document.querySelectorAll('[data-is-touch-wrapper], [aria-label], [title]');
      let emailHint = '';
      // Look for avatar/account info
      const avatarImg = document.querySelector('img[src*="googleusercontent"], .gb_ya, [aria-label*="Account"], [alt*="Avatar"]');
      if (avatarImg) emailHint = ' (avatar found)';
      // Try the page title
      const title = document.title;
      return 'OK: ' + title.slice(0,80) + emailHint + ' | url=' + url.slice(0,60);
    })()`,
    returnByValue: true,
  });
  console.log(`  Session: ${check?.result?.result?.value || 'no-result'}`);

  // Also check what Google services show
  const check2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const links = [...document.querySelectorAll('a[href*="myaccount.google.com"]')].map(a => a.href).slice(0,10);
      return 'links: ' + links.join(', ').slice(0,300);
    })()`,
    returnByValue: true,
  });
  console.log(`  Links: ${check2?.result?.result?.value?.slice(0,200) || 'none'}`);

  // Save screenshot
  try {
    const ss = await send('Page.captureScreenshot', {format:'png'});
    if (ss?.result?.data) {
      fs.writeFileSync(`/tmp/session_${acct.email.replace(/[^a-z0-9]/g,'_')}.png`, Buffer.from(ss.result.data, 'base64'));
      console.log('  📸 screenshot saved');
    }
  } catch(e) {}

  ws.close();
}

console.log('\n━━━ Done ━━━');
