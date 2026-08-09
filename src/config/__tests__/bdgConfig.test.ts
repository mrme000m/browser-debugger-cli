/**
 * bdg general configuration unit tests.
 *
 * Tests getBdgConfig() and parseHeadersObject() — config-file resolution,
 * env overrides, and per-field precedence (env over file).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getBdgConfig, parseHeadersObject } from '@/config/bdgConfig.js';

const ENV_CONFIG_FILE = 'BDG_CONFIG_FILE';
const ENV_CHROME_WS_URL = 'BDG_CHROME_WS_URL';
const ENV_CDP_HEADERS = 'BDG_CDP_HEADERS';
const ENV_XDG = 'XDG_CONFIG_HOME';

void describe('bdg config resolution', () => {
  let savedConfigFile: string | undefined;
  let savedWsUrl: string | undefined;
  let savedHeaders: string | undefined;
  let savedXdg: string | undefined;
  let savedHome: string | undefined;
  let tmpHome: string | undefined;
  let tmpConfigPath: string | undefined;

  beforeEach(() => {
    savedConfigFile = process.env[ENV_CONFIG_FILE];
    savedWsUrl = process.env[ENV_CHROME_WS_URL];
    savedHeaders = process.env[ENV_CDP_HEADERS];
    savedXdg = process.env[ENV_XDG];
    savedHome = process.env['HOME'];
    delete process.env[ENV_CONFIG_FILE];
    delete process.env[ENV_CHROME_WS_URL];
    delete process.env[ENV_CDP_HEADERS];
    delete process.env[ENV_XDG];

    // Isolate the XDG/home fallback so the user's real
    // ~/.config/bdg/config.json never leaks in. homedir() honors HOME at
    // call time (no caching), verified below.
    tmpHome = mkdtempSync(join(tmpdir(), 'bdg-cfg-test-'));
    process.env['HOME'] = tmpHome;
    assert.equal(homedir(), tmpHome);
    tmpConfigPath = join(tmpHome, 'bdg-config.json');
  });

  afterEach(() => {
    const restore = (key: string, saved: string | undefined): void => {
      if (saved !== undefined) {
        process.env[key] = saved;
      } else {
        delete process.env[key];
      }
    };
    restore(ENV_CONFIG_FILE, savedConfigFile);
    restore(ENV_CHROME_WS_URL, savedWsUrl);
    restore(ENV_CDP_HEADERS, savedHeaders);
    restore(ENV_XDG, savedXdg);
    if (savedHome !== undefined) {
      process.env['HOME'] = savedHome;
    } else {
      delete process.env['HOME'];
    }
    if (tmpHome !== undefined) {
      rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = undefined;
    }
  });

  /** Write a config file and point BDG_CONFIG_FILE at it. */
  function writeConfigFile(contents: Record<string, unknown>): void {
    if (!tmpConfigPath) throw new Error('tmpConfigPath not initialized');
    writeFileSync(tmpConfigPath, JSON.stringify(contents), 'utf-8');
    process.env[ENV_CONFIG_FILE] = tmpConfigPath;
  }

  void it('returns undefined fields when nothing is configured', () => {
    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, undefined);
    assert.equal(cfg.cdpHeaders, undefined);
  });

  void it('reads chromeWsUrl and cdpHeaders from the config file', () => {
    writeConfigFile({
      chromeWsUrl: 'wss://cloak.example.com/api/profiles/abc/cdp/devtools/page/1',
      cdpHeaders: { Authorization: 'Bearer file-token' },
    });

    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, 'wss://cloak.example.com/api/profiles/abc/cdp/devtools/page/1');
    assert.deepEqual(cfg.cdpHeaders, { Authorization: 'Bearer file-token' });
  });

  void it('reads chromeWsUrl from the BDG_CHROME_WS_URL env var', () => {
    process.env[ENV_CHROME_WS_URL] = 'ws://localhost:9222/devtools/page/1';

    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, 'ws://localhost:9222/devtools/page/1');
    assert.equal(cfg.cdpHeaders, undefined);
  });

  void it('reads cdpHeaders from the BDG_CDP_HEADERS env var (JSON string)', () => {
    process.env[ENV_CDP_HEADERS] = '{"Authorization":"Bearer env-token"}';

    const cfg = getBdgConfig();

    assert.deepEqual(cfg.cdpHeaders, { Authorization: 'Bearer env-token' });
  });

  void it('env vars take precedence over the config file', () => {
    writeConfigFile({
      chromeWsUrl: 'wss://from-file.example.com/cdp',
      cdpHeaders: { Authorization: 'Bearer file-token' },
    });
    process.env[ENV_CHROME_WS_URL] = 'wss://from-env.example.com/cdp';
    process.env[ENV_CDP_HEADERS] = '{"Authorization":"Bearer env-token"}';

    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, 'wss://from-env.example.com/cdp');
    assert.deepEqual(cfg.cdpHeaders, { Authorization: 'Bearer env-token' });
  });

  void it('mixes env url with config-file headers (independent fields)', () => {
    writeConfigFile({
      chromeWsUrl: 'wss://from-file.example.com/cdp',
      cdpHeaders: { Authorization: 'Bearer file-token' },
    });
    process.env[ENV_CHROME_WS_URL] = 'wss://from-env.example.com/cdp';

    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, 'wss://from-env.example.com/cdp');
    assert.deepEqual(cfg.cdpHeaders, { Authorization: 'Bearer file-token' });
  });

  void it('falls back to XDG_CONFIG_HOME when BDG_CONFIG_FILE is unset', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'bdg-xdg-'));
    process.env[ENV_XDG] = xdg;
    mkdirSync(join(xdg, 'bdg'), { recursive: true });
    writeFileSync(
      join(xdg, 'bdg', 'config.json'),
      JSON.stringify({ chromeWsUrl: 'wss://xdg.example.com/cdp' }),
      'utf-8'
    );

    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, 'wss://xdg.example.com/cdp');
    rmSync(xdg, { recursive: true, force: true });
  });

  void it('ignores a malformed config file (returns undefined fields)', () => {
    if (!tmpConfigPath) throw new Error('tmpConfigPath not initialized');
    writeFileSync(tmpConfigPath, '{ not valid json', 'utf-8');
    process.env[ENV_CONFIG_FILE] = tmpConfigPath;

    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, undefined);
    assert.equal(cfg.cdpHeaders, undefined);
  });

  void it('ignores non-string chromeWsUrl and non-object cdpHeaders in the file', () => {
    writeConfigFile({ chromeWsUrl: 123, cdpHeaders: 'not-an-object' });

    const cfg = getBdgConfig();

    assert.equal(cfg.chromeWsUrl, undefined);
    assert.equal(cfg.cdpHeaders, undefined);
  });
});

void describe('parseHeadersObject', () => {
  void it('parses a valid JSON object string', () => {
    assert.deepEqual(parseHeadersObject('{"Authorization":"Bearer X"}'), {
      Authorization: 'Bearer X',
    });
  });

  void it('returns undefined for empty / undefined input', () => {
    assert.equal(parseHeadersObject(undefined), undefined);
    assert.equal(parseHeadersObject(''), undefined);
  });

  void it('returns undefined for malformed JSON', () => {
    assert.equal(parseHeadersObject('{ not json'), undefined);
  });

  void it('returns undefined for arrays and primitives', () => {
    assert.equal(parseHeadersObject('["a","b"]'), undefined);
    assert.equal(parseHeadersObject('"a-string"'), undefined);
    assert.equal(parseHeadersObject('123'), undefined);
    assert.equal(parseHeadersObject('null'), undefined);
  });
});
