#!/usr/bin/env node
// chromesync probe: mint chromesync token, send GetUpdates to /command, report per-type counts.
// Fixed: endpoint = clients4.google.com/chrome-sync/command, UNCOMPRESSED body (gzip → 502),
//        data_type_id = EntitySpecifics oneof tags (old 1/2/3 ids → BAD_REQUEST 400).
import fs from 'node:fs';

const tok = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/alive_google_token.json', 'utf8'));
const CID = '77185425430.apps.googleusercontent.com', SEC = 'OTJgUOQcT7lO7GsGZq2G4IlT';
const EMAIL = tok.email;

// ---- proto codec ----
const varint = (n) => { const b = []; while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n); return b; };
const fv = (n, v) => [...varint(n << 3), ...varint(v)];
const fb = (n, buf) => { const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf; return [...varint((n << 3) | 2), ...varint(b.length), ...b]; };
const fm = (n, inner) => fb(n, Buffer.from(inner));

// ---- request build ----
// data_type_id = EntitySpecifics oneof tag (see components/sync/protocol/entity_specifics.proto)
// NOTE: /command expects the LEGACY GetUpdatesMessage layout: caller_info=1, fetch_folders=2,
//       from_progress_marker=3, get_updates_origin=4 (modern layout fields 2/3/6/9 → 400).
const DATA_TYPES = [
  [32904, 'BOOKMARKS'], [37702, 'PREFERENCES'], [45873, 'PASSWORDS'], [31729, 'AUTOFILL'],
  [63951, 'AUTOFILL_PROFILE'], [41210, 'THEMES'], [48119, 'EXTENSIONS'], [88610, 'SEARCH_ENGINES'],
  [50119, 'SESSIONS'], [48364, 'APPS'], [154522, 'DEVICE_INFO'], [963985, 'HISTORY'],
  [47745, 'NIGORI'], [150251, 'HISTORY_DELETE'], [411028, 'READING_LIST'], [673225, 'WEB_APPS'],
];

const callerInfo = [...fv(2, 1)]; // notifications_enabled=true
const markerInner = (id) => [...fv(1, id), ...fb(2, Buffer.alloc(0))]; // empty token = first sync
const markers = DATA_TYPES.map(([id]) => fm(3, markerInner(id)));
const getUpdates = [...fm(1, callerInfo), ...fv(2, 1), ...markers, ...fv(4, 12)]; // GU_TRIGGER
const req = [...fb(1, EMAIL), ...fv(2, 99), ...fv(3, 2), ...fm(5, getUpdates)]; // share, proto99, GET_UPDATES

// ---- response parse (generic walk; supports proto2 groups: wt 3 = start, wt 4 = end) ----
function parse(buf, endTag = null) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    let tag = 0, shift = 0;
    while (true) { const c = buf[off++]; tag |= (c & 0x7f) << shift; if (!(c & 0x80)) break; shift += 7; }
    const fnum = tag >> 3, wt = tag & 7;
    if (wt === 4) { if (endTag !== null && tag === endTag) return { fields: out, consumed: off }; throw new Error('unexpected end-group ' + fnum); }
    if (wt === 0) { let val = 0, s = 0; while (true) { const c = buf[off++]; val |= (c & 0x7f) << s; if (!(c & 0x80)) break; s += 7; } out.push([fnum, wt, val]); }
    else if (wt === 2) { let len = 0, s = 0; while (true) { const c = buf[off++]; len |= (c & 0x7f) << s; if (!(c & 0x80)) break; s += 7; } out.push([fnum, wt, buf.subarray(off, off + len)]); off += len; }
    else if (wt === 3) { const r = parse(buf.subarray(off), (fnum << 3) | 4); out.push([fnum, wt, r.fields]); off += r.consumed; }
    else throw new Error('wire type ' + wt);
  }
  return { fields: out, consumed: off };
}
const fields = (buf) => parse(buf).fields;
const first = (fs, n) => fs.find(([f]) => f === n)?.[2];
const all = (fs, n) => fs.filter(([f]) => f === n).map(([, , v]) => v);
const asFields = (v) => Array.isArray(v) ? v : fields(v);

// specifics oneof tags -> data type name
const SPEC_TAGS = { 32904:'BOOKMARK', 45873:'PASSWORD', 37702:'PREFERENCE', 41210:'THEME', 48119:'EXTENSION', 48364:'APP', 50119:'SESSION', 31729:'AUTOFILL', 63951:'AUTOFILL_PROFILE', 88610:'SEARCH_ENGINE', 154522:'DEVICE_INFO', 47745:'NIGORI', 673225:'WEB_APP', 411028:'READING_LIST', 963985:'HISTORY', 150251:'HISTORY_DELETE' };

async function trySync(endpoint, token) {
  const res = await fetch(endpoint, { method: 'POST', headers: {
    'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream',
    'X-Client-Name': 'Chrome Browser', 'X-Client-Version': '150.0.7871.189', 'X-Client-ID': crypto.randomUUID(),
    'User-Agent': 'Chrome/150.0.7871.189' }, body: Buffer.from(req) });
  const raw = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync('/tmp/sync200.bin', raw);
  console.log(`[${endpoint}] HTTP ${res.status}, ${raw.length} bytes`);
  if (res.status !== 200) { console.log('  body head:', raw.subarray(0, 200).toString('latin1')); return; }
  const top = fields(raw);
  const errCode = first(top, 4), errMsg = first(top, 5);
  if (errCode && errCode !== 0) { console.log('  error_code:', errCode, '| msg:', errMsg); return; }
  const gu = first(top, 2);
  if (!gu) { console.log('  no get_updates in response; fields:', top.map(([f]) => f).join(',')); return; }
  const guf = asFields(gu);
  const entries = all(guf, 1).map(asFields);
  const counts = {};
  let folders = 0, deleted = 0;
  for (const e of entries) {
    const sp = first(e, 21);
    let type = '?';
    if (sp) { const spf = asFields(sp); for (const [f] of spf) if (SPEC_TAGS[f]) { type = SPEC_TAGS[f]; break; } }
    counts[type] = (counts[type] || 0) + 1;
    if (first(e, 22)) folders++;
    if (first(e, 18)) deleted++;
  }
  console.log('  changes_remaining:', first(guf, 4));
  console.log('  entries:', entries.length, '| folders:', folders, '| deleted:', deleted);
  console.log('  per-type:', JSON.stringify(counts));
  console.log('  new_progress_markers:', all(guf, 5).length, '| encryption_keys:', all(guf, 6).length);
  console.log('  store_birthday:', String(first(top, 6) || '').slice(0, 40) || '(none)');
  const samples = entries.slice(0, 8).map(e => ({ id: String(first(e, 1)).slice(0, 32), name: (first(e, 7) || '').slice(0, 40) }));
  console.log('  sample entries:', JSON.stringify(samples, null, 1));
}

const mint = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CID, client_secret: SEC, refresh_token: tok.refresh_token, scope: 'https://www.googleapis.com/auth/chromesync' }) });
const m = await mint.json();
if (!m.access_token) { console.log('mint failed:', JSON.stringify(m)); process.exit(1); }
console.log('minted chromesync token, scope:', m.scope);
await trySync('https://clients4.google.com/chrome-sync/command', m.access_token);
