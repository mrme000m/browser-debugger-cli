/**
 * Resolve a profile identifier that may be either a UUID or a profile name.
 *
 * The CBM backend matches `/api/profiles/{profile_id}` by UUID only, but bdg's
 * `cloak` commands accept "ID or name" (matching `bdg cloak connect`). This
 * helper runs a profile operation against the given id directly and, on a 404,
 * resolves the id as a profile name via the list endpoint and retries with the
 * real UUID - so the common UUID path costs a single call.
 */

import { cbmGet } from '@/commands/cloak/client.js';
import type { CbmApiResult } from '@/commands/cloak/client.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/**
 * Map a CBM API error status code to a bdg semantic exit code.
 * Network errors (no status code) map to SOFTWARE_ERROR.
 */
export function exitCodeFromStatus(statusCode?: number): number {
  if (statusCode === undefined) return EXIT_CODES.SOFTWARE_ERROR;
  if (statusCode === 400 || statusCode === 422) return EXIT_CODES.INVALID_ARGUMENTS;
  if (statusCode === 401 || statusCode === 403) return EXIT_CODES.PERMISSION_DENIED;
  if (statusCode === 404) return EXIT_CODES.RESOURCE_NOT_FOUND;
  if (statusCode === 409) return EXIT_CODES.RESOURCE_ALREADY_EXISTS;
  return EXIT_CODES.SOFTWARE_ERROR;
}

/**
 * Run a profile operation against an id-or-name identifier.
 *
 * @param id - Profile UUID or profile name.
 * @param op - Operation that takes a profile UUID and returns a CBM API result.
 * @returns The operation result (retried with the resolved UUID on a 404).
 */
export async function withProfileId<T>(
  id: string,
  op: (profileId: string) => Promise<CbmApiResult<T>>
): Promise<CbmApiResult<T>> {
  const direct = await op(id);
  if (direct.statusCode !== 404) {
    return direct;
  }
  // The id may be a profile name; resolve it via the list and retry.
  const list = await cbmGet<CbmProfile[]>('/api/profiles');
  if (list.success && list.data) {
    const found = list.data.find((p) => p.name === id);
    if (found) {
      return op(found.id);
    }
  }
  return direct;
}
