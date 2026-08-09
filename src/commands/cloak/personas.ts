/**
 * `bdg cloak personas` command.
 *
 * Lists the coherent real-world device personas CBM knows about, via
 * GET /api/personas. Each persona bundles a consistent screen/GPU/cores/
 * memory/DPR/platform-version set, usable with the --persona flag on
 * `bdg cloak create` and `bdg cloak update` (and re-applied by
 * `bdg cloak profile rotate-identity`).
 *
 * Mirrors cbpm's `profiles personas`.
 */

import type { Command } from 'commander';

import { cbmGet } from '@/commands/cloak/client.js';
import type { CbmPersona } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Personas command options. */
type PersonasOptions = BaseOptions;

/** Right-pad a string to a minimum width. */
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Format the persona list for human-readable output.
 */
export function formatPersonas(data: { personas: CbmPersona[] }): string {
  const { personas } = data;
  if (personas.length === 0) {
    return 'No personas available on this CBM server.';
  }
  const rows = personas.map((p) => `  ${pad(p.name, 28)}  ${pad(p.platform, 7)}  ${p.label}`);
  return joinLines(
    `${personas.length} persona(s) available (use with \`bdg cloak create --persona <name>\`):`,
    ...rows
  );
}

/**
 * Register the `cloak personas` subcommand.
 */
export function registerCloakPersonasCommand(program: Command): void {
  program
    .command('personas')
    .description('List coherent device personas usable with --persona')
    .addOption(jsonOption())
    .action(async (options: PersonasOptions) => {
      await runCommand<PersonasOptions, { personas: CbmPersona[] }>(
        async () => {
          const result = await cbmGet<CbmPersona[]>('/api/personas');

          if (!result.success) {
            return {
              success: false,
              error: result.error ?? 'Failed to fetch personas',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion:
                  'The CBM server may be older than v0.6.0 (no /api/personas). ' +
                  'Check that the server is running and reachable: bdg cloak status',
              },
            };
          }

          const data = result.data;
          if (!data) {
            return {
              success: false,
              error: 'CBM returned no persona data',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion: 'The CBM server may be older than v0.6.0 (no /api/personas).',
              },
            };
          }

          return { success: true, data: { personas: data } };
        },
        options,
        formatPersonas
      );
    });
}
