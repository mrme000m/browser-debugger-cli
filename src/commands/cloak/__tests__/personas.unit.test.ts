/**
 * Cloak personas formatter unit tests.
 *
 * Locks `bdg cloak personas` output (GET /api/personas): the persona list
 * rendering and the empty-server message.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatPersonas } from '@/commands/cloak/personas.js';

void describe('cloak personas formatPersonas', () => {
  void it('lists personas with name, platform, and label', () => {
    const out = formatPersonas({
      personas: [
        { name: 'win11-rtx3070-desktop', label: 'Win11 + RTX 3070 desktop', platform: 'windows' },
        { name: 'mac-m2-air', label: 'MacBook Air M2', platform: 'macos' },
      ],
    });
    assert.ok(out.includes('2 persona(s)'));
    assert.ok(out.includes('win11-rtx3070-desktop'));
    assert.ok(out.includes('windows'));
    assert.ok(out.includes('Win11 + RTX 3070 desktop'));
    assert.ok(out.includes('mac-m2-air'));
    assert.ok(out.includes('MacBook Air M2'));
    assert.ok(
      out.includes('bdg cloak create --persona'),
      'should tell the user how to apply a persona'
    );
  });

  void it('handles an empty persona list', () => {
    assert.equal(formatPersonas({ personas: [] }), 'No personas available on this CBM server.');
  });
});
