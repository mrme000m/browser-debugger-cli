/**
 * Cloak analyze formatter unit tests.
 *
 * Locks `bdg cloak analyze` output to CBM's live detection-report contract:
 * per-signal `checks` (status / actual / expected / detail), the warnings
 * count, the error line, the no-checks hint, and the legacy `details[]`
 * fallback for pre-v0.6 servers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatAnalysis, type AnalysisInput } from '@/commands/cloak/analyze.js';

void describe('cloak analyze formatAnalysis', () => {
  void it('renders the new checks[] shape with actual/expected/detail', () => {
    const input: AnalysisInput = {
      profile_id: 'p1',
      passed: 2,
      failed: 1,
      warnings: 1,
      checks: [
        {
          test: 'User Agent',
          status: 'pass',
          actual: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) …',
          expected: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) …',
          detail: 'UA↔Sec-CH-UA major matches',
        },
        {
          test: 'WebGL Renderer',
          status: 'fail',
          actual: 'SwiftShader',
          expected: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 …)',
          detail: 'runtime renderer does not match the profile',
        },
        {
          test: 'WebRTC IP leak',
          status: 'warn',
          actual: ['1.2.3.4'],
          expected: 'proxy IP only',
          detail: 'could not verify against the proxy exit IP',
        },
      ],
      coherence_warnings: [],
    };
    const out = formatAnalysis(input);

    assert.ok(out.includes('Detection Test Results — p1'));
    assert.ok(out.includes('Passed:  2   Failed:  1   Warnings:  1'));
    assert.ok(out.includes('── Checks ──'));
    assert.ok(
      out.includes(
        '✅ User Agent: actual="Mozilla/5.0 (Windows NT 10.0; Win64; x64) …" expected="Mozilla/5.0 (Windows NT 10.0; Win64; x64) …" — UA↔Sec-CH-UA major matches'
      )
    );
    assert.ok(
      out.includes(
        '❌ WebGL Renderer: actual="SwiftShader" expected="ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 …)" — runtime renderer does not match the profile'
      )
    );
    assert.ok(
      out.includes(
        '⚠ WebRTC IP leak: actual=["1.2.3.4"] expected="proxy IP only" — could not verify against the proxy exit IP'
      )
    );
  });

  void it('renders coherence warnings', () => {
    const out = formatAnalysis({
      profile_id: 'p2',
      passed: 0,
      failed: 0,
      coherence_warnings: ['GPU renderer does not look like Windows (expected Direct3D11).'],
    });
    assert.ok(out.includes('Coherence Warnings (1)'));
    assert.ok(out.includes('GPU renderer does not look like Windows (expected Direct3D11).'));
  });

  void it('renders the error line (no Checks section, hint suppressed) when the launch errors', () => {
    const out = formatAnalysis({ profile_id: 'p3', error: 'launch failed', checks: [] });
    assert.ok(out.includes('⚠  Error: launch failed'));
    assert.ok(!out.includes('── Checks ──'), 'no Checks section when checks is empty');
    assert.ok(!out.includes('no checks returned'), 'hint suppressed when an error is present');
  });

  void it('shows the no-checks hint when there is no error and no checks', () => {
    const out = formatAnalysis({ profile_id: 'p3b' });
    assert.ok(out.includes('no checks returned'));
  });

  void it('falls back to the legacy details[] shape for pre-v0.6 servers', () => {
    const input: AnalysisInput = {
      profile_id: 'p4',
      passed: 1,
      failed: 1,
      details: [
        { test: 'User Agent', result: 'OK' },
        { test: 'WebDriver', result: 'Fail' },
      ],
    };
    const out = formatAnalysis(input);
    assert.ok(out.includes('Checks (legacy server)'));
    assert.ok(out.includes('✅ User Agent: OK'));
    assert.ok(out.includes('❌ WebDriver: Fail'));
  });

  void it('formats null and undefined actual/expected safely', () => {
    const out = formatAnalysis({
      profile_id: 'p5',
      checks: [{ test: 'T', status: 'pass', actual: null, expected: undefined, detail: '' }],
    });
    assert.ok(out.includes('actual=null'));
    assert.ok(out.includes('expected=—'));
  });

  void it('truncates long string values', () => {
    const long = 'x'.repeat(200);
    const out = formatAnalysis({
      profile_id: 'p6',
      checks: [{ test: 'T', status: 'pass', actual: long, expected: long, detail: '' }],
    });
    assert.ok(out.includes('…'), 'long values should be truncated with an ellipsis');
  });
});
