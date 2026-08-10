/**
 * cloak storage-state formatter unit tests.
 *
 * Locks the three modes (upload / clear / inspect) of `bdg cloak storage-state`.
 * The command's HTTP wiring is exercised via the cbm client contract; these
 * tests cover the pure formatter + the counts helper's behaviour via results.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatStorageState, type StorageStateResult } from '@/commands/cloak/storageState.js';

void describe('cloak storage-state formatStorageState', () => {
  it('renders upload mode with counts', () => {
    const r: StorageStateResult = {
      profile_id: 'shop',
      mode: 'upload',
      cookies_count: 3,
      origins_count: 1,
    };
    const out = formatStorageState(r);
    assert.ok(out.includes('Uploaded storage_state for shop'));
    assert.ok(out.includes('cookies: 3'));
    assert.ok(out.includes('origins: 1'));
  });

  it('renders clear mode', () => {
    const r: StorageStateResult = {
      profile_id: 'shop',
      mode: 'clear',
      cookies_count: 0,
      origins_count: 0,
    };
    const out = formatStorageState(r);
    assert.ok(out.includes('Cleared stored storage_state for shop'));
  });

  it('renders inspect mode with counts when state is stored', () => {
    const r: StorageStateResult = {
      profile_id: 'shop',
      mode: 'inspect',
      cookies_count: 5,
      origins_count: 2,
      has_state: true,
    };
    const out = formatStorageState(r);
    assert.ok(out.includes('Stored storage_state for shop'));
    assert.ok(out.includes('cookies: 5'));
    assert.ok(out.includes('origins: 2'));
  });

  it('renders the none message when no state is stored', () => {
    const r: StorageStateResult = {
      profile_id: 'shop',
      mode: 'inspect',
      cookies_count: 0,
      origins_count: 0,
      has_state: false,
    };
    const out = formatStorageState(r);
    assert.ok(out.includes('No storage_state stored for shop'));
    assert.ok(out.includes('--file <path>'));
  });
});
