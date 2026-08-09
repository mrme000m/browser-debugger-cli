/**
 * Cloak profile formatter unit tests.
 *
 * Locks the `persona` line in `bdg cloak get` output (both the standard and
 * `--fingerprint` views): it appears when set and is omitted when null.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatProfile } from '@/commands/cloak/format.js';
import type { CbmProfile } from '@/commands/cloak/types.js';

/** Build a minimal valid CbmProfile with optional overrides. */
function baseProfile(overrides: Partial<CbmProfile> = {}): CbmProfile {
  return {
    id: 'p1',
    name: 'demo',
    fingerprint_seed: 12345,
    proxy: null,
    proxy_credential_id: null,
    proxy_credential: null,
    proxy_group_id: null,
    proxy_group: null,
    timezone: null,
    locale: null,
    platform: 'windows',
    user_agent: null,
    screen_width: 1920,
    screen_height: 1080,
    gpu_vendor: null,
    gpu_renderer: null,
    hardware_concurrency: null,
    device_memory: null,
    brand: null,
    brand_version: null,
    platform_version: null,
    fonts_dir: null,
    storage_quota_mb: null,
    taskbar_height: null,
    geolocation_lat: null,
    geolocation_lon: null,
    webrtc_ip: null,
    noise_enabled: true,
    humanize: false,
    human_preset: 'default',
    human_config: null,
    headless: false,
    geoip: false,
    clipboard_sync: true,
    auto_launch: false,
    clear_on_launch: false,
    storage_state: null,
    permissions: null,
    device_scale_factor: null,
    is_mobile: false,
    has_touch: false,
    extension_paths: null,
    persona: null,
    color_scheme: null,
    launch_args: [],
    notes: null,
    is_template: false,
    restart_on_crash: false,
    max_restarts: 5,
    user_data_dir: '/tmp',
    created_at: '',
    updated_at: '',
    tags: [],
    status: 'stopped',
    vnc_ws_port: null,
    cdp_url: null,
    cdp_endpoint: null,
    resources: null,
    coherence_warnings: [],
    ...overrides,
  };
}

void describe('cloak formatProfile persona display', () => {
  void it('shows the persona line in the standard view when set', () => {
    const out = formatProfile(baseProfile({ persona: 'win11-rtx3070-desktop' }));
    assert.ok(/persona:\s+win11-rtx3070-desktop/.test(out), 'persona line should appear');
  });

  void it('omits the persona line when persona is null', () => {
    const out = formatProfile(baseProfile({ persona: null }));
    assert.ok(!/persona:/.test(out), 'no persona line when persona is unset');
  });

  void it('shows the persona line in the --fingerprint view when set', () => {
    const out = formatProfile(baseProfile({ persona: 'mac-m2-air' }), true);
    assert.ok(/persona:\s+mac-m2-air/.test(out), 'persona line should appear in fingerprint view');
  });
});
