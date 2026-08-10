/**
 * cloak check formatCheck unit tests.
 *
 * Locks the coherence dry-run formatter: the clean (0 warnings) message, the
 * warnings list, and the analyze-vs-check hint.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatCheck, type CoherenceReport } from '@/commands/cloak/check.js';

void describe('cloak check formatCheck', () => {
  it('renders a clean report with the analyze hint', () => {
    const r: CoherenceReport = { profile_id: 'p1', count: 0, warnings: [] };
    const out = formatCheck(r);
    assert.ok(out.includes('Coherence Check — p1'));
    assert.ok(out.includes('warnings: 0'));
    assert.ok(out.includes('coherent — no static cross-field warnings'));
    assert.ok(out.includes('bdg cloak analyze p1'));
  });

  it('renders each warning and the fix hint', () => {
    const r: CoherenceReport = {
      profile_id: 'p2',
      count: 2,
      warnings: [
        'GPU renderer does not look like Windows (expected Direct3D11).',
        'odd core count',
      ],
    };
    const out = formatCheck(r);
    assert.ok(out.includes('warnings: 2'));
    assert.ok(out.includes('Coherence Warnings (2)'));
    assert.ok(out.includes('GPU renderer does not look like Windows (expected Direct3D11).'));
    assert.ok(out.includes('odd core count'));
    assert.ok(out.includes('bdg cloak update'));
    assert.ok(out.includes('bdg cloak check p2'));
  });

  it('uses the profile id in the clean hint', () => {
    const r: CoherenceReport = { profile_id: 'us-shop-3', count: 0, warnings: [] };
    const out = formatCheck(r);
    assert.ok(out.includes('bdg cloak analyze us-shop-3'));
  });
});
