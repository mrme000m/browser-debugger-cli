/**
 * Persistent authenticated-session storage.
 *
 * Stores browser cookie sets (captured via Network.getAllCookies) as named
 * session files under ~/.bdg/sessions/<name>.json so an authenticated log-in
 * can be exported from one profile and restored into another (e.g. moving a
 * Google login across CloakBrowser proxy profiles).
 *
 * Does NOT store credentials/secrets directly - it only persists browser
 * cookies, which are what actually carry the authenticated session.
 */

import * as fs from 'fs';
import * as path from 'path';

import { CommandError } from '@/errors/index.js';
import { getSessionDir } from '@/session/paths.js';
import type { Cookie } from '@/ui/formatters/index.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/**
 * On-disk shape of a stored session file.
 */
export interface StoredSession {
  /** Display/name identifier for the session (file basename). */
  name: string;
  /** ISO timestamp when the session was captured. */
  capturedAt: string;
  /** Source browser/profile note, if any. */
  source?: string;
  /** The cookie set captured from the browser. */
  cookies: Cookie[];
}

/**
 * Directory holding named session files.
 */
function sessionsDir(): string {
  return path.join(getSessionDir(), 'sessions');
}

/**
 * Resolve a session name to its file path.
 *
 * Guards against path traversal / escaping the sessions dir.
 *
 * @param name - Session name (basename only)
 * @returns Absolute path to the session file
 */
export function sessionFilePath(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(sessionsDir(), `${safe}.json`);
}

/**
 * Ensure the sessions directory exists.
 */
function ensureSessionsDir(): void {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

/**
 * Save a cookie set as a named session.
 *
 * @param name - Session name
 * @param cookies - Cookies to persist
 * @param source - Optional source note (e.g. profile id)
 * @throws CommandError if the session file already exists and overwrite is off
 */
export function saveSession(
  name: string,
  cookies: Cookie[],
  source?: string,
  overwrite = false
): string {
  ensureSessionsDir();
  const file = sessionFilePath(name);
  if (!overwrite && fs.existsSync(file)) {
    throw new Error(`Session "${name}" already exists at ${file}. Use --force to overwrite.`);
  }
  const session: StoredSession = {
    name,
    capturedAt: new Date().toISOString(),
    ...(source && { source }),
    cookies,
  };
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
  return file;
}

/**
 * Load a stored session by name.
 *
 * @param name - Session name
 * @returns The stored session
 * @throws CommandError if not found or malformed
 */
export function loadSession(name: string): StoredSession {
  const file = sessionFilePath(name);
  if (!fs.existsSync(file)) {
    throw new CommandError(
      `No saved session "${name}"`,
      { suggestion: `Run 'bdg session list' to see available sessions.` },
      EXIT_CODES.RESOURCE_NOT_FOUND
    );
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredSession;
    if (!Array.isArray(parsed.cookies)) {
      throw new Error('missing cookies array');
    }
    return parsed;
  } catch {
    throw new CommandError(
      `Session "${name}" is corrupt or unreadable`,
      { suggestion: `Delete ${file} or re-export the session.` },
      EXIT_CODES.SESSION_FILE_ERROR
    );
  }
}

/**
 * List all stored sessions.
 *
 * @returns Array of \{ name, capturedAt, cookieCount \} summaries
 */
export function listSessions(): { name: string; capturedAt: string; cookieCount: number }[] {
  if (!fs.existsSync(sessionsDir())) return [];
  return fs
    .readdirSync(sessionsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.replace(/\.json$/, '');
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8')) as StoredSession;
        return { name, capturedAt: s.capturedAt, cookieCount: s.cookies?.length ?? 0 };
      } catch {
        return { name, capturedAt: '', cookieCount: 0 };
      }
    })
    .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
}

/**
 * Delete a saved session file.
 *
 * @param name - Session name
 * @returns The deleted file path, or empty if it did not exist
 */
export function deleteSession(name: string): string {
  const file = sessionFilePath(name);
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    return file;
  }
  return '';
}

/**
 * Classify cookies in a session for a health summary.
 */
export function sessionHealth(s: StoredSession): {
  total: number;
  expired: number;
  expiringSoon: number;
  hasAuthTokens: boolean;
} {
  const now = Date.now() / 1000;
  const AUTH_NAMES = new Set(['SID', 'SSID', 'SAPISID', 'APISID', 'LSID', 'NID', '1PSID', 'OSID']);
  let expired = 0;
  let expiringSoon = 0;
  for (const c of s.cookies) {
    if (c.expires && c.expires !== -1 && c.expires < now) expired++;
    else if (c.expires && c.expires !== -1 && c.expires < now + 7 * 86400) expiringSoon++;
  }
  const hasAuthTokens = s.cookies.some((c) => AUTH_NAMES.has(c.name));
  return { total: s.cookies.length, expired, expiringSoon, hasAuthTokens };
}
