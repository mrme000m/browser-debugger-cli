/**
 * jsonField.parseJsonObject unit tests.
 *
 * Covers the file-or-inline resolution, the plain-object requirement, and the
 * error messages — the behaviour `bdg cloak create|update` relies on for the
 * dict-typed fields (storage_state / human_config).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseJsonObject } from '@/commands/cloak/jsonField.js';

void describe('cloak jsonField parseJsonObject', () => {
  let tmp: string;

  function tmpFile(contents: string): string {
    const p = join(tmp, `state-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, contents, 'utf-8');
    return p;
  }

  describe('inline JSON', () => {
    it('parses an inline JSON object', () => {
      const r = parseJsonObject('{"cookies":[],"origins":[]}', 'storage_state');
      assert.ok(r.ok, 'should parse');
      if (r.ok) assert.deepEqual(r.value, { cookies: [], origins: [] });
    });

    it('parses human_config inline JSON', () => {
      const r = parseJsonObject('{"typing_delay":120}', 'human_config');
      assert.ok(r.ok);
      if (r.ok) assert.equal(r.value['typing_delay'], 120);
    });

    it('rejects a JSON array (not a plain object)', () => {
      const r = parseJsonObject('[1,2,3]', 'storage_state');
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /must be a JSON object.*got array/);
    });

    it('rejects a JSON primitive', () => {
      const r = parseJsonObject('42', 'human_config');
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /must be a JSON object/);
    });

    it('rejects null', () => {
      const r = parseJsonObject('null', 'storage_state');
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /got null/);
    });

    it('rejects malformed JSON with a helpful message', () => {
      const r = parseJsonObject('{not json', 'storage_state');
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /--storage-state is not valid JSON/);
    });
  });

  describe('file path', () => {
    it('reads + parses an existing file path', () => {
      tmp = mkdtempSync(join(tmpdir(), 'jsonfield-'));
      try {
        const p = tmpFile('{"cookies":[{"name":"s"}]}');
        const r = parseJsonObject(p, 'storage_state');
        assert.ok(r.ok);
        if (r.ok) assert.deepEqual(r.value, { cookies: [{ name: 's' }] });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('reports the file path on a malformed-file parse error', () => {
      tmp = mkdtempSync(join(tmpdir(), 'jsonfield-'));
      try {
        const p = tmpFile('{broken');
        const r = parseJsonObject(p, 'storage_state');
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.error, /file:/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('edge cases', () => {
    it('rejects an empty string', () => {
      const r = parseJsonObject('', 'human_config');
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /--human-config is empty/);
    });
  });
});
