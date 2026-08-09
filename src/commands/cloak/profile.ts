/**
 * `bdg cloak profile` command group.
 *
 * Quick, everyday profile tweaks that do not require memorising backend field
 * names or UUIDs:
 *   - proxy:           assign a saved credential by location code, credential id,
 *                      rotation group id, inline URL, or clear the proxy entirely
 *   - timezone:        set the profile timezone
 *   - reseed:          generate a new random fingerprint seed
 *   - reset-ua:        clear the explicit User-Agent so it is regenerated on launch
 *   - rotate-identity: fresh coherent identity (new seed + re-apply persona bundle)
 *
 * These build on the existing CBM API: PUT /api/profiles/:id,
 * POST /api/profiles/:id/reseed, etc.
 */

import type { Command } from 'commander';

import { cbmGet, cbmPost, cbmPut, type CbmApiResult } from '@/commands/cloak/client.js';
import { formatProfile } from '@/commands/cloak/format.js';
import { exitCodeFromStatus, withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmProfile, CbmProxyCredential, CbmProxyProvider } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Return a bdg-format error result for a CBM API failure.
 */
function profileError(
  id: string,
  result: CbmApiResult<unknown>,
  suggestion?: string
): { success: false; error: string; exitCode: number; errorContext?: { suggestion: string } } {
  return {
    success: false,
    error: result.error ?? `Failed to update profile '${id}'`,
    exitCode: exitCodeFromStatus(result.statusCode),
    ...(suggestion ? { errorContext: { suggestion } } : {}),
  };
}

// ── proxy ────────────────────────────────────────────────────────────────────

interface ProfileProxyOptions extends BaseOptions {
  location?: string;
  credential?: string;
  group?: string;
  url?: string;
  none?: boolean;
}

/**
 * Find the IPVanish-style provider and return its id, or undefined if none.
 */
async function findIpvanishProvider(): Promise<CbmProxyProvider | undefined> {
  const result = await cbmGet<CbmProxyProvider[]>('/api/proxy-providers');
  if (!result.success || !result.data) return undefined;
  return result.data.find((p) => p.type === 'ipvanish');
}

/**
 * Find a credential by provider + location code (e.g. "us-nyc").
 */
async function findCredentialByLocation(location: string): Promise<CbmProxyCredential | undefined> {
  const provider = await findIpvanishProvider();
  const credsResult = await cbmGet<CbmProxyCredential[]>('/api/proxy-credentials');
  if (!credsResult.success || !credsResult.data) return undefined;
  const q = location.toLowerCase();
  return credsResult.data.find(
    (c) =>
      c.provider_location?.toLowerCase() === q && (provider ? c.provider_id === provider.id : true)
  );
}

/**
 * Register `bdg cloak profile proxy <id>`.
 */
function registerProfileProxyCommand(program: Command): void {
  program
    .command('proxy')
    .description('Change the proxy used by a profile')
    .argument('<id>', 'Profile ID or name')
    .option('--location <code>', 'IPVanish location code (e.g. us-nyc, uk, de)')
    .option('--credential <id>', 'Saved proxy credential UUID')
    .option('--group <id>', 'Saved proxy rotation group UUID')
    .option('--url <url>', 'Inline proxy URL (socks5://user:pass@host:port)')
    .option('--none', 'Remove any configured proxy')
    .addOption(jsonOption())
    .action(async (id: string, options: ProfileProxyOptions) => {
      await runCommand<ProfileProxyOptions, CbmProfile>(
        async (opts) => {
          const setters = [opts.location, opts.credential, opts.group, opts.url, opts.none].filter(
            (v) => v !== undefined && v !== false
          ).length;
          if (setters === 0) {
            return {
              success: false,
              error:
                'Choose one proxy source: --location, --credential, --group, --url, or --none.',
              exitCode: EXIT_CODES.INVALID_ARGUMENTS,
              errorContext: {
                suggestion: 'List credentials with: bdg cloak proxy-credentials',
              },
            };
          }
          if (setters > 1) {
            return {
              success: false,
              error: 'Only one proxy source may be set at a time.',
              exitCode: EXIT_CODES.INVALID_ARGUMENTS,
            };
          }

          const body: Record<string, unknown> = {};
          if (opts.none) {
            body['proxy'] = null;
            body['proxy_credential_id'] = null;
            body['proxy_group_id'] = null;
          } else if (opts.url) {
            body['proxy'] = opts.url;
            body['proxy_credential_id'] = null;
            body['proxy_group_id'] = null;
          } else if (opts.credential) {
            body['proxy_credential_id'] = opts.credential;
            body['proxy'] = null;
            body['proxy_group_id'] = null;
          } else if (opts.group) {
            body['proxy_group_id'] = opts.group;
            body['proxy'] = null;
            body['proxy_credential_id'] = null;
          } else if (opts.location) {
            const cred = await findCredentialByLocation(opts.location);
            if (!cred) {
              return {
                success: false,
                error: `No proxy credential found for location '${opts.location}'.`,
                exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
                errorContext: {
                  suggestion: 'List credentials with: bdg cloak proxy-credentials',
                },
              };
            }
            body['proxy_credential_id'] = cred.id;
            body['proxy'] = null;
            body['proxy_group_id'] = null;
          }

          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmPut<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`, body)
          );
          if (!result.success) {
            return profileError(
              id,
              result,
              'Verify the profile exists. List profiles with: bdg cloak profiles'
            );
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
        (p: CbmProfile): string => `${formatProfile(p)}\n\nProxy updated for ${id}`
      );
    });
}

// ── timezone ─────────────────────────────────────────────────────────────────

interface ProfileTimezoneOptions extends BaseOptions {
  timezone: string;
}

/**
 * Register `bdg cloak profile timezone <id> --timezone <tz>`.
 */
function registerProfileTimezoneCommand(program: Command): void {
  program
    .command('timezone')
    .description('Set the timezone of a profile (e.g. America/New_York)')
    .argument('<id>', 'Profile ID or name')
    .requiredOption('--timezone <tz>', 'IANA timezone')
    .addOption(jsonOption())
    .action(async (id: string, options: ProfileTimezoneOptions) => {
      await runCommand<ProfileTimezoneOptions, CbmProfile>(
        async (opts) => {
          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmPut<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`, {
              timezone: opts.timezone,
            })
          );
          if (!result.success) {
            return profileError(
              id,
              result,
              'Verify the profile exists. List profiles with: bdg cloak profiles'
            );
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
        (p: CbmProfile): string => `${formatProfile(p)}\n\nTimezone updated for ${id}`
      );
    });
}

// ── reseed ───────────────────────────────────────────────────────────────────

type ProfileReseedOptions = BaseOptions;

/**
 * Register `bdg cloak profile reseed <id>`.
 */
function registerProfileReseedCommand(program: Command): void {
  program
    .command('reseed')
    .description('Generate a new random fingerprint seed for a profile')
    .argument('<id>', 'Profile ID or name')
    .addOption(jsonOption())
    .action(async (id: string, options: ProfileReseedOptions) => {
      await runCommand<ProfileReseedOptions, CbmProfile>(
        async () => {
          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmPost<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}/reseed`)
          );
          if (!result.success) {
            return profileError(
              id,
              result,
              'Verify the profile exists. List profiles with: bdg cloak profiles'
            );
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
        (p: CbmProfile): string => `${formatProfile(p)}\n\nFingerprint reseeded for ${id}`
      );
    });
}

// ── reset-ua ─────────────────────────────────────────────────────────────────

type ProfileResetUaOptions = BaseOptions;

/**
 * Register `bdg cloak profile reset-ua <id>`.
 */
function registerProfileResetUaCommand(program: Command): void {
  program
    .command('reset-ua')
    .description('Clear the explicit User-Agent so it is regenerated on next launch')
    .argument('<id>', 'Profile ID or name')
    .addOption(jsonOption())
    .action(async (id: string, options: ProfileResetUaOptions) => {
      await runCommand<ProfileResetUaOptions, CbmProfile>(
        async () => {
          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmPut<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`, {
              user_agent: null,
            })
          );
          if (!result.success) {
            return profileError(
              id,
              result,
              'Verify the profile exists. List profiles with: bdg cloak profiles'
            );
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
        (p: CbmProfile): string => `${formatProfile(p)}\n\nUser-Agent reset for ${id}`
      );
    });
}

// ── rotate-identity ──────────────────────────────────────────────────────────

type ProfileRotateIdentityOptions = BaseOptions;

/**
 * Register `bdg cloak profile rotate-identity <id>`.
 *
 * Stronger than `reseed`: draws a new full-entropy seed AND, when the profile
 * has a persona, re-applies that persona's coherent hardware bundle (screen,
 * GPU, cores, memory, platform version, DPR) so the rotated identity stays
 * internally consistent. Mirrors CBM POST /api/profiles/:id/rotate-identity.
 */
function registerProfileRotateIdentityCommand(program: Command): void {
  program
    .command('rotate-identity')
    .description('Fresh coherent identity: new seed + re-apply the persona hardware bundle')
    .argument('<id>', 'Profile ID or name')
    .addOption(jsonOption())
    .action(async (id: string, options: ProfileRotateIdentityOptions) => {
      await runCommand<ProfileRotateIdentityOptions, CbmProfile>(
        async () => {
          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmPost<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}/rotate-identity`)
          );
          if (!result.success) {
            return profileError(
              id,
              result,
              'Verify the profile exists. List profiles with: bdg cloak profiles'
            );
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
        (p: CbmProfile): string =>
          `${formatProfile(p)}\n\nIdentity rotated for ${id}: new seed ${p.fingerprint_seed}` +
          `${p.persona ? ` (persona: ${p.persona})` : ''}. Effective on next launch.`
      );
    });
}

// ── Public registration ────────────────────────────────────────────────────

/**
 * Register `bdg cloak profile <subcommand>`.
 */
export function registerCloakProfileCommand(program: Command): void {
  const profile = program
    .command('profile')
    .description(
      'Quick profile tweaks: proxy, timezone, fingerprint seed, User-Agent, identity rotation'
    );

  registerProfileProxyCommand(profile);
  registerProfileTimezoneCommand(profile);
  registerProfileReseedCommand(profile);
  registerProfileResetUaCommand(profile);
  registerProfileRotateIdentityCommand(profile);
}
