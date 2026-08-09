#!/usr/bin/env node
/**
 * OneBank Lotus Domino Directory backup — webmail.onebank.com.bd/names.nsf
 * via local CloakBrowser + Playwright.
 *
 * Domino login form at base URL, then navigate to /names.nsf/People?OpenView.
 * Paginate via JavaScript _doClick() calls (Domino server-side cursor).
 * Save raw HTML + structured JSON to backups/.
 *
 * Usage:
 *   node scripts/onebank_directory_backup.mjs
 *   node scripts/onebank_directory_backup.mjs --headless
 *   node scripts/onebank_directory_backup.mjs --outdir /path/to/backups
 *   node scripts/onebank_directory_backup.mjs --user "user@onebank.com.bd" --pass "pass#123"
 */
import { chromium } from '/Volumes/Spare/npm/global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const CLOAK = '/Users/m/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium';
const BASE_URL = 'https://webmail.onebank.com.bd';
const PEOPLE_URL = `${BASE_URL}/names.nsf/People?OpenView`;

const args = process.argv.slice(2);
const HEADLESS = args.includes('--headless');
const outdirIdx = args.indexOf('--outdir');
const OUTDIR = outdirIdx !== -1 ? args[outdirIdx + 1] : path.resolve(import.meta.dirname, '..', 'backups');
const userIdx = args.indexOf('--user');
const USERNAME = userIdx !== -1 ? args[userIdx + 1] : 'naharul.islam@onebank.com.bd';
const passIdx = args.indexOf('--pass');
const PASSWORD = passIdx !== -1 ? args[passIdx + 1] : 'Nahar272284#';
const MAX_PAGES = 200;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const TIMESTAMP = ts();

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

/** Save contacts to JSON file (called after each page for crash safety). */
function saveJson(contacts, outFile) {
  const output = {
    metadata: {
      source: PEOPLE_URL,
      timestamp: new Date().toISOString(),
      total_contacts: contacts.length,
      extracted_by: 'onebank_directory_backup.mjs',
      credentials: USERNAME,
    },
    contacts,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
}

/** Extract contacts from the current page's People view table. */
async function extractPageContacts(page) {
  return await page.evaluate(() => {
    // Find the table with the most rows (the directory table)
    const tables = [...document.querySelectorAll('table')];
    let bestTable = null;
    let maxRows = 0;
    for (const t of tables) {
      const rows = t.querySelectorAll('tr').length;
      if (rows > maxRows) { maxRows = rows; bestTable = t; }
    }
    if (!bestTable) return { contacts: [], totalRows: 0 };

    const rows = [...bestTable.querySelectorAll('tr')].slice(1); // skip header
    const contacts = [];
    for (const row of rows) {
      // Extract all links from the row — each contact has links for:
      // Name, Telephone Company, E-Mail, Mail Server (all point to same doc)
      const links = [...row.querySelectorAll('a[href*="OpenDocument"]')];
      if (links.length === 0) continue;

      // Deduplicate links by href (all 4 fields point to the same document)
      const seenHrefs = new Set();
      const fields = [];
      let docUrl = '';
      for (const link of links) {
        const text = link.innerText.trim();
        const href = link.href;
        if (!text) continue;
        if (!docUrl) docUrl = href;
        // Skip duplicate links (same text = same field rendered twice)
        if (!seenHrefs.has(text)) {
          seenHrefs.add(text);
          fields.push(text);
        }
      }

      if (fields.length === 0) continue;

      contacts.push({
        name: fields[0] || '',
        telephone_company: fields[1] || '',
        email: fields[2] || '',
        mail_server: fields[3] || '',
        id_vault: fields[4] || '',
        doc_url: docUrl,
      });
    }
    return { contacts, totalRows: maxRows };
  });
}

/** Find and click the "Next Page" navigation link (Domino uses _doClick for pagination). */
async function clickNextPage(page) {
  // Record the first contact name on current page for change detection
  const prevFirstContact = await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].sort((a, b) =>
      b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
    const firstRow = table?.querySelectorAll('tr')[1];
    return firstRow?.querySelector('a[href*="OpenDocument"]')?.innerText?.trim() || '';
  });

  // Domino pagination: links with text "Next Page" (there are 2 sets: top and bottom)
  const nextLinks = await page.$$('a[onclick*="_doClick"]');
  let clicked = false;
  for (const link of nextLinks) {
    const text = await link.evaluate(el => el.innerText.trim() || el.querySelector('img')?.alt || '');
    if (text === 'Next Page') {
      try {
        await link.click();
        clicked = true;
        break;
      } catch { /* try next */ }
    }
  }

  if (!clicked) return false;

  await sleep(3000);

  // Check if the page actually changed
  const newFirstContact = await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].sort((a, b) =>
      b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
    const firstRow = table?.querySelectorAll('tr')[1];
    return firstRow?.querySelector('a[href*="OpenDocument"]')?.innerText?.trim() || '';
  });

  return newFirstContact !== prevFirstContact;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const jsonFile = path.join(OUTDIR, `onebank_directory_${TIMESTAMP}.json`);
  const rawFile = path.join(OUTDIR, `onebank_directory_raw_${TIMESTAMP}.html`);

  log('========================================');
  log('OneBank Domino Directory Backup');
  log(`  URL: ${PEOPLE_URL}`);
  log(`  User: ${USERNAME}`);
  log(`  Output: ${OUTDIR}`);
  log(`  Headless: ${HEADLESS}`);
  log('========================================');

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: CLOAK,
    args: ['--window-size=1440,900'],
  });

  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Step 1: Login
    log('Navigating to login page...');
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60000 });
    await sleep(2000);
    log('Filling username...');
    await page.fill('input[name="Username"]', USERNAME);
    await sleep(500);
    log('Filling password...');
    await page.fill('input[name="Password"]', PASSWORD);
    await sleep(800);
    log('Clicking Sign In...');
    await page.click('input[type="submit"]');
    await page.waitForURL('**/maillogin.nsf*', { timeout: 30000 }).catch(() => {});
    await sleep(2000);
    log(`Login completed. URL: ${page.url()}`);

    // Step 2: Navigate to People view
    log('Navigating to Domino Directory (People view)...');
    await page.goto(PEOPLE_URL, { waitUntil: 'load', timeout: 60000 });
    await sleep(3000);

    // Step 3: Extract all pages
    const allContacts = [];
    let pageNum = 1;

    while (pageNum <= MAX_PAGES) {
      log(`Processing page ${pageNum}...`);
      const { contacts, totalRows } = await extractPageContacts(page);

      if (contacts.length === 0 && pageNum === 1) {
        log('No contacts found on page 1. Saving raw HTML for inspection.');
        fs.writeFileSync(rawFile, await page.content());
        break;
      }

      allContacts.push(...contacts);
      log(`Page ${pageNum}: ${contacts.length} rows (total: ${allContacts.length})`);

      // Save raw HTML of first page only (for reference)
      if (pageNum === 1) {
        fs.writeFileSync(rawFile, await page.content());
        log(`Raw HTML saved: ${rawFile}`);
      }

      // Save JSON incrementally (crash safety)
      saveJson(allContacts, jsonFile);

      // Check for duplicates (if same first contact appears twice, we've cycled)
      if (allContacts.length > contacts.length * 2) {
        const firstNames = allContacts.slice(0, 30).map(c => c.name);
        const lastNames = allContacts.slice(-30).map(c => c.name);
        if (firstNames[0] === lastNames[0] && firstNames[1] === lastNames[1]) {
          log('Detected duplicate page (cycled back to start). Stopping.');
          allContacts.length = allContacts.length - contacts.length; // remove dup page
          break;
        }
      }

      // Try to go to next page
      const hasNext = await clickNextPage(page);
      if (!hasNext) {
        log('No more pages. Done.');
        break;
      }

      pageNum++;
    }

    // Final save
    saveJson(allContacts, jsonFile);
    log('========================================');
    log('Backup complete!');
    log(`  Raw:  ${rawFile}`);
    log(`  JSON: ${jsonFile}`);
    log(`  Contacts: ${allContacts.length}`);
    log('========================================');

    // Print sample
    if (allContacts.length > 0) {
      log('Sample contacts (first 5):');
      for (const c of allContacts.slice(0, 5)) {
        log(`  ${c.name} | ${c.email} | ${c.mail_server}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
