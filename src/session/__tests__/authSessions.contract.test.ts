/**
 * Authenticated session storage contract tests.
 *
 * Focus: persistence round-trip, duplicate protection, health reporting.
 */

import * as fs from 'fs';
import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as os from 'os';
import * as path from 'path';

import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession,
  sessionHealth,
  sessionFilePath,
} from '@/session/authSessions.js';

describe('Authenticated session store', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-sessionstore-test-'));
    process.env['BDG_SESSION_DIR'] = testDir;
  });

  afterEach(() => {
    delete process.env['BDG_SESSION_DIR'];
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const SID_COOKIE = {
    name: 'SID',
    value: 'g.a000x',
    domain: '.google.com',
    path: '/',
    httpOnly: true,
    secure: true,
  };

  it('round-trips a session through save/load', () => {
    const file = saveSession('gmail', [SID_COOKIE], 'proxy-ipvanish-nyc');
    assert.ok(fs.existsSync(file));
    assert.ok(file.endsWith('gmail.json'));

    const loaded = loadSession('gmail');
    assert.strictEqual(loaded.cookies.length, 1);
    assert.strictEqual(loaded.cookies[0]!.name, 'SID');
    assert.strictEqual(loaded.source, 'proxy-ipvanish-nyc');
    assert.ok(loaded.capturedAt);
  });

  it('sanitizes unsafe names and lists sessions', () => {
    saveSession('my ../../evil', [SID_COOKIE]);
    const lists = listSessions();
    const first = lists[0];
    assert.ok(first);
    assert.strictEqual(lists.length, 1);
    // path traversal is neutralized
    assert.ok(!fs.existsSync(path.join(testDir, '..', 'evil.json')));
    assert.strictEqual(first.cookieCount, 1);
  });

  it('blocks overwrite unless forced, and health flags auth tokens + expiry', () => {
    saveSession('x', [SID_COOKIE]);
    assert.throws(() => saveSession('x', [{ ...SID_COOKIE, name: 'NID' }]));

    const force = saveSession('x', [{ ...SID_COOKIE, name: 'NID' }], undefined, true);
    assert.ok(force);

    const expired = sessionHealth({
      name: 'x',
      capturedAt: '',
      cookies: [{ ...SID_COOKIE, expires: 1 }],
    });
    assert.strictEqual(expired.expired, 1);
    assert.strictEqual(expired.hasAuthTokens, true);

    assert.strictEqual(deleteSession('x'), sessionFilePath('x'));
    assert.strictEqual(deleteSession('x'), '');
  });
});
