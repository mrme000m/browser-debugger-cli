import fs from 'node:fs';
const CID='77185425430.apps.googleusercontent.com', SEC='OTJgUOQcT7lO7GsGZq2G4IlT';
async function mint(refresh, scope) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type:'refresh_token', client_id:CID, client_secret:SEC, refresh_token:refresh, scope }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(scope + ' -> ' + j.error);
  return j.access_token;
}
// Kartik drive inventory
const kartik = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/cc_alive.json','utf8')).refresh_token;
const at = await mint(kartik, 'https://www.googleapis.com/auth/drive');
const all = [];
let page = null;
do {
  const u = new URL('https://www.googleapis.com/drive/v3/files');
  u.searchParams.set('pageSize', '100');
  u.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime)');
  if (page) u.searchParams.set('pageToken', page);
  const j = await (await fetch(u, { headers: { Authorization: 'Bearer ' + at } })).json();
  all.push(...(j.files || [])); page = j.nextPageToken;
} while (page && all.length < 300);
const folders = all.filter(f => f.mimeType === 'application/vnd.google-apps.folder').length;
const totalSize = all.reduce((s, f) => s + (parseInt(f.size) || 0), 0);
const byType = {};
for (const f of all) { const m = f.mimeType.split('.').pop() || '?'; byType[m] = (byType[m] || 0) + 1; }
console.log('KARTIK DRIVE:', all.length, 'files sampled (up to 300) |', folders, 'folders |', (totalSize/1048576).toFixed(1), 'MB in sampled files');
console.log('top-level names:', all.slice(0, 12).map(f => (f.mimeType.includes('folder') ? '📁' : '📄') + ' ' + f.name + (f.size ? ' (' + Math.round(f.size/1024) + 'KB)' : '')).join('\n  '));
console.log('types:', JSON.stringify(byType).slice(0, 200));
// can we READ a file's content? pick first non-folder
const img = all.find(f => f.mimeType === 'image/jpeg');
if (img) {
  const dl = await fetch('https://www.googleapis.com/drive/v3/files/' + img.id + '?alt=media', { headers: { Authorization: 'Bearer ' + at } });
  const buf = Buffer.from(await dl.arrayBuffer());
  console.log('📥 READ TEST:', img.name, '->', dl.status, buf.length, 'bytes downloaded (', buf.subarray(0,3).toString(), ')');
}
