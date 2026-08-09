import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';

const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const CDP='http://127.0.0.1:9222';
const vint=n=>{const b=[];while(n>0x7f){b.push((n&0x7f)|0x80);n=Math.floor(n/128);}b.push(n);return b;};
const fv=(n,v)=>[...vint(n<<3),...vint(v)];
const fb=(n,buf)=>{const b=typeof buf==='string'?Buffer.from(buf,'utf8'):buf;return[...vint((n<<3)|2),...vint(b.length),...b];};
const fm=(n,inner)=>fb(n,Buffer.from(inner));

async function mintToken(rt){
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:CID,client_secret:SEC,refresh_token:rt,scope:'https://www.googleapis.com/auth/chromesync'})}).then(r=>r.json());
  if(r.error)throw new Error(r.error); return r.access_token;
}

const pageData=await new Promise((res,rej)=>{const req=http.request(`${CDP}/json/new?about:blank`,{method:'PUT'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));});req.on('error',rej);req.end();});
const page=JSON.parse(pageData);
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
let wk=0;const pend=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const id=++wk;const t=setTimeout(()=>{pend.delete(id);res({});},15000);pend.set(id,r=>{clearTimeout(t);res(r);});ws.send(JSON.stringify({id,method,params}));});
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:'https://clients4.google.com'});await new Promise(r=>setTimeout(r,6000));

const acct=JSON.parse(fs.readFileSync('/tmp/alive_google_token.json','utf8'));
const at=await mintToken(acct.refresh_token);
console.log('acct:', acct.email);

async function probe(name, ids, kind) {
  const caller=[...fv(2,1)];
  const markers=ids.map(id=>{
    if(kind==='none') return fm(3,[...fv(1,id)]);
    if(kind==='empty') return fm(3,[...fv(1,id),...fb(2,Buffer.alloc(0))]);
    return fm(3,[...fv(1,id)]);
  });
  let gu=[...fm(1,caller),...fv(2,1),...markers,...fv(8,1),...fv(4,12)];
  const req=Buffer.from([...fb(1,acct.email),...fv(2,99),...fv(3,2),...fm(5,gu)]);
  const b64=req.toString('base64');
  const ev=await send('Runtime.evaluate',{expression:`(async()=>{const b=Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0));const r=await fetch('/chrome-sync/command',{method:'POST',headers:{'Content-Type':'application/octet-stream','Authorization':'Bearer ${at}'},body:b});const a=await r.arrayBuffer();return JSON.stringify({s:r.status,l:a.byteLength});})()`,awaitPromise:true,returnByValue:true});
  const v=ev?.result?.result?.value;
  if(!v){console.log(`  ${name}: no-result`);return;}
  const p=JSON.parse(v);
  console.log(`  ${name}: HTTP${p.s} (${p.l}B)`);
}

await probe('no-marker', []);
await probe('1-bm-no-tok', [32904], 'none');
await probe('1-bm-empty', [32904], 'empty');
await probe('1-nigori-no-tok', [47745], 'none');
await probe('2-bm+pw', [32904,45873]);

ws.close();
