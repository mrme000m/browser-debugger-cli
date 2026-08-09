import fs from 'node:fs';
const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
const ref = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/alive_google_token.json','utf8')).refresh_token;
const SCOPES = ['https://www.googleapis.com/auth/chromesync','https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/calendar','https://www.googleapis.com/auth/contacts','https://www.googleapis.com/auth/tasks','https://www.googleapis.com/auth/keep','https://www.googleapis.com/auth/documents','https://www.googleapis.com/auth/classroom.courses.readonly','https://www.googleapis.com/auth/webhistory','https://mail.google.com/'];
const ok = [], bad = [];
for (const scope of SCOPES) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type:'refresh_token', client_id:CID, client_secret:SEC, refresh_token:ref, scope }) });
  const j = await r.json();
  (j.access_token ? ok : bad).push(scope.split('/').pop());
}
console.log('PRATHAM mintable:', ok.join(', '));
console.log('PRATHAM blocked :', bad.join(', '));
