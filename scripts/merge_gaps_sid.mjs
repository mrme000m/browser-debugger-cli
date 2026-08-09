import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';

const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const CDP='http://127.0.0.1:9222';

const acct = JSON.parse(fs.readFileSync('/tmp/fatetraffic_alive.json','utf8')).find(a=>a.email.includes('imnoob908'));
const t = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body: new URLSearchParams({grant_type:'refresh_token',client_id:CID,client_secret:SEC,refresh_token:acct.refresh_token,
    scope:'https://www.google.com/accounts/OAuthLogin'})}).then(r=>r.json());
console.log('OAuthLogin token:', t.access_token.slice(0,20)+'...');

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

// Get the dead session cookies from the dump
const bdCookies = JSON.parse(fs.readFileSync('/tmp/bd_google_cookies.json','utf8')).find(a=>a.email.includes('imnoob908'));
const deadSID = bdCookies.cookies.find(c=>c.name==='SID');
const deadHSID = bdCookies.cookies.find(c=>c.name==='HSID');
console.log('Dead SID:', deadSID?.value?.slice(0,25)+'...');
console.log('Dead HSID:', deadHSID?.value?.slice(0,25)+'...');

// First, navigate to MergeSession to get fresh GAPS
await send('Page.navigate', {url: `https://accounts.google.com/MergeSession?auth=${encodeURIComponent(t.access_token)}&service=mail&continue=https://accounts.google.com/`});
await new Promise(r=>setTimeout(r,8000));

// Get the GAPS cookie that was set
let gapsCookie = await send('Network.getCookies', {urls:['https://accounts.google.com/']});
let gaps = gapsCookie?.result?.cookies?.find(c=>c.name==='__Host-GAPS');
console.log('GAPS from MergeSession:', gaps?.value?.slice(0,30)+'...');

// Now inject the dead SID + HSID alongside the fresh GAPS
await send('Network.setCookie', {name:'SID', value:deadSID.value, domain:'.google.com', path:'/', secure:true, httpOnly:true});
await send('Network.setCookie', {name:'HSID', value:deadHSID.value, domain:'.google.com', path:'/', secure:true, httpOnly:true});

// Navigate to myaccount with access_token in URL (Chrome sometimes passes auth in fragment)
await send('Page.navigate', {url: 'https://myaccount.google.com/'});
await new Promise(r=>setTimeout(r,10000));

const ev = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({title:document.title,url:location.href,body:(document.body?.innerText||\"\").slice(0,500)})',
  returnByValue: true
});
console.log('Result:', ev?.result?.result?.value?.slice(0,400));

// Check all cookies now
const finalCookies = await send('Network.getCookies', {urls:['https://.google.com/']});
const newSID = finalCookies?.result?.cookies?.find(c=>c.name==='SID');
const newHSID = finalCookies?.result?.cookies?.find(c=>c.name==='HSID');
console.log('Final SID:', newSID?'present':'absent');
console.log('Final HSID:', newHSID?'present':'absent');

ws.close();
