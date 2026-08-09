/**
 * Cloak schema unit tests.
 *
 * Locks the auto-discoverable create surface (`--list-fields` / `--describe`)
 * to the CBM v0.6.0+ organic-fingerprint contract: the persona field, the
 * device_memory float + cap-8 guidance, and the brand_version "leave unset"
 * recommendation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeField, fieldsTable, findField, listFields } from '@/commands/cloak/schema.js';

void describe('cloak schema (auto-discoverable create surface)', () => {
  void it('exposes the persona field pointing at bdg cloak personas', () => {
    const persona = findField('persona');
    assert.ok(persona, 'persona field should exist');
    assert.equal(persona?.flag, '--persona');
    assert.equal(persona?.type, 'string');
    assert.equal(persona?.required, false);
    assert.ok(
      persona?.description.includes('bdg cloak personas'),
      'description should point users at `bdg cloak personas`'
    );
  });

  void it('lists persona in PROFILE_FIELDS', () => {
    const names = listFields().map((f) => f.name);
    assert.ok(names.includes('persona'), 'persona must appear in --list-fields');
  });

  void it('types device_memory as float with the cap-8 guidance', () => {
    const dm = findField('device_memory');
    assert.ok(dm, 'device_memory field should exist');
    assert.equal(dm?.type, 'float', 'device_memory must be float (0.25/0.5/etc)');
    assert.ok(dm?.description.includes('capped at 8'), 'must mention the cap at 8');
  });

  void it('brand_version recommends leaving unset with a 146 example', () => {
    const bv = findField('brand_version');
    assert.ok(bv, 'brand_version field should exist');
    assert.ok(
      bv?.description.toLowerCase().includes('leave unset'),
      'must recommend leaving brand_version unset to derive from the binary'
    );
    assert.equal(bv?.example, '146.0.7680.177.5');
  });

  void it('fieldsTable includes the persona row', () => {
    assert.ok(fieldsTable().includes('--persona'));
  });

  void it('describeField(persona) documents the flag and the personas command', () => {
    const out = describeField('persona');
    assert.ok(out.includes('--persona'));
    assert.ok(out.includes('bdg cloak personas'));
  });

  void it('findField tolerates -- prefix and kebab-case', () => {
    assert.ok(findField('--persona'));
    assert.ok(findField('brand-version'));
    assert.ok(findField('device-memory'));
  });
});
