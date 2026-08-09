import fs from 'node:fs';
const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
for (const [label, file] of [['PRATHAM','/tmp/alive_google_token.json'],['KARTIK','/tmp/cc_alive.json']]) {
  const ref = JSON.parse(fs.readFileSync(file,'utf8')).refresh_token;
  for (const scope of ['https://mail.google.com/','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.modify']) {
    const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ grant_type:'refresh_token', client_id:CID, client_secret:SEC, refresh_token:ref, scope }) });
    const j = await r.json();
    console.log(label, scope.split('/').pop() || 'mail.google.com', '->', j.access_token ? '✅ MINTED' : '❌ ' + j.error);
    if (j.access_token) fs.writeFileSync('/tmp/gmail_at_' + (label==='PRATHAM'?'pratham':'kartik') + '.txt', j.access_token);
  }
}
