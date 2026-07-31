/**
 * `bdg cloak` command group registration.
 *
 * Provides commands for interacting with CloakBrowser Manager (CBM):
 * - status:   Show CBM server status
 * - profiles: List managed browser profiles
 * - launch:   Start a browser profile
 * - stop:     Stop a running profile
 * - connect:  Bridge bdg session to a CBM-managed browser for inspection
 *
 * All cloak commands require the CBM server to be running and accessible.
 * Configure via CBPM_API_URL / CBPM_API_TOKEN env vars or ~/.cbpm/config.json.
 */

import type { Command } from 'commander';

import { registerCloakConnectCommand } from '@/commands/cloak/connect.js';
import { registerCloakLaunchCommand, registerCloakStopCommand } from '@/commands/cloak/launch.js';
import { registerCloakProfilesCommand } from '@/commands/cloak/profiles.js';
import { registerCloakStatusCommand } from '@/commands/cloak/status.js';

/**
 * Register the `cloak` parent command and all subcommands.
 *
 * The parent command itself has no action — it displays help showing
 * the available subcommands.
 *
 * @param program - Commander.js Command instance (the root bdg program).
 */
export function registerCloakCommands(program: Command): void {
  const cloak = program
    .command('cloak')
    .description('CloakBrowser Manager — manage and connect to browser profiles');

  registerCloakStatusCommand(cloak);
  registerCloakProfilesCommand(cloak);
  registerCloakLaunchCommand(cloak);
  registerCloakStopCommand(cloak);
  registerCloakConnectCommand(cloak);
}
