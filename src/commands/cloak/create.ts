/**
 * `bdg cloak create` command.
 *
 * Creates a managed profile via POST /api/profiles. The full option surface is
 * generated from PROFILE_FIELDS (one flag per field) and is self-explaining:
 * - `bdg cloak create --list-fields` lists every field.
 * - `bdg cloak create --describe FIELD` describes one field.
 *
 * Mirrors cbpm's `profiles create`.
 */

import type { Command } from 'commander';

import { cbmPost } from '@/commands/cloak/client.js';
import { formatProfile } from '@/commands/cloak/format.js';
import { applyProfileOptions, bodyFromOptions } from '@/commands/cloak/profileOptions.js';
import { exitCodeFromStatus } from '@/commands/cloak/resolve.js';
import { describeField, fieldsTable, findField, listFields } from '@/commands/cloak/schema.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { buildSuccessResponse } from '@/ui/OutputBuilder.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Create options: --json, --list-fields, --describe, plus the dynamic profile-field flags. */
type CreateOptions = BaseOptions & { listFields?: boolean; describe?: string } & Record<
    string,
    unknown
  >;

/**
 * Register the `cloak create` subcommand.
 */
export function registerCloakCreateCommand(program: Command): void {
  const create = program
    .command('create')
    .description(
      'Create a CloakBrowser-managed profile. Use --list-fields to discover every option.'
    )
    .addOption(jsonOption())
    .option('--list-fields', 'List every create field with type/default (no API call)')
    .option('--describe <field>', 'Describe one field (no API call)');
  applyProfileOptions(create);

  create.action(async (options: CreateOptions) => {
    // Self-explaining short-circuits (no API call, no --name required).
    if (options.listFields) {
      if (options.json) {
        console.log(JSON.stringify(buildSuccessResponse(listFields()), null, 2));
      } else {
        console.log(fieldsTable());
      }
      process.exit(EXIT_CODES.SUCCESS);
    }
    if (options.describe) {
      const field = findField(options.describe);
      console.log(describeField(options.describe));
      process.exit(field ? EXIT_CODES.SUCCESS : EXIT_CODES.INVALID_ARGUMENTS);
    }

    await runCommand<CreateOptions, CbmProfile>(
      async (opts) => {
        if (!opts['name']) {
          return {
            success: false,
            error: '--name is required. Run `bdg cloak create --list-fields` to see all options.',
            exitCode: EXIT_CODES.INVALID_ARGUMENTS,
          };
        }
        const built = bodyFromOptions(opts);
        if (built.error) {
          return {
            success: false,
            error: built.error,
            exitCode: built.exitCode ?? EXIT_CODES.INVALID_ARGUMENTS,
            errorContext: {
              suggestion:
                'A JSON field (--storage-state / --human-config) could not be parsed. ' +
                'See `bdg cloak create --list-fields` and `bdg cloak human-config`.',
            },
          };
        }
        const body = built.body;
        const result = await cbmPost<CbmProfile>('/api/profiles', body);
        if (!result.success) {
          return {
            success: false,
            error: result.error ?? 'Failed to create profile',
            exitCode: exitCodeFromStatus(result.statusCode),
            errorContext: {
              suggestion:
                'A profile with this name may already exist, or a field value was rejected. ' +
                'See `bdg cloak create --list-fields` for valid options.',
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
        return {
          success: true,
          data,
          ...(built.warnings?.length ? { hint: built.warnings.join('\n') } : {}),
        };
      },
      options,
      formatProfile
    );
  });
}
