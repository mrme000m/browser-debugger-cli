/**
 * `bdg cloak launch` and `bdg cloak stop` commands.
 *
 * launch: POST /api/profiles/:id/launch → CbmLaunchResult
 * stop:   POST /api/profiles/:id/stop   → CbmOkResponse
 *
 * Mirrors: cbpm profiles launch/stop in CloakBrowser-Manager/cli/src/commands/profiles.ts
 */

import type { Command } from 'commander';

import { cbmPost } from '@/commands/cloak/client.js';
import type { CbmLaunchResult, CbmOkResponse } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Launch command options. */
type LaunchOptions = BaseOptions;
/** Stop command options. */
type StopOptions = BaseOptions;

/**
 * Format launch result for human-readable output.
 */
function formatLaunch(data: CbmLaunchResult): string {
  return joinLines(
    `Profile launched: ${data.profile_id}`,
    `  Status:    ${data.status}`,
    `  Display:   ${data.display}`,
    `  VNC port:  ${data.vnc_ws_port}`,
    data.cdp_endpoint ? `  CDP:       ${data.cdp_endpoint}` : undefined
  );
}

/**
 * Register the `cloak launch` subcommand.
 */
export function registerCloakLaunchCommand(program: Command): void {
  program
    .command('launch')
    .description('Launch a CloakBrowser profile')
    .argument('<id>', 'Profile ID to launch')
    .addOption(jsonOption())
    .action(async (id: string, options: LaunchOptions) => {
      await runCommand<LaunchOptions, CbmLaunchResult>(
        async () => {
          const result = await cbmPost<CbmLaunchResult>(
            `/api/profiles/${encodeURIComponent(id)}/launch`
          );

          if (!result.success) {
            return {
              success: false,
              error: result.error ?? `Failed to launch profile '${id}'`,
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion:
                  'Verify the profile ID exists and is not already running. Check: bdg cloak profiles',
              },
            };
          }

          const data = result.data;
          if (!data) {
            return {
              success: false,
              error: 'CBM returned no data for launch',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
            };
          }

          return {
            success: true,
            data,
          };
        },
        options,
        formatLaunch
      );
    });
}

/**
 * Register the `cloak stop` subcommand.
 */
export function registerCloakStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Stop a CloakBrowser profile')
    .argument('<id>', 'Profile ID to stop')
    .addOption(jsonOption())
    .action(async (id: string, options: StopOptions) => {
      await runCommand<StopOptions, CbmOkResponse>(
        async () => {
          const result = await cbmPost<CbmOkResponse>(
            `/api/profiles/${encodeURIComponent(id)}/stop`
          );

          if (!result.success) {
            return {
              success: false,
              error: result.error ?? `Failed to stop profile '${id}'`,
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion:
                  'Verify the profile ID exists and is running. Check: bdg cloak profiles',
              },
            };
          }

          const data = result.data;
          if (!data) {
            return {
              success: false,
              error: 'CBM returned no data for stop',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
            };
          }

          if (!data.ok) {
            return {
              success: false,
              error: `Server returned ok=false for profile '${id}'`,
              exitCode: EXIT_CODES.RESOURCE_BUSY,
            };
          }

          return {
            success: true,
            data,
          };
        },
        options,
        (data: CbmOkResponse) => (data.ok ? 'Profile stopped.' : 'Stop failed.')
      );
    });
}
