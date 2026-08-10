/**
 * profileOptions.bodyFromOptions unit tests.
 *
 * Verifies the dict-typed fields are parsed (not forwarded as raw strings),
 * that unknown --human-config keys produce a soft warning, and that a parse
 * failure returns an INVALID_ARGUMENTS error instead of a bad request body.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { bodyFromOptions } from '@/commands/cloak/profileOptions.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

void describe('cloak profileOptions bodyFromOptions', () => {
  it('omits dict-typed fields entirely when not provided', () => {
    const { body, error, warnings } = bodyFromOptions({ name: 'shop' });
    assert.equal(error, undefined);
    assert.equal(warnings, undefined);
    assert.equal('storage_state' in body, false);
    assert.equal('human_config' in body, false);
    assert.equal(body['name'], 'shop');
  });

  it('parses inline storage_state JSON into a dict', () => {
    const { body, error } = bodyFromOptions({ storageState: '{"cookies":[{"name":"s"}]}' });
    assert.equal(error, undefined);
    assert.deepEqual(body['storage_state'], { cookies: [{ name: 's' }] });
  });

  it('parses storage_state from a file path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bodyfromopts-'));
    try {
      const p = join(tmp, 'state.json');
      writeFileSync(p, '{"cookies":[],"origins":[]}', 'utf-8');
      const { body, error } = bodyFromOptions({ storageState: p });
      assert.equal(error, undefined);
      assert.deepEqual(body['storage_state'], { cookies: [], origins: [] });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns an INVALID_ARGUMENTS error on malformed storage_state', () => {
    const { body, error, exitCode } = bodyFromOptions({ storageState: '{bad' });
    assert.ok(error, 'should have an error');
    assert.equal(exitCode, EXIT_CODES.INVALID_ARGUMENTS);
    assert.equal('storage_state' in body, false);
  });

  it('parses inline human_config JSON into a dict', () => {
    const { body, error, warnings } = bodyFromOptions({
      humanConfig: '{"typing_delay":120,"mouse_wobble_max":2.0}',
    });
    assert.equal(error, undefined);
    assert.deepEqual(body['human_config'], { typing_delay: 120, mouse_wobble_max: 2.0 });
    // all known keys -> no warnings
    assert.equal(warnings, undefined);
  });

  it('warns on unknown human_config keys', () => {
    const { body, error, warnings } = bodyFromOptions({
      humanConfig: '{"typing_delay":120,"typo_delay":1}',
    });
    assert.equal(error, undefined);
    assert.deepEqual(body['human_config'], { typing_delay: 120, typo_delay: 1 });
    assert.ok(warnings?.length);
    assert.match(warnings.join('\n'), /'typo_delay'/);
    assert.match(warnings.join('\n'), /bdg cloak human-config/);
  });

  it('returns an INVALID_ARGUMENTS error on malformed human_config', () => {
    const { error, exitCode } = bodyFromOptions({ humanConfig: '[1,2]' });
    assert.ok(error);
    assert.equal(exitCode, EXIT_CODES.INVALID_ARGUMENTS);
  });

  it('still forwards scalar/list fields unchanged', () => {
    const { body, error } = bodyFromOptions({
      name: 'shop',
      timezone: 'America/New_York',
      launchArg: ['--disable-features=Foo', '--disable-features=Bar'],
    });
    assert.equal(error, undefined);
    assert.equal(body['name'], 'shop');
    assert.equal(body['timezone'], 'America/New_York');
    assert.deepEqual(body['launch_args'], ['--disable-features=Foo', '--disable-features=Bar']);
  });
});
