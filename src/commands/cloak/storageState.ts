/**
 * `bdg cloak storage-state <id>` — manage a profile's pre-seeded session state.
 *
 * CBM stores a Playwright `storage_state` dict (cookies + localStorage origins)
 * per profile and applies it on launch (cookies via context.add_cookies,
 * localStorage via a route-fulfilled no-network page navigation that persists
 * to the profile's on-disk storage; `clear_on_launch` wipes first if enabled).
 *
 *   bdg cloak storage-state us-shop --file ./warm.json   # upload (POST /storage-state)
 *   bdg cloak storage-state us-shop --clear              # drop the stored state
 *   bdg cloak storage-state us-shop                      # inspect what's stored
 *
 * Mirrors CBM POST /api/profiles/:id/storage-state (validate + store) and
 * PUT /api/profiles/:id (clear via storage_state: null).
 */

import type { Command } from 'commander';

import { cbmGet, cbmPost, cbmPut } from '@/commands/cloak/client.js';
import { parseJsonObject } from '@/commands/cloak/jsonField.js';
import { exitCodeFromStatus, withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

interface StorageStateOptions extends BaseOptions {
  file?: string;
  clear?: boolean;
}

/** Normalized result rendered by formatStorageState (and returned as --json data). */
export interface StorageStateResult {
  profile_id: string;
  mode: 'upload' | 'clear' | 'inspect';
  cookies_count: number;
  origins_count: number;
  /** Present on inspect when no state is stored. */
  has_state?: boolean;
}

/** The launch-application caveat, shown as a stderr hint on upload/clear. */
const APPLIED_HINT =
  'storage_state is applied on the next launch: cookies via context.add_cookies, ' +
  'localStorage via a route-fulfilled page navigation that persists to disk ' +
  '(survives a connect_over_cdp / fresh-session read; clear_on_launch wipes first if enabled).';

/** Count the cookies/origins in a stored storage_state dict (defensive). */
function countsOf(state: unknown): { cookies: number; origins: number } {
  if (!state || typeof state !== 'object') return { cookies: 0, origins: 0 };
  const s = state as Record<string, unknown>;
  const cookies = Array.isArray(s['cookies']) ? (s['cookies'] as unknown[]).length : 0;
  const origins = Array.isArray(s['origins']) ? (s['origins'] as unknown[]).length : 0;
  return { cookies, origins };
}

/** Render a storage-state result for human-readable output. */
export function formatStorageState(r: StorageStateResult): string {
  if (r.mode === 'upload') {
    return joinLines(
      `Uploaded storage_state for ${r.profile_id}`,
      `  cookies: ${r.cookies_count}   origins: ${r.origins_count}`
    );
  }
  if (r.mode === 'clear') {
    return `Cleared stored storage_state for ${r.profile_id}`;
  }
  // inspect
  if (r.has_state === false) {
    return `No storage_state stored for ${r.profile_id} (use --file <path> to upload one).`;
  }
  return joinLines(
    `Stored storage_state for ${r.profile_id}`,
    `  cookies: ${r.cookies_count}   origins: ${r.origins_count}`
  );
}

/** Register `bdg cloak storage-state <id>`. */
export function registerCloakStorageStateCommand(program: Command): void {
  program
    .command('storage-state')
    .description('Manage a profile\u2019s pre-seeded session state (upload / clear / inspect)')
    .argument('<id>', 'Profile ID or name')
    .option('--file <path>', 'Upload a Playwright storage_state JSON file (cookies + localStorage)')
    .option('--clear', 'Drop any stored storage_state')
    .addOption(jsonOption())
    .action(async (id: string, options: StorageStateOptions) => {
      await runCommand<StorageStateOptions, StorageStateResult>(
        async (opts) => {
          if (opts.file && opts.clear) {
            return {
              success: false,
              error: 'Choose one action: --file <path> to upload or --clear to drop.',
              exitCode: EXIT_CODES.INVALID_ARGUMENTS,
            };
          }

          // ── upload ──
          if (opts.file) {
            const parsed = parseJsonObject(opts.file, 'storage_state');
            if (!parsed.ok) {
              return {
                success: false,
                error: parsed.error,
                exitCode: EXIT_CODES.INVALID_ARGUMENTS,
                errorContext: {
                  suggestion:
                    'Provide a Playwright storage_state JSON file with a "cookies" and/or "origins" array.',
                },
              };
            }
            const result = await withProfileId<{
              ok: boolean;
              cookies_count: number;
              origins_count: number;
            }>(id, (pid) =>
              cbmPost(`/api/profiles/${encodeURIComponent(pid)}/storage-state`, parsed.value)
            );
            if (!result.success) {
              return {
                success: false,
                error: result.error ?? `Failed to upload storage_state for '${id}'`,
                exitCode: exitCodeFromStatus(result.statusCode),
                errorContext: {
                  suggestion:
                    'The body must be a Playwright storage_state dict with "cookies" or "origins".',
                },
              };
            }
            const data = result.data;
            if (!data) {
              return {
                success: false,
                error: 'CBM returned no storage_state response',
                exitCode: EXIT_CODES.SOFTWARE_ERROR,
              };
            }
            return {
              success: true,
              data: {
                profile_id: id,
                mode: 'upload',
                cookies_count: data.cookies_count ?? 0,
                origins_count: data.origins_count ?? 0,
              },
              hint: APPLIED_HINT,
            };
          }

          // ── clear ──
          if (opts.clear) {
            const result = await withProfileId<CbmProfile>(id, (pid) =>
              cbmPut<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`, {
                storage_state: null,
              })
            );
            if (!result.success) {
              return {
                success: false,
                error: result.error ?? `Failed to clear storage_state for '${id}'`,
                exitCode: exitCodeFromStatus(result.statusCode),
                errorContext: {
                  suggestion: 'Verify the profile exists. List profiles with: bdg cloak profiles',
                },
              };
            }
            if (!result.data) {
              return {
                success: false,
                error: 'CBM returned no profile data',
                exitCode: EXIT_CODES.SOFTWARE_ERROR,
              };
            }
            return {
              success: true,
              data: { profile_id: id, mode: 'clear', cookies_count: 0, origins_count: 0 },
              hint: APPLIED_HINT,
            };
          }

          // ── inspect ──
          const result = await withProfileId<CbmProfile>(id, (pid) =>
            cbmGet<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`)
          );
          if (!result.success) {
            return {
              success: false,
              error: result.error ?? `Failed to fetch profile '${id}'`,
              exitCode: exitCodeFromStatus(result.statusCode),
              errorContext: {
                suggestion: 'Verify the profile exists. List profiles with: bdg cloak profiles',
              },
            };
          }
          const profile = result.data;
          if (!profile) {
            return {
              success: false,
              error: 'CBM returned no profile data',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
            };
          }
          const counts = countsOf(profile.storage_state);
          return {
            success: true,
            data: {
              profile_id: id,
              mode: 'inspect',
              cookies_count: counts.cookies,
              origins_count: counts.origins,
              has_state: profile.storage_state != null,
            },
          };
        },
        options,
        formatStorageState
      );
    });
}
