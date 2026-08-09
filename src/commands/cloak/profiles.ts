/**
 * `bdg cloak profiles` command.
 *
 * Fetches managed profiles via GET /api/profiles with optional tag and status filters.
 * The CBM API returns Profile[] directly (no wrapper object).
 */

import type { Command } from 'commander';

import { cbmGet } from '@/commands/cloak/client.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Profiles command options. */
interface ProfilesOptions extends BaseOptions {
  /** Filter by tag. */
  tag?: string;
  /** Filter by status. */
  status?: 'running' | 'stopped';
}

/**
 * Format a duration in seconds as a compact human string (e.g. "3m 12s").
 */
function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Format profile resources for the list row.
 * Returns "" when not running or no stats available (handles both null and
 * undefined — older servers omit the field entirely).
 */
function formatResources(profile: CbmProfile): string {
  if (profile.status !== 'running') return '';
  const r = profile.resources;
  if (r == null) return '';
  if (r.cpu_percent == null && r.mem_mb == null) return '';
  const parts: string[] = [];
  if (r.cpu_percent != null) parts.push(`CPU ${r.cpu_percent}%`);
  if (r.mem_mb != null) parts.push(`${r.mem_mb}MB`);
  if (r.uptime_s != null) parts.push(formatUptime(r.uptime_s));
  return parts.length > 0 ? `  ${parts.join(' · ')}` : '';
}

/**
 * Format profiles data for human-readable output.
 */
function formatProfiles(data: { profiles: CbmProfile[] }): string {
  const { profiles } = data;

  if (profiles.length === 0) {
    return 'No profiles found.';
  }

  const lines = profiles.map((p) => {
    const statusIcon = p.status === 'running' ? '▶' : '■';
    const tagStr = p.tags.length > 0 ? ` [${p.tags.map((t) => t.tag).join(', ')}]` : '';
    const portInfo = p.vnc_ws_port ? ` VNC:${p.vnc_ws_port}` : '';
    const resInfo = formatResources(p);
    const warnIcon = (p.coherence_warnings ?? []).length > 0 ? ' ⚠' : '';
    return `  ${statusIcon} ${p.id}  ${p.name}${tagStr}  ${p.status}${portInfo}${warnIcon}${resInfo}`;
  });

  return joinLines(`${profiles.length} profile(s):`, ...lines);
}

/**
 * Register the `cloak profiles` subcommand.
 */
export function registerCloakProfilesCommand(program: Command): void {
  program
    .command('profiles')
    .description('List managed CloakBrowser profiles')
    .option('--tag <tag>', 'Filter profiles by tag')
    .option('--status <status>', 'Filter by status: running or stopped')
    .addOption(jsonOption())
    .action(async (options: ProfilesOptions) => {
      await runCommand<ProfilesOptions, { profiles: CbmProfile[] }>(
        async (opts) => {
          const result = await cbmGet<CbmProfile[]>('/api/profiles');

          if (!result.success) {
            return {
              success: false,
              error: result.error ?? 'Failed to fetch CBM profiles',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion: 'Check that the CBM server is running and reachable.',
              },
            };
          }

          const data = result.data;
          if (!data) {
            return {
              success: false,
              error: 'CBM returned no profile data',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion: 'Check that the CBM server is running and reachable.',
              },
            };
          }

          let profiles = data;

          // Client-side filtering (API returns all profiles)
          if (opts.tag) {
            profiles = profiles.filter((p) => p.tags.some((t) => t.tag === opts.tag));
          }
          if (opts.status) {
            profiles = profiles.filter((p) => p.status === opts.status);
          }

          return {
            success: true,
            data: { profiles },
          };
        },
        options,
        formatProfiles
      );
    });
}
