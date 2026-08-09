/**
 * `bdg cloak status` command.
 *
 * Fetches CBM server status via GET /api/status.
 * Mirrors: cbpm status command in CloakBrowser-Manager/cli/src/commands/status.ts
 */

import type { Command } from 'commander';

import { cbmGet } from '@/commands/cloak/client.js';
import type { CbmSystemStatus } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Status command options. */
type StatusOptions = BaseOptions;

/**
 * Format status data for human-readable output.
 */
function formatStatus(data: CbmSystemStatus): string {
  const lines: (string | undefined)[] = [
    `CBM Server Status`,
    `  Version:     ${data.binary_version}`,
    `  Profiles:    ${data.profiles_total} total, ${data.running_count} running`,
  ];
  // Guards use `!= null` (loose) so both `null` (server set it to null) and
  // `undefined` (older server omits the field entirely) are treated as
  // "not present" — otherwise an absent field renders as "undefined".
  if (data.max_running != null) lines.push(`  Max running: ${data.max_running}`);
  if (data.total_cpu_percent != null) lines.push(`  CPU:         ${data.total_cpu_percent}%`);
  if (data.total_mem_mb != null) lines.push(`  Memory:      ${data.total_mem_mb} MB`);
  return joinLines(...lines);
}

/**
 * Register the `cloak status` subcommand.
 */
export function registerCloakStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show CloakBrowser Manager server status')
    .addOption(jsonOption())
    .action(async (options: StatusOptions) => {
      await runCommand<StatusOptions, CbmSystemStatus>(
        async () => {
          const result = await cbmGet<CbmSystemStatus>('/api/status');

          if (!result.success) {
            return {
              success: false,
              error: result.error ?? 'Failed to fetch CBM status',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion:
                  'Check that CBPM_API_URL is set correctly and the CBM server is running.',
              },
            };
          }

          const data = result.data;
          if (!data) {
            return {
              success: false,
              error: 'CBM returned no status data',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion:
                  'Check that CBPM_API_URL is set correctly and the CBM server is running.',
              },
            };
          }

          return {
            success: true,
            data,
          };
        },
        options,
        formatStatus
      );
    });
}
