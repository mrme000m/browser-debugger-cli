import fs from 'node:fs';
const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
for (const [label, file] of [['PRATHAM','/tmp/alive_google_token.json'],['KARTIK','/tmp/cc_alive.json']]) {
  const ref = JSON.parse(fs.readFileSync(file,'utf8')).refresh_token;
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type:'refresh_token', client_id:CID, client_secret:SEC, refresh_token:ref, scope:'https://www.googleapis.com/auth/gmail.modify' }) });
  const j = await r.json();
  if (!j.access_token) { console.log(label, 'mint fail', j.error); continue; }
  const g = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + j.access_token } });
  const p = await g.json();
  console.log('===', label, '| Gmail API profile:', g.status, '| email:', p.emailAddress, '| msgs:', p.messagesTotal, '| threads:', p.threadsTotal);
  if (g.status === 200) {
    const l = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=in:inbox', { headers: { Authorization: 'Bearer ' + j.access_token } });
    const lj = await l.json();
    console.log('   inbox messages (sample):', JSON.stringify(lj.resultSizeEstimate) + ' total estimate | ids:', (lj.messages||[]).map(m=>m.id).join(','));
  }
}
