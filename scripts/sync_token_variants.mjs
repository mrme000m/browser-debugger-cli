import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';

const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const CDP='http://127.0.0.1:9222';

const vint=n=>{const b=[];while(n>0x7f){b.push((n&0x7f)|0x80);n=Math.floor(n/128);}b.push(n);return b;};
const fv=(n,v)=>[...vint(n<<3),...vint(v)];
const fb=(n,buf)=>{const b=typeof buf==='string'?Buffer.from(buf,'utf8'):buf;return[...vint((n<<3)|2),...vint(b.length),...b];};
const fm=(n,inner)=>fb(n,Buffer.from(inner));

function parsePb(buf,endTag=null){const out=[];let off=0;while(off<buf.length){let tag=0,s=0;while(true){const c=buf[off++];tag|=(c&0x7f)<<s;if(!(c&0x80))break;s+=7;}const fn=tag>>3,wt=tag&7;if(wt===4){if(endTag!==null&&tag===endTag)return{fields:out,consumed:off};throw new Error('wg'+fn);}if(wt===0){let v=0,s2=0;while(true){const c=buf[off++];v|=(c&0x7f)<<s2;if(!(c&0x80))break;s2+=7;}out.push([fn,wt,v]);}else if(wt===2){let l=0,s2=0;while(true){const c=buf[off++];l|=(c&0x7f)<<s2;if(!(c&0x80))break;s2+=7;}out.push([fn,wt,buf.subarray(off,off+l)]);off+=l;}else if(wt===3){const r=parsePb(buf.subarray(off),(fn<<3)|4);out.push([fn,wt,r.fields]);off+=r.consumed;}else throw new Error('wt'+wt);}return{fields:out,consumed:off};}

async function mintToken(rt){
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:CID,client_secret:SEC,refresh_token:rt,scope:'https://www.googleapis.com/auth/chromesync'})}).then(r=>r.json());
  if(r.error)throw new Error(r.error);
  return r.access_token;
}

// get page
const pageData=await new Promise((res,rej)=>{
  const req=http.request(`${CDP}/json/new?about:blank`,{method:'PUT'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));});
  req.on('error',rej);req.end();
});
const page=JSON.parse(pageData);
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
let wk=0;const pend=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const id=++wk;const t=setTimeout(()=>{pend.delete(id);res({});},15000);pend.set(id,r=>{clearTimeout(t);res(r);});ws.send(JSON.stringify({id,method,params}));});

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate',{url:'https://clients4.google.com'});
await new Promise(r=>setTimeout(r,6000));

const acct=JSON.parse(fs.readFileSync('/tmp/alive_google_token.json','utf8'));
const at=await mintToken(acct.refresh_token);
console.log('account:',acct.email);

// variant 1: token OMITTED (no field 2 in marker)
const markerNoToken = fm(3, [...fv(1,32904)]); // only data_type_id, no token
// variant 2: token EMPTY (field 2 = 0-length) — what we've been sending
const markerEmptyToken = fm(3, [...fv(1,32904), ...fb(2,Buffer.alloc(0))]);
// variant 3: no marker at all
const noMarker = [];

async function test(label, markerBytes) {
  const caller=[...fv(2,1)];
  const gu=[...fm(1,caller),...fv(2,1),...markerBytes,...fv(8,1),...fv(4,12)];
  const reqBytes=Buffer.from([...fb(1,acct.email),...fv(2,99),...fv(3,2),...fm(5,gu)]);
  const reqB64=reqBytes.toString('base64');
  const expr=`(async()=>{try{const body=Uint8Array.from(atob('${reqB64}'),c=>c.charCodeAt(0));const r=await fetch('/chrome-sync/command',{method:'POST',headers:{'Content-Type':'application/octet-stream','Authorization':'Bearer ${at}'},body});const buf=await r.arrayBuffer();return JSON.stringify({s:r.status,b:Array.from(new Uint8Array(buf)),l:buf.byteLength});}catch(e){return JSON.stringify({e:e.message});}})()`;
  const ev=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  const val=ev?.result?.result?.value;
  if(!val){console.log(`${label}: no-result`);return;}
  const p=JSON.parse(val);
  if(p.e){console.log(`${label}: err ${p.e}`);return;}
  if(p.s===200){
    const raw=Buffer.from(p.b);
    const top=parsePb(raw).fields;
    const guBytes=top.find(f=>f[0]===2)?.[2];
    const guf=guBytes?parsePb(guBytes).fields:[];
    const entries=guf.filter(f=>f[0]===1);
    const mkrs=guf.filter(f=>f[0]===5);
    const keys=guf.filter(f=>f[0]===6);
    console.log(`${label}: 200 entries=${entries.length} markers=${mkrs.length} keys=${keys.length}`);
  } else {
    console.log(`${label}: HTTP ${p.s} (${p.l}B)`);
  }
}

await test('no-marker+key  ', noMarker);
await test('marker no-token', markerNoToken);
await test('marker empty-tok', markerEmptyToken);

ws.close();
