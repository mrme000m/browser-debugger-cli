/**
 * `bdg cloak update <id>` command.
 *
 * Partially updates a managed profile via PUT /api/profiles/:id (only provided
 * fields are sent). Reuses the same PROFILE_FIELDS flags as `create`. Accepts
 * a profile UUID or name. Mirrors cbpm's `profiles update`.
 */

import type { Command } from 'commander';

import { cbmPut } from '@/commands/cloak/client.js';
import { formatProfile } from '@/commands/cloak/format.js';
import { applyProfileOptions, bodyFromOptions } from '@/commands/cloak/profileOptions.js';
import { exitCodeFromStatus, withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Update options: --json plus the dynamic profile-field flags. */
type UpdateOptions = BaseOptions & Record<string, unknown>;

/**
 * Register the `cloak update` subcommand.
 */
export function registerCloakUpdateCommand(program: Command): void {
  const update = program
    .command('update')
    .description('Update a CloakBrowser-managed profile (only provided fields change)')
    .argument('<id>', 'Profile ID or name to update')
    .addOption(jsonOption());
  applyProfileOptions(update);

  update.action(async (id: string, options: UpdateOptions) => {
    await runCommand<UpdateOptions, CbmProfile>(
      async (opts) => {
        const body = bodyFromOptions(opts);
        if (Object.keys(body).length === 0) {
          return {
            success: false,
            error:
              'No fields provided to update. Run `bdg cloak create --list-fields` for available flags.',
            exitCode: EXIT_CODES.INVALID_ARGUMENTS,
          };
        }
        const result = await withProfileId<CbmProfile>(id, (pid) =>
          cbmPut<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`, body)
        );
        if (!result.success) {
          return {
            success: false,
            error: result.error ?? `Failed to update profile '${id}'`,
            exitCode: exitCodeFromStatus(result.statusCode),
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
            exitCode: EXIT_CODES.SOFTWARE_ERROR,
          };
        }
        return { success: true, data };
      },
      options,
      formatProfile
    );
  });
}
