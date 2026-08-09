/**
 * Cookie-dump scanning contract tests.
 *
 * Focus: Netscape parsing, full-session detection, profile scan + load.
 */

import * as fs from 'fs';
import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as os from 'os';
import * as path from 'path';

import {
  cookiesFromProfile,
  parseNetscapeCookies,
  scanCookieDump,
} from '@/session/cookieDumpScan.js';

describe('Cookie dump scanning', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-cookiescan-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeProfile(name: string, lines: string[], gaLine?: boolean) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'Cookies'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Cookies', 'Google Chrome_Default.txt'),
      lines.join('\n') + '\n'
    );
    if (gaLine) {
      fs.mkdirSync(path.join(dir, 'GoogleAccounts'));
      fs.writeFileSync(
        path.join(dir, 'GoogleAccounts', 'Google Chrome_Default.txt'),
        '//t0ken123\n'
      );
    }
    return dir;
  }

  it('parses Netscape cookies', () => {
    const f = path.join(root, 'c.txt');
    fs.writeFileSync(f, ['.google.com\tTRUE\t/\tFALSE\t1840000000\tNID\tabc'].join('\n'));
    const c = parseNetscapeCookies(f);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0]!.name, 'NID');
    assert.strictEqual(c[0]!.hostOnly, false);
    assert.strictEqual(c[0]!.value, 'abc');
  });

  it('flags a full session only when auth cookies (or account line) are present', () => {
    makeProfile(
      'AEfuls',
      [
        '.google.com\tTRUE\t/\tTRUE\t1840000000\tSID\tg.a',
        '.google.com\tTRUE\t/\tTRUE\t1840000000\tSSID\th',
      ],
      true
    );
    makeProfile('AFanon', ['.example.com\tFALSE\t/\tFALSE\t1840000000\tuid\t1']);

    const s = scanCookieDump(root);
    assert.strictEqual(s.length, 2);
    const fullP = s.find((p) => p.dir.endsWith('AEfuls'));
    assert.ok(fullP);
    assert.strictEqual(fullP.fullSession, true);
    assert.ok(fullP.authCookies >= 2);
    const anon = s.find((p) => p.dir.endsWith('AFanon'));
    assert.ok(anon?.fullSession === false);
  });

  it('collapses cookies into CDP params and honors google httpOnly', () => {
    const dir = makeProfile('E', ['.google.com\tTRUE\t/\tTRUE\t1840000000\tSID\tg.a']);
    const params = cookiesFromProfile(dir);
    assert.strictEqual(params.length, 1);
    const sid = params[0]!;
    assert.strictEqual(sid['httpOnly'], true);
    assert.strictEqual(sid['secure'], true);
  });
});
