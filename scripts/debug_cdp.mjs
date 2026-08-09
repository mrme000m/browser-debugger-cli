import { WebSocket } from 'ws';
import http from 'node:http';

const CDP = 'http://127.0.0.1:9222';
const data = await new Promise(res=>{
  const r = http.request(`${CDP}/json/new?about:blank`, {method:'PUT'}, r2=>{let d='';r2.on('data',c=>d+=c);r2.on('end',()=>res(d));});
  r.end();
});
const page = JSON.parse(data);
console.log('page:', page.id);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
let wk=0; const pend=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const id=++wk;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});

await send('Network.enable');

// test loadNetworkResource
const r = await send('Network.loadNetworkResource', {
  url: 'https://httpbin.org/get',
  options: { method: 'GET' }
});
console.log('loadNetworkResource result:', JSON.stringify(r.result).slice(0,500));

// try Fetch.enable + navigate to google.com, then fetch from page context
await send('Page.enable');
await send('Page.navigate', {url: 'https://www.google.com'});
await new Promise(r=>setTimeout(r, 5000)); // wait for page load

// now try page-context fetch (same-origin-ish to google.com... but clients4 is different)
const ev = await send('Runtime.evaluate', {expression: `fetch('https://httpbin.org/get').then(r=>r.text()).then(t=>t.slice(0,200)).catch(e=>'ERR:'+e.message)`, awaitPromise:true, returnByValue:true});
console.log('page fetch httpbin:', ev?.result?.result?.value?.slice(0,200));

ws.close();
