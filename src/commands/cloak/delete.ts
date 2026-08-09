/**
 * `bdg cloak delete <id>` command.
 *
 * Deletes a managed profile via DELETE /api/profiles/:id (stops the browser
 * first if running). Accepts a profile UUID or name. Mirrors cbpm's
 * `profiles delete` - no confirmation prompt, so it stays scriptable.
 */

import type { Command } from 'commander';

import { cbmDelete } from '@/commands/cloak/client.js';
import { exitCodeFromStatus, withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmOkResponse } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';

type DeleteOptions = BaseOptions;

/** Delete result returned in --json mode. */
interface DeleteResult {
  ok: boolean;
  id: string;
}

/**
 * Register the `cloak delete` subcommand.
 */
export function registerCloakDeleteCommand(program: Command): void {
  program
    .command('delete')
    .description(
      'Delete a CloakBrowser-managed profile and its browser data (stops first if running)'
    )
    .argument('<id>', 'Profile ID or name to delete')
    .addOption(jsonOption())
    .action(async (id: string, options: DeleteOptions) => {
      await runCommand<DeleteOptions, DeleteResult>(
        async () => {
          const result = await withProfileId<CbmOkResponse>(id, (pid) =>
            cbmDelete<CbmOkResponse>(`/api/profiles/${encodeURIComponent(pid)}`)
          );
          if (!result.success) {
            return {
              success: false,
              error: result.error ?? `Failed to delete profile '${id}'`,
              exitCode: exitCodeFromStatus(result.statusCode),
              errorContext: {
                suggestion: 'Verify the profile exists. List profiles with: bdg cloak profiles',
              },
            };
          }
          return { success: true, data: { ok: true, id } };
        },
        options,
        (): string => `Deleted ${id}`
      );
    });
}
