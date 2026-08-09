/**
 * Scanning of pre-captured cookie dumps (Netscape-format) on disk.
 *
 * Stealer-style dumps organize per-profile folders with:
 *   Cookies/<browser>_Default.txt        tab-separated Netscape cookies
 *   GoogleAccounts/<browser>_Default.txt one-line Google auth tokens
 *
 * This lets a reproducible-lab harness detect which profile folders actually
 * hold a full authenticated Google session (auth cookies + optional account
 * token) so one can decide which to load into a fresh CloakBrowser profile.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The on-disk Netscape cookie line format is tab-separated:
 *   domain  includeSubdomains  path  secure  expires  name  value
 */
export interface NetscapeCookie {
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
}

/** Cookie names that signal an authenticated Google session. */
const GOOGLE_AUTH_TOKENS = new Set([
  'SID',
  'SSID',
  'SAPISID',
  'APISID',
  'HSID',
  'LSID',
  'NID',
  '__Host-GAPS',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  'OSID',
]);

/**
 * Parse a Netscape cookie file into structured cookies.
 *
 * Silently skips malformed lines and the file header row.
 *
 * @param file - Path to a tab-separated Netscape cookie file
 * @returns Parsed cookies
 */
export function parseNetscapeCookies(file: string): NetscapeCookie[] {
  const out: NetscapeCookie[] = [];
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0];
    const hostOnly = parts[1];
    const p = parts[2];
    const secure = parts[3];
    const exp = parts[4];
    const name = parts[5];
    const value = parts.slice(6).join('\t');
    out.push({
      domain: domain!,
      hostOnly: hostOnly !== 'TRUE',
      path: p ?? '',
      secure: secure === 'TRUE',
      expires: Number(exp) || 0,
      name: name!,
      value,
    });
  }
  return out;
}

/**
 * Scan the cookie files inside one profile folder.
 *
 * @param profileDir - Directory expected to contain Cookies/ (and optional GoogleAccounts/)
 * @returns Cookie + account token summary for that profile
 */
export function scanProfileDir(profileDir: string): {
  dir: string;
  hasCookiesDir: boolean;
  cookieFiles: string[];
  totalCookies: number;
  authCookies: number;
  hasGoogleAccounts: boolean;
  fullSession: boolean;
} {
  const cookiesDir = path.join(profileDir, 'Cookies');
  const gaDir = path.join(profileDir, 'GoogleAccounts');
  let hasCookiesDir = false;
  let cookieFiles: string[] = [];
  let totalCookies = 0;
  let authCookies = 0;

  if (fs.existsSync(cookiesDir)) {
    hasCookiesDir = true;
    cookieFiles = fs
      .readdirSync(cookiesDir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => path.join(cookiesDir, f));
    for (const cf of cookieFiles) {
      for (const c of parseNetscapeCookies(cf)) {
        totalCookies++;
        if (GOOGLE_AUTH_TOKENS.has(c.name)) authCookies++;
      }
    }
  }

  let hasGoogleAccounts = false;
  if (fs.existsSync(gaDir)) {
    const files = fs.readdirSync(gaDir).filter((f) => f.endsWith('.txt'));
    hasGoogleAccounts = files.length > 0;
  }

  // A "full" Google session needs the main session cookies; the account line
  // in GoogleAccounts adds confidence (looks like a Bearer/refresh token).
  const fullSession = authCookies >= 2 || (authCookies >= 1 && hasGoogleAccounts);

  return {
    dir: profileDir,
    hasCookiesDir,
    cookieFiles,
    totalCookies,
    authCookies,
    hasGoogleAccounts,
    fullSession,
  };
}

/**
 * Recursively find profile folders under a root that contain a Cookies or
 * GoogleAccounts subfolder, and scan each for a full session.
 *
 * @returns Scanned profiles, each summarised
 */
export function scanCookieDump(rootDir: string): ReturnType<typeof scanProfileDir>[] {
  const profileDirs: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const hasC = fs.existsSync(path.join(full, 'Cookies'));
      // if this dir is a profile holder (has Cookies/ dir) scan it but keep walking too
      if (hasC || fs.existsSync(path.join(full, 'GoogleAccounts'))) {
        profileDirs.push(full);
      }
      stack.push(full);
    }
  }
  return profileDirs.map(scanProfileDir);
}
/**
 * Collapse all cookie files in a profile's Cookies/ dir into CDP CookieParam
 * objects ready for Network.setCookies.
 *
 * Cookies are deduped (last-wins) by domain+path+name; Google session cookies
 * default to httpOnly so the auth session survives, and secure is honoured.
 *
 * @param profileDir - Profile folder that has a Cookies/ subdir
 * @returns array of CDP CookieParam
 */
export function cookiesFromProfile(profileDir: string): Record<string, unknown>[] {
  const cookiesDir = path.join(profileDir, 'Cookies');
  if (!fs.existsSync(cookiesDir)) return [];
  const files = fs.readdirSync(cookiesDir).filter((f) => f.endsWith('.txt'));
  const dedupe = new Map<string, Record<string, unknown>>();
  for (const f of files) {
    for (const c of parseNetscapeCookies(path.join(cookiesDir, f))) {
      const key = `${c.domain}\u0000${c.path}\u0000${c.name}`;
      const isGoogle = /google/i.test(c.domain) || c.name === 'NID';
      dedupe.set(key, {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        ...(c.expires > 0 ? { expires: c.expires } : {}),
        httpOnly: isGoogle,
        secure: c.secure || isGoogle,
      });
    }
  }
  return [...dedupe.values()];
}
