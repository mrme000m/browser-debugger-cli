import { WebSocket } from 'ws';
import http from 'node:http';

const CDP = 'http://127.0.0.1:9222';
const data = await new Promise(res=>{
  const r = http.request(`${CDP}/json/new?about:blank`, {method:'PUT'}, r2=>{let d='';r2.on('data',c=>d+=c);r2.on('end',()=>res(d));});
  r.end();
});
const page = JSON.parse(data);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
let wk=0; const pend=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const id=++wk;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});

await send('Runtime.enable');
await send('Page.enable');

// Navigate to clients4.google.com so page origin matches → fetch is same-origin
console.log('navigating to clients4...');
await send('Page.navigate', {url: 'https://clients4.google.com'});
await new Promise(r=>setTimeout(r, 8000));
const url = await send('Runtime.evaluate', {expression:'location.href', returnByValue:true});
console.log('landed on:', url?.result?.result?.value?.slice(0,100));

// test fetch
const ev = await send('Runtime.evaluate', {
  expression: `fetch('/chrome-sync/command', {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array([1,2,3])}).then(r=>'HTTP'+r.status).catch(e=>'ERR:'+e.message)`,
  awaitPromise: true, returnByValue: true
});
console.log('page fetch result:', ev?.result?.result?.value);

ws.close();
