import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';

const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const CDP='http://127.0.0.1:9222';

// Mint OAuthLogin token for imnoob908
const acct = JSON.parse(fs.readFileSync('/tmp/fatetraffic_alive.json','utf8')).find(a=>a.email.includes('imnoob908'));
const t = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body: new URLSearchParams({grant_type:'refresh_token',client_id:CID,client_secret:SEC,refresh_token:acct.refresh_token,
    scope:'https://www.google.com/accounts/OAuthLogin'})}).then(r=>r.json());
console.log('OAuthLogin token minted for:', acct.email);

// Setup CDP
const pageData = await new Promise((res,rej)=>{
  const req=http.request(`${CDP}/json/new?about:blank`,{method:'PUT'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));});
  req.on('error',rej);req.end();
});
const ws = new WebSocket(pageData.webSocketDebuggerUrl);
await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
let wk=0; const pend=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const id=++wk;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

// Navigate to MergeSession with auth param (Chrome's session creation endpoint)
const authURL = encodeURIComponent(t.access_token);
const urls = [
  `https://accounts.google.com/MergeSession?service=mail&continue=https://mail.google.com/mail/&auth=${authURL}`,
  `https://accounts.google.com/accounts/OAuthLogin?source=ChromiumBrowser&auth=${encodeURIComponent(`Bearer ${t.access_token}`)}`,
  `https://accounts.google.com/accounts/SetSID?ssdc=1&sid=Bearer${encodeURIComponent(t.access_token)}&continue=https://myaccount.google.com/`,
];

for (const url of urls) {
  console.log(`\n--- ${url.split('?')[0].split('/').pop()} ---`);
  await send('Page.navigate', {url});
  await new Promise(r=>setTimeout(r,8000));

  // Check URL and cookies
  const ev = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,title:document.title})',
    returnByValue: true
  });
  const v = ev?.result?.result?.value;
  if (v) { const p=JSON.parse(v); console.log(`  → ${p.title} | ${p.url.slice(0,80)}`); }

  // Get cookies for google.com
  const ck = await send('Network.getCookies', {urls:['https://.google.com/','https://accounts.google.com/','https://mail.google.com/']});
  const cookies = ck?.result?.cookies||[];
  const sid = cookies.find(c=>c.name==='SID');
  const hsid = cookies.find(c=>c.name==='HSID');
  const ssid = cookies.find(c=>c.name==='SSID');
  console.log(`  Cookies set: ${cookies.length} total | SID:${sid?'✅':'❌'} HSID:${hsid?'✅':'❌'} SSID:${ssid?'✅':'❌'}`);
  if (sid) console.log(`  SID: ${sid.value.slice(0,30)}...`);
}

// Also try direct HTTP to MergeSession (bypass CDP, capture Set-Cookie)
console.log('\n--- Direct HTTP MergeSession ---');
const r = await fetch('https://accounts.google.com/MergeSession?service=mail&continue=https://mail.google.com/mail/', {
  headers: { 'Authorization': `Bearer ${t.access_token}` },
  redirect: 'manual'
});
console.log('HTTP', r.status);
for (const [k,v] of r.headers) {
  if (k.startsWith('set-cookie')) console.log('  Set-Cookie:', v.slice(0,120));
}
const loc = r.headers.get('location');
console.log('  Location:', loc?.slice(0,100));

ws.close();
