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
export function formatProfile(p: CbmProfile): string {
  const tags = p.tags.map((t) => t.tag).join(', ') || '—';
  const proxy = proxyDisplay(p);
  const res = formatResourcesLine(p);
  return joinLines(
    `${p.name}  ${p.is_template ? '[TEMPLATE]' : ''}  (${p.status})`,
    `  id:              ${p.id}`,
    `  platform:        ${p.platform}`,
    `  fingerprint_seed: ${p.fingerprint_seed}`,
    `  proxy:            ${proxy}`,
    `  timezone/locale:  ${p.timezone ?? '—'} / ${p.locale ?? '—'}`,
    `  screen:           ${p.screen_width}x${p.screen_height}`,
    `  humanize:         ${p.humanize ? `yes (${p.human_preset})` : 'no'}  geoip: ${p.geoip}  headless: ${p.headless}`,
    `  auto_launch:      ${p.auto_launch}  restart_on_crash: ${p.restart_on_crash} (max ${p.max_restarts})`,
    `  tags:             ${tags}`,
    `  cdp_endpoint:     ${p.cdp_endpoint ?? '—'}`,
    res ? `  resources:       ${res}` : undefined,
    p.notes ? `  notes:           ${p.notes}` : undefined
  );
}
