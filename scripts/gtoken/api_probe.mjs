import fs from 'node:fs';
const tok = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/cc_alive.json','utf8')).refresh_token;
const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
async function mint(scope) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type:'refresh_token', client_id:CID, client_secret:SEC, refresh_token:tok, scope }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(scope + ' -> ' + j.error);
  return j.access_token;
}
async function call(label, scope, url) {
  try {
    const at = await mint(scope);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + at } });
    const j = await r.json();
    console.log(label.padEnd(16), 'HTTP', r.status, '|', JSON.stringify(j).slice(0, 180));
  } catch (e) { console.log(label.padEnd(16), 'ERR', e.message); }
}
await call('DRIVE list', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/drive/v3/files?pageSize=5&fields=files(id,name,mimeType,size)');
await call('DRIVE about', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota');
await call('CALENDAR list', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=3');
await call('CONTACTS list', 'https://www.googleapis.com/auth/contacts', 'https://people.googleapis.com/v1/people/me/connections?pageSize=5&personFields=names,emailAddresses');
await call('TASKS list', 'https://www.googleapis.com/auth/tasks', 'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=3');
await call('DOCS list', 'https://www.googleapis.com/auth/documents', 'https://docs.googleapis.com/v1/documents?maxResults=3');
await call('CLASSROOM', 'https://www.googleapis.com/auth/classroom.courses.readonly', 'https://classroom.googleapis.com/v1/courses?pageSize=3');
