/**
 * CBM Config Resolution Unit Tests
 *
 * Tests getCbmApiConfig() with env var and config file scenarios.
 * Verifies precedence: env vars \> config file \> defaults.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getCbmApiConfig } from '@/commands/cloak/config.js';

const ENV_API_URL = 'CBPM_API_URL';
const ENV_API_TOKEN = 'CBPM_API_TOKEN';
const CONFIG_DIR = '.cbpm';
const CONFIG_FILE = 'config.json';

void describe('CBM Config Resolution', () => {
  let savedUrl: string | undefined;
  let savedToken: string | undefined;
  let savedHome: string | undefined;
  let tmpHome: string | undefined;

  beforeEach(() => {
    savedUrl = process.env[ENV_API_URL];
    savedToken = process.env[ENV_API_TOKEN];
    savedHome = process.env['HOME'];
    delete process.env[ENV_API_URL];
    delete process.env[ENV_API_TOKEN];

    // Isolate the config file: redirect HOME to an empty temp dir so
    // readConfigFile() looks for <tmp>/.cbpm/config.json (which doesn't
    // exist) instead of the user's real ~/.cbpm/config.json. Without this,
    // a token stored via `cbpm auth login` (or any real config) leaks in
    // and breaks the "token defaults to ''" assertions. homedir() honors
    // HOME at call time (no caching), verified below.
    tmpHome = mkdtempSync(join(tmpdir(), 'cbm-cfg-test-'));
    process.env['HOME'] = tmpHome;
    assert.equal(homedir(), tmpHome);
  });

  afterEach(() => {
    if (savedUrl !== undefined) {
      process.env[ENV_API_URL] = savedUrl;
    } else {
      delete process.env[ENV_API_URL];
    }
    if (savedToken !== undefined) {
      process.env[ENV_API_TOKEN] = savedToken;
    } else {
      delete process.env[ENV_API_TOKEN];
    }
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

  /** Write a fake ~/.cbpm/config.json into the isolated tmp HOME. */
  function writeConfigFile(contents: Record<string, unknown>): void {
    if (!tmpHome) throw new Error('tmpHome not initialized');
    const dir = join(tmpHome, CONFIG_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(contents), 'utf-8');
  }

  void it('uses CBPM_API_URL env var when set', () => {
    process.env[ENV_API_URL] = 'http://cbm.example.com:8080';

    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://cbm.example.com:8080');
    assert.equal(config.token, '');
  });

  void it('uses both CBPM_API_URL and CBPM_API_TOKEN env vars when set', () => {
    process.env[ENV_API_URL] = 'http://cbm.example.com:8080';
    process.env[ENV_API_TOKEN] = 'secret-token';

    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://cbm.example.com:8080');
    assert.equal(config.token, 'secret-token');
  });

  void it('falls back to default URL when no env vars are set', () => {
    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://127.0.0.1:8080');
  });

  void it('env var takes precedence when only URL is set', () => {
    process.env[ENV_API_URL] = 'http://remote:9090';

    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://remote:9090');
  });

  void it('strips trailing slash from api_url', () => {
    process.env[ENV_API_URL] = 'http://cbm.example.com:8080/';

    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://cbm.example.com:8080');
  });

  void it('reads api_url and token from the config file when no env vars set', () => {
    writeConfigFile({
      api_url: 'http://from-file.example.com:9090',
      token: 'file-token-abc',
    });

    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://from-file.example.com:9090');
    assert.equal(config.token, 'file-token-abc');
  });

  void it('env vars take precedence over the config file', () => {
    writeConfigFile({
      api_url: 'http://from-file.example.com:9090',
      token: 'file-token-abc',
    });
    process.env[ENV_API_URL] = 'http://from-env.example.com:8080';
    process.env[ENV_API_TOKEN] = 'env-token-xyz';

    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://from-env.example.com:8080');
    assert.equal(config.token, 'env-token-xyz');
  });

  void it('uses env url with config-file token when only url env is set', () => {
    writeConfigFile({
      api_url: 'http://from-file.example.com:9090',
      token: 'file-token-abc',
    });
    process.env[ENV_API_URL] = 'http://from-env.example.com:8080';

    const config = getCbmApiConfig();

    assert.equal(config.api_url, 'http://from-env.example.com:8080');
    // token falls through to the config file value
    assert.equal(config.token, 'file-token-abc');
  });
});
