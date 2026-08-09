/**
 * `bdg cloak` command group registration.
 *
 * Provides commands for interacting with CloakBrowser Manager (CBM):
 * - status:           Show CBM server status
 * - profiles:         List managed browser profiles
 * - get:              Show a profile's full details
 * - create:           Create a managed profile (self-explaining: --list-fields)
 * - update:           Update a profile (only provided fields change)
 * - delete:           Delete a profile and its browser data
 * - clone:            Clone a profile (new random fingerprint seed)
 * - profile:          Quick profile tweaks (proxy, timezone, reseed, reset-ua, rotate-identity)
 * - personas:         List coherent device personas usable with --persona
 * - proxy-credentials: List saved proxy credentials
 * - launch:           Start a browser profile
 * - stop:             Stop a running profile
 * - connect:          Bridge bdg session to a CBM-managed browser for inspection
 * - analyze:          Run a live bot-detection test (actual-vs-expected per check + coherence)
 *
 * All cloak commands require the CBM server to be running and accessible.
 * Configure via CBPM_API_URL / CBPM_API_TOKEN env vars or ~/.cbpm/config.json.
 */

import type { Command } from 'commander';

import { registerCloakAnalyzeCommand } from '@/commands/cloak/analyze.js';
import { registerCloakCloneCommand } from '@/commands/cloak/clone.js';
import { registerCloakConnectCommand } from '@/commands/cloak/connect.js';
import { registerCloakCreateCommand } from '@/commands/cloak/create.js';
import { registerCloakDeleteCommand } from '@/commands/cloak/delete.js';
import { registerCloakGetCommand } from '@/commands/cloak/get.js';
import { registerCloakLaunchCommand, registerCloakStopCommand } from '@/commands/cloak/launch.js';
import { registerCloakPersonasCommand } from '@/commands/cloak/personas.js';
import { registerCloakProfileCommand } from '@/commands/cloak/profile.js';
import { registerCloakProfilesCommand } from '@/commands/cloak/profiles.js';
import { registerCloakProxyCredentialsCommand } from '@/commands/cloak/proxyCredentials.js';
import { registerCloakStatusCommand } from '@/commands/cloak/status.js';
import { registerCloakUpdateCommand } from '@/commands/cloak/update.js';

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
  registerCloakGetCommand(cloak);
  registerCloakCreateCommand(cloak);
  registerCloakUpdateCommand(cloak);
  registerCloakDeleteCommand(cloak);
  registerCloakCloneCommand(cloak);
  registerCloakProfileCommand(cloak);
  registerCloakPersonasCommand(cloak);
  registerCloakProxyCredentialsCommand(cloak);
  registerCloakLaunchCommand(cloak);
  registerCloakStopCommand(cloak);
  registerCloakConnectCommand(cloak);
  registerCloakAnalyzeCommand(cloak);
}
