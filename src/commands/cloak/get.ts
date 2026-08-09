/**
 * `bdg cloak get <id>` command.
 *
 * Fetches a single managed profile via GET /api/profiles/:id and prints its full
 * details. Accepts a profile UUID or name (resolves names via the list on 404).
 */

import type { Command } from 'commander';

import { cbmGet } from '@/commands/cloak/client.js';
import { formatProfile } from '@/commands/cloak/format.js';
import { withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

type GetOptions = BaseOptions;

/**
 * Register the `cloak get` subcommand.
 */
export function registerCloakGetCommand(program: Command): void {
  program
    .command('get')
    .description("Show a CloakBrowser-managed profile's full details")
    .argument('<id>', 'Profile ID or name to fetch')
    .addOption(jsonOption())
    .action(async (id: string, options: GetOptions) => {
      await runCommand<GetOptions, CbmProfile>(
        async () => {
          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmGet<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`)
          );

          if (!result.success) {
            return {
              success: false,
              error: result.error ?? `Failed to fetch profile '${id}'`,
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion: 'Verify the profile exists. List profiles with: bdg cloak profiles',
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
                suggestion: 'Verify the profile exists. List profiles with: bdg cloak profiles',
              },
            };
          }

          return { success: true, data };
        },
        options,
        formatProfile
      );
    });
}
