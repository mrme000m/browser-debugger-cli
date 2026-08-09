/**
 * Human-readable formatter for a single CBM profile.
 *
 * Mirrors cbpm's formatProfile in CloakBrowser-Manager/cli/src/format.ts,
 * adapted to bdg's joinLines style and bdg's CbmProfile type (where
 * proxy_group / proxy_credential are unknown and must be narrowed safely).
 */

import type { CbmProfile } from '@/commands/cloak/types.js';
import { joinLines } from '@/ui/formatting.js';

/** A named backend reference (proxy group / credential) - only `name` is used here. */
interface NamedRef {
  name?: string;
  rotation_mode?: string;
}

/** Format a duration in seconds as a compact human string (e.g. "3m 12s"). */
function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Narrow an unknown profile reference to its name (or undefined). */
function refName(ref: unknown): string | undefined {
  if (ref && typeof ref === 'object' && 'name' in ref) {
    const name = (ref as NamedRef).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

/** Render the proxy line: rotation group, saved credential, inline URL, or none. */
function proxyDisplay(p: CbmProfile): string {
  const groupName = refName(p.proxy_group);
  const credName = refName(p.proxy_credential);
  if (groupName) {
    const group = p.proxy_group as NamedRef;
    return group.rotation_mode
      ? `group: ${groupName} (${group.rotation_mode})`
      : `group: ${groupName}`;
  }
  if (credName) return `cred: ${credName}`;
  return p.proxy ?? '—';
}

/** Render runtime resources as a single "CPU% · mem · uptime" line, or ''. */
function formatResourcesLine(p: CbmProfile): string {
  const r = p.resources;
  if (r == null) return '';
  if (r.cpu_percent == null && r.mem_mb == null && r.uptime_s == null) return '';
  const parts: string[] = [];
  if (r.cpu_percent != null) parts.push(`CPU ${r.cpu_percent}%`);
  if (r.mem_mb != null) parts.push(`${r.mem_mb}MB`);
  if (r.uptime_s != null) parts.push(formatUptime(r.uptime_s));
  return parts.join(' · ');
}

/** Format a single profile as a multi-line key/value block. */
export function formatProfile(p: CbmProfile, fingerprintMode = false): string {
  const tags = p.tags.map((t) => t.tag).join(', ') || '—';
  const proxy = proxyDisplay(p);
  const res = formatResourcesLine(p);
  const cohere = p.coherence_warnings;

  const lines: (string | undefined)[] = [
    `${p.name}  ${p.is_template ? '[TEMPLATE]' : ''}  (${p.status})`,
    `  id:              ${p.id}`,
    `  platform:        ${p.platform}`,
    `  fingerprint_seed: ${p.fingerprint_seed}`,
    ...(p.persona ? [`  persona:         ${p.persona}`] : []),
  ];

  if (fingerprintMode) {
    // ── Fingerprint-focused compact view ──
    lines.push(undefined, '  ── fingerprint ──');
    lines.push(
      `  device-memory:    ${p.device_memory ?? '—'} GB       hw-concurrency: ${p.hardware_concurrency ?? '—'}`
    );
    lines.push(`  brand:            ${p.brand ?? 'auto'}    version: ${p.brand_version ?? 'auto'}`);
    lines.push(`  platform-version: ${p.platform_version ?? '—'}`);
    lines.push(`  gpu:              ${p.gpu_vendor ?? '—'}`);
    lines.push(`  gpu-renderer:     ${p.gpu_renderer ?? '—'}`);
    lines.push(`  fonts-dir:        ${p.fonts_dir ?? '—'}`);
    lines.push(`  user-agent:       ${truncate(p.user_agent ?? 'auto', 60)}`);
    if (p.noise_enabled !== undefined) {
      lines.push(
        `  noise:            ${p.noise_enabled ? 'enabled (unique per seed)' : 'disabled (stable identity)'}`
      );
    }

    lines.push(undefined, '  ── screen ──');
    const scale = p.device_scale_factor ? `  scale: ${p.device_scale_factor}` : '';
    lines.push(`  resolution:       ${p.screen_width}x${p.screen_height}${scale}`);
    const tb = p.taskbar_height != null ? `  taskbar: ${p.taskbar_height}px` : '';
    if (tb) lines.push(tb);

    lines.push(undefined, '  ── geolocation ──');
    if (p.geolocation_lat != null && p.geolocation_lon != null) {
      lines.push(`  lat/lon:          ${p.geolocation_lat}, ${p.geolocation_lon}`);
    }
    lines.push(`  webrtc-ip:        ${p.webrtc_ip ?? (proxy !== '—' ? 'auto (from proxy)' : '—')}`);

    lines.push(undefined, '  ── network ──');
    lines.push(`  proxy:            ${proxy}`);
    lines.push(`  timezone/locale:  ${p.timezone ?? '—'} / ${p.locale ?? '—'}`);
    lines.push(`  geoip:            ${p.geoip}  color-scheme: ${p.color_scheme ?? 'auto'}`);

    lines.push(undefined, '  ── hygiene ──');
    lines.push(
      `  clear-on-launch:  ${p.clear_on_launch ? 'yes' : 'no'}  storage-quota: ${p.storage_quota_mb ? `${p.storage_quota_mb}MB` : '—'}`
    );
    lines.push(`  is-mobile:        ${p.is_mobile}  has-touch: ${p.has_touch}`);
    const perms = (p.permissions ?? []).join(', ');
    if (perms) lines.push(`  permissions:      ${perms}`);
    const exts = (p.extension_paths ?? []).join(', ');
    if (exts) lines.push(`  extensions:       ${exts}`);

    lines.push(undefined, '  ── behavior ──');
    lines.push(
      `  humanize:         ${p.humanize ? `yes (${p.human_preset})` : 'no'}  headless: ${p.headless}`
    );
    lines.push(
      `  auto_launch:      ${p.auto_launch}  restart: ${p.restart_on_crash} (max ${p.max_restarts})`
    );
  } else {
    // ── Standard view ──
    lines.push(`  proxy:            ${proxy}`);
    lines.push(`  timezone/locale:  ${p.timezone ?? '—'} / ${p.locale ?? '—'}`);
    lines.push(`  screen:           ${p.screen_width}x${p.screen_height}`);
    lines.push(
      `  gpu:              ${p.gpu_vendor ?? '—'} / ${truncate(p.gpu_renderer ?? '—', 50)}`
    );
    lines.push(
      `  hw-concurrency:   ${p.hardware_concurrency ?? '—'}  device-memory: ${p.device_memory ? `${p.device_memory}GB` : '—'}`
    );
    lines.push(`  brand:            ${p.brand ?? 'auto'} v${p.brand_version ?? 'auto'}`);
    lines.push(
      `  webrtc-ip:        ${p.webrtc_ip ?? (proxy !== '—' ? 'auto' : '—')}  noise: ${p.noise_enabled ? 'on' : 'off'}`
    );
    lines.push(
      `  humanize:         ${p.humanize ? `yes (${p.human_preset})` : 'no'}  geoip: ${p.geoip}  headless: ${p.headless}`
    );
    lines.push(
      `  clear-on-launch:  ${p.clear_on_launch ? 'yes' : 'no'}  scale-factor: ${p.device_scale_factor ?? '—'}`
    );
    lines.push(
      `  auto_launch:      ${p.auto_launch}  restart_on_crash: ${p.restart_on_crash} (max ${p.max_restarts})`
    );
    lines.push(`  tags:             ${tags}`);
  }

  lines.push(`  cdp_endpoint:     ${p.cdp_endpoint ?? '—'}`);
  if (res) lines.push(`  resources:        ${res}`);
  if (p.notes) lines.push(`  notes:            ${p.notes}`);

  // ── Coherence warnings ──
  if (cohere && cohere.length > 0) {
    const label = `  ⚠  coherence:      ${cohere.length} warning${cohere.length > 1 ? 's' : ''}`;
    lines.push(undefined, label);
    for (const w of cohere) {
      lines.push(`     ${w}`);
    }
  }

  return joinLines(...lines);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
