/**
 * `bdg cloak proxy-credentials` command.
 *
 * Lists saved proxy credentials from CBM, including provider-linked
 * credentials (e.g. IPVanish locations) and their last health-check status.
 */

import type { Command } from 'commander';

import { cbmGet } from '@/commands/cloak/client.js';
import type { CbmProxyCredential } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';

interface ProxyCredentialsOptions extends BaseOptions {
  location?: string;
}

/**
 * Format a single credential as a compact one-line string.
 *
 * Intentionally omits the username/password: credential material is sensitive
 * and should not be echoed to the terminal.
 */
function formatCredential(c: CbmProxyCredential): string {
  const loc = c.provider_location ? `  location: ${c.provider_location}` : '';
  const status = c.last_status ? `  status: ${c.last_status}` : '';
  const exit = c.last_exit_ip
    ? `  ip: ${c.last_exit_ip}${c.last_country ? ` (${c.last_country})` : ''}`
    : '';
  return joinLines(
    `${c.id}  ${c.name}`,
    `  ${c.scheme}://${c.host}:${c.port}${loc}${status}${exit}`.trim()
  );
}

/**
 * Register the `cloak proxy-credentials` subcommand.
 */
export function registerCloakProxyCredentialsCommand(program: Command): void {
  program
    .command('proxy-credentials')
    .description('List saved proxy credentials from CloakBrowser Manager')
    .option('--location <code>', 'Filter to a provider location code (e.g. us-nyc)')
    .addOption(jsonOption())
    .action(async (options: ProxyCredentialsOptions) => {
      await runCommand<ProxyCredentialsOptions, CbmProxyCredential[]>(
        async (opts) => {
          const result = await cbmGet<CbmProxyCredential[]>('/api/proxy-credentials');
          if (!result.success) {
            return {
              success: false,
              error: result.error ?? 'Failed to fetch proxy credentials',
            };
          }
          let data = result.data ?? [];
          if (opts.location) {
            const q = opts.location.toLowerCase();
            data = data.filter(
              (c) => c.provider_location?.toLowerCase() === q || c.name.toLowerCase().includes(q)
            );
          }
          return { success: true, data };
        },
        options,
        (data) => (data.length ? data.map(formatCredential).join('\n\n') : 'No proxy credentials.')
      );
    });
}
