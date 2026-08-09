import fs from 'node:fs';
const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const ref = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/cc_alive.json','utf8')).refresh_token;
const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body: new URLSearchParams({ grant_type:'refresh_token', client_id:CID, client_secret:SEC, refresh_token:ref, scope:'https://www.googleapis.com/auth/gmail.modify' }) });
const j = await r.json();
console.log('minted scope field:', j.scope);
const ti = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + j.access_token).then(r => r.json());
console.log('tokeninfo granted scopes:', ti.scope);
const g = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + j.access_token } });
console.log('gmail api:', g.status, await g.text());
