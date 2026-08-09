/**
 * Static field schema for `bdg cloak create` - the self-explaining creation surface.
 *
 * Mirrors the backend `ProfileCreate` model (and cbpm's schema module in
 * CloakBrowser-Manager/cli/src/schema.ts) so the create surface is discoverable
 * without docs: `bdg cloak create --list-fields` and `bdg cloak create --describe FIELD`.
 *
 * bdg keeps its own copy (it cannot import cbpm at runtime) - kept in sync with cbpm.
 */

export interface FieldSchema {
  /** Backend field name (snake_case). */
  name: string;
  /** CLI flag (kebab-case, with -- prefix). */
  flag: string;
  /** Value type: "int" | "string" | "bool" | "list[string]" | "enum:a|b". */
  type: string;
  /** Whether the field is required on create. */
  required: boolean;
  /** String representation of the default, or "—" if none. */
  default: string;
  /** Short human-readable description. */
  description: string;
  /** Optional example value for --describe. */
  example?: string;
}

export const PROFILE_FIELDS: FieldSchema[] = [
  {
    name: 'name',
    flag: '--name',
    type: 'string',
    required: true,
    default: '—',
    description: 'Profile display name.',
    example: 'shop-us-1',
  },
  {
    name: 'fingerprint_seed',
    flag: '--fingerprint-seed',
    type: 'int',
    required: false,
    default: 'random',
    description: 'Stable device-identity seed. Omit for a random per-profile identity.',
    example: '1234567',
  },
  {
    name: 'proxy',
    flag: '--proxy',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Inline proxy URL (http://user:pass@host:port or socks5://...).',
    example: 'socks5://u:p@host:1080',
  },
  {
    name: 'proxy_credential_id',
    flag: '--proxy-credential',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Saved proxy credential id. Mutually exclusive with --proxy/--proxy-group.',
    example: '<cred-id>',
  },
  {
    name: 'proxy_group_id',
    flag: '--proxy-group',
    type: 'string',
    required: false,
    default: 'null',
    description: "Proxy rotation group id; a member is chosen per the group's rotation_mode.",
    example: '<group-id>',
  },
  {
    name: 'timezone',
    flag: '--timezone',
    type: 'string',
    required: false,
    default: 'null',
    description: 'IANA timezone injected into the browser.',
    example: 'America/New_York',
  },
  {
    name: 'locale',
    flag: '--locale',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Browser locale (BCP-47).',
    example: 'en-US',
  },
  {
    name: 'platform',
    flag: '--platform',
    type: 'enum:windows|macos|linux',
    required: false,
    default: 'windows',
    description: 'Fingerprint platform.',
    example: 'macos',
  },
  {
    name: 'user_agent',
    flag: '--user-agent',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Override User-Agent.',
    example: 'Mozilla/5.0 ...',
  },
  {
    name: 'screen_width',
    flag: '--screen-width',
    type: 'int',
    required: false,
    default: '1920',
    description: 'Viewport/screen width.',
    example: '1366',
  },
  {
    name: 'screen_height',
    flag: '--screen-height',
    type: 'int',
    required: false,
    default: '1080',
    description: 'Viewport/screen height.',
    example: '768',
  },
  {
    name: 'gpu_vendor',
    flag: '--gpu-vendor',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Spoofed GPU vendor string.',
    example: 'Apple',
  },
  {
    name: 'gpu_renderer',
    flag: '--gpu-renderer',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Spoofed GPU renderer string.',
    example: 'Apple M2',
  },
  {
    name: 'hardware_concurrency',
    flag: '--hardware-concurrency',
    type: 'int',
    required: false,
    default: 'null',
    description: 'navigator.hardwareConcurrency override.',
    example: '8',
  },
  {
    name: 'device_memory',
    flag: '--device-memory',
    type: 'float',
    required: false,
    default: 'null',
    description:
      'navigator.deviceMemory in GB. Real Chrome only reports 0.25/0.5/1/2/4/8 (capped at 8).',
    example: '8',
  },
  {
    name: 'brand',
    flag: '--brand',
    type: 'enum:chrome|edge|opera|vivaldi',
    required: false,
    default: 'null',
    description: 'Sec-CH-UA browser brand.',
    example: 'chrome',
  },
  {
    name: 'brand_version',
    flag: '--brand-version',
    type: 'string',
    required: false,
    default: 'null',
    description:
      'Sec-CH-UA browser version. Leave unset to derive from the CloakBrowser binary Chromium version (recommended — a mismatch with the UA is a bot tell).',
    example: '146.0.7680.177.5',
  },
  {
    name: 'platform_version',
    flag: '--platform-version',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Sec-CH-UA-Platform-Version (e.g. 10.0.19045 for Windows, 13_5_1 for macOS).',
    example: '10.0.19045',
  },
  {
    name: 'fonts_dir',
    flag: '--fonts-dir',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Directory with target-platform fonts for font fingerprinting.',
    example: '/data/fonts/win10',
  },
  {
    name: 'storage_quota_mb',
    flag: '--storage-quota',
    type: 'int',
    required: false,
    default: 'null',
    description: 'Override storage quota reported through Storage APIs (MB).',
    example: '4096',
  },
  {
    name: 'taskbar_height',
    flag: '--taskbar-height',
    type: 'int',
    required: false,
    default: 'null',
    description: 'Taskbar height in px, subtracted from availHeight.',
    example: '40',
  },
  {
    name: 'geolocation_lat',
    flag: '--geolocation-lat',
    type: 'float',
    required: false,
    default: 'null',
    description: 'Geolocation latitude.',
    example: '40.7128',
  },
  {
    name: 'geolocation_lon',
    flag: '--geolocation-lon',
    type: 'float',
    required: false,
    default: 'null',
    description: 'Geolocation longitude.',
    example: '-74.0060',
  },
  {
    name: 'webrtc_ip',
    flag: '--webrtc-ip',
    type: 'string',
    required: false,
    default: 'null',
    description: 'WebRTC ICE candidate IP override (auto, disabled, or explicit IP).',
    example: 'auto',
  },
  {
    name: 'noise_enabled',
    flag: '--noise-enabled',
    type: 'bool',
    required: false,
    default: 'true',
    description:
      'Enable canvas/WebGL/audio/client-rect noise (disable for stable returning-user identity).',
    example: 'false',
  },
  {
    name: 'clear_on_launch',
    flag: '--clear-on-launch',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Wipe cookies/cache/storage before every launch.',
    example: 'true',
  },
  {
    name: 'device_scale_factor',
    flag: '--device-scale-factor',
    type: 'float',
    required: false,
    default: 'null',
    description: 'Device pixel ratio override (e.g. 1.0, 2.0).',
    example: '2.0',
  },
  {
    name: 'is_mobile',
    flag: '--is-mobile',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Emulate a mobile device.',
    example: 'true',
  },
  {
    name: 'has_touch',
    flag: '--has-touch',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Emulate touch screen support.',
    example: 'true',
  },
  {
    name: 'humanize',
    flag: '--humanize',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Enable human-like mouse/keyboard motion.',
    example: 'true',
  },
  {
    name: 'human_preset',
    flag: '--human-preset',
    type: 'enum:default|careful',
    required: false,
    default: 'default',
    description: 'Humanization preset (only with --humanize).',
    example: 'careful',
  },
  {
    name: 'headless',
    flag: '--headless',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Run without a visible window (no VNC view).',
    example: 'true',
  },
  {
    name: 'geoip',
    flag: '--geoip',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Match timezone/locale to the proxy exit IP.',
    example: 'true',
  },
  {
    name: 'clipboard_sync',
    flag: '--clipboard-sync',
    type: 'bool',
    required: false,
    default: 'true',
    description: 'Sync clipboard between host and VNC.',
    example: 'false',
  },
  {
    name: 'auto_launch',
    flag: '--auto-launch',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Launch on manager startup.',
    example: 'true',
  },
  {
    name: 'color_scheme',
    flag: '--color-scheme',
    type: 'enum:light|dark|no-preference',
    required: false,
    default: 'null',
    description: 'Preferred color scheme.',
    example: 'dark',
  },
  {
    name: 'launch_args',
    flag: '--launch-arg',
    type: 'list[string]',
    required: false,
    default: '[]',
    description: 'Extra Chromium args. Repeat the flag for multiple values.',
    example: '--launch-arg --disable-features=Foo',
  },
  {
    name: 'notes',
    flag: '--notes',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Free-form notes.',
    example: 'shop account #3',
  },
  {
    name: 'is_template',
    flag: '--is-template',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Mark as a template (cannot be launched; clone to create runnable profiles).',
    example: 'true',
  },
  {
    name: 'restart_on_crash',
    flag: '--restart-on-crash',
    type: 'bool',
    required: false,
    default: 'false',
    description: 'Auto-restart the browser if it exits unexpectedly.',
    example: 'true',
  },
  {
    name: 'max_restarts',
    flag: '--max-restarts',
    type: 'int',
    required: false,
    default: '5',
    description:
      'Max crash-restart attempts (with --restart-on-crash). Exponential backoff, capped 60s.',
    example: '3',
  },
  {
    name: 'human_config',
    flag: '--human-config',
    type: 'string',
    required: false,
    default: 'null',
    description: 'Custom humanization overrides as JSON (typing_delay, mouse_wobble_max, etc.).',
    example: '{"typing_delay":120,"mistype_chance":0.05}',
  },
  {
    name: 'extension_paths',
    flag: '--extension-path',
    type: 'list[string]',
    required: false,
    default: '[]',
    description: 'Chrome extension paths to load. Repeat the flag for multiple values.',
    example: '--extension-path /data/ext/ublock',
  },
  {
    name: 'permissions',
    flag: '--permission',
    type: 'list[string]',
    required: false,
    default: '[]',
    description: 'Browser permissions. Repeat the flag for multiple values.',
    example: '--permission geolocation --permission notifications',
  },
  {
    name: 'storage_state',
    flag: '--storage-state',
    type: 'string',
    required: false,
    default: 'null',
    description:
      'JSON file path containing Playwright storage_state to pre-seed cookies/localStorage.',
    example: '/data/state.json',
  },
  {
    name: 'persona',
    flag: '--persona',
    type: 'string',
    required: false,
    default: 'null',
    description:
      'Coherent real-world device persona (sets screen/GPU/cores/memory/DPR/platform-version together). Run `bdg cloak personas` for the list.',
    example: 'win11-rtx3070-desktop',
  },
  {
    name: 'tags',
    flag: '--tag',
    type: 'list[string]',
    required: false,
    default: 'null',
    description: 'Tags. Repeat the flag for multiple values; optional `tag:color` form.',
    example: '--tag shop --tag us:red',
  },
];

/** Return the full field schema (for --list-fields). */
export function listFields(): FieldSchema[] {
  return PROFILE_FIELDS;
}

/** Find a field by name (snake_case) or flag (kebab-case, with or without --). */
export function findField(query: string): FieldSchema | undefined {
  const q = query.replace(/^--/, '').replace(/-/g, '_');
  return PROFILE_FIELDS.find((f) => f.name === q) ?? PROFILE_FIELDS.find((f) => f.name === query);
}

/** Levenshtein-based "did you mean" suggestions. */
export function suggestFields(query: string, limit = 3): FieldSchema[] {
  const q = query.toLowerCase();
  const scored = PROFILE_FIELDS.map((f) => ({
    f,
    d: levenshtein(q, f.name.replace(/_/g, '-')),
  })).sort((a, b) => a.d - b.d);
  return scored.slice(0, limit).map((s) => s.f);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0] ?? 0;
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i] ?? 0;
      dp[i] = Math.min(tmp + 1, (dp[i - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m] ?? 0;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Render the full field table for `--list-fields` (no API call). */
export function fieldsTable(): string {
  const rows = listFields().map((f) => ({
    flag: f.flag,
    type: truncate(f.type.replace('enum:', ''), 16),
    required: f.required ? 'yes' : '',
    default: f.default,
    desc: truncate(f.description, 48),
  }));
  const head = `${'flag'.padEnd(22)} ${'type'.padEnd(16)} ${'req'.padEnd(4)} ${'default'.padEnd(8)} description`;
  return [
    head,
    ...rows.map(
      (r) =>
        `${r.flag.padEnd(22)} ${r.type.padEnd(16)} ${r.required.padEnd(4)} ${r.default.padEnd(8)} ${r.desc}`
    ),
  ].join('\n');
}

/** Render a single-field description for `--describe` (no API call). */
export function describeField(name: string): string {
  const f = findField(name);
  if (!f) {
    const sugg = suggestFields(name).map((s) => s.flag);
    return [
      `Unknown field: --${name.replace(/^--/, '')}`,
      sugg.length ? `Did you mean: ${sugg.join(', ')}?` : '',
      'Run `bdg cloak create --list-fields` to see all fields.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `${f.flag}  (${f.type})`,
    `  ${f.description}`,
    `  required: ${f.required ? 'yes' : 'no'}   default: ${f.default}`,
    f.example ? `  example: ${f.example}` : '',
    '',
    'Example:',
    `  bdg cloak create --name <n> ${f.flag} ${f.example ?? '<value>'}`,
  ]
    .filter(Boolean)
    .join('\n');
}
