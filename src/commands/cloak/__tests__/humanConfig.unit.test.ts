/**
 * cloak human-config reference unit tests.
 *
 * The SDK's `merge_config` silently ignores unknown `--human-config` keys, so
 * the static table must (a) contain the real keys and (b) be duplicate-free,
 * since `bodyFromOptions` validates against `HUMAN_CONFIG_KEYS`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HUMAN_CONFIG_FIELDS,
  HUMAN_CONFIG_KEYS,
  humanConfigTable,
} from '@/commands/cloak/humanConfig.js';

void describe('cloak human-config reference', () => {
  it('exposes a non-empty set of keys', () => {
    assert.ok(HUMAN_CONFIG_KEYS.size > 20, `expected many keys, got ${HUMAN_CONFIG_KEYS.size}`);
  });

  it('contains the well-known humanization knobs', () => {
    for (const k of [
      'typing_delay',
      'mistype_chance',
      'mouse_wobble_max',
      'mouse_overshoot_chance',
      'scroll_delta_base',
      'idle_between_actions',
      'initial_cursor_x',
      'initial_cursor_y',
    ]) {
      assert.ok(HUMAN_CONFIG_KEYS.has(k), `missing expected key '${k}'`);
    }
  });

  it('has no duplicate keys across the field table and the key set', () => {
    const names = HUMAN_CONFIG_FIELDS.map((f) => f.key);
    assert.equal(new Set(names).size, names.length, 'duplicate keys in HUMAN_CONFIG_FIELDS');
    assert.equal(names.length, HUMAN_CONFIG_KEYS.size, 'field count != key set size');
  });

  it('every field has a non-empty key, type, and description', () => {
    for (const f of HUMAN_CONFIG_FIELDS) {
      assert.ok(f.key, `field missing key: ${JSON.stringify(f)}`);
      assert.ok(f.type, `field '${f.key}' missing type`);
      assert.ok(f.description, `field '${f.key}' missing description`);
    }
  });

  it('renders a table containing the header and at least one key', () => {
    const table = humanConfigTable();
    assert.ok(table.includes('key'));
    assert.ok(table.includes('typing_delay'));
    assert.ok(table.includes('description'));
  });
});
