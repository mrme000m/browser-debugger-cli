/**
 * `bdg cloak clone <id>` command.
 *
 * Clones a managed profile via POST /api/profiles/:id/clone (the clone gets a
 * new random fingerprint seed). Accepts an optional --name and a profile UUID
 * or name. Mirrors cbpm's `profiles clone`.
 */

import type { Command } from 'commander';

import { cbmPost } from '@/commands/cloak/client.js';
import { formatProfile } from '@/commands/cloak/format.js';
import { exitCodeFromStatus, withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

interface CloneOptions extends BaseOptions {
  name?: string;
}

/**
 * Register the `cloak clone` subcommand.
 */
export function registerCloakCloneCommand(program: Command): void {
  program
    .command('clone')
    .description('Clone a CloakBrowser-managed profile (new random fingerprint seed)')
    .argument('<id>', 'Profile ID or name to clone')
    .option('--name <name>', 'Name for the clone')
    .addOption(jsonOption())
    .action(async (id: string, options: CloneOptions) => {
      await runCommand<CloneOptions, CbmProfile>(
        async (opts) => {
          const body = opts.name ? { name: opts.name } : {};
          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmPost<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}/clone`, body)
          );
          if (!result.success) {
            return {
              success: false,
              error: result.error ?? `Failed to clone profile '${id}'`,
              exitCode: exitCodeFromStatus(result.statusCode),
              errorContext: {
                suggestion:
                  'Verify the source profile exists. List profiles with: bdg cloak profiles',
              },
            };
          }
          const data = result.data;
          if (!data) {
            return {
              success: false,
              error: 'CBM returned no profile data',
              exitCode: EXIT_CODES.SOFTWARE_ERROR,
            };
          }
          return { success: true, data };
        },
        options,
        (p: CbmProfile): string => `${formatProfile(p)}\n\nCloned from ${id}`
      );
    });
}
