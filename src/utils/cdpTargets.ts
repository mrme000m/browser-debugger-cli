/**
 * CDP page-target selection and re-resolution helpers.
 *
 * Shared by the CLI (`bdg cloak connect`) and the worker recovery loop so both
 * use the identical target-selection logic. `findPageTarget` picks the primary
 * page target from a `/json/list` response; `fetchCdpTargetList` fetches that
 * response from a CDP HTTP endpoint (e.g. the CBM proxy), attaching optional
 * auth headers. On any HTTP/network error it returns an empty list so callers
 * can treat "not ready yet" (profile relaunching, 404/502) as "retry".
 */

import type { CDPTarget } from '@/types';
import type { Logger } from '@/ui/logging/index.js';

/** Default timeout for the CDP list HTTP request (matches fetchCDPTargets). */
const CDP_LIST_TIMEOUT_MS = 5000;

/**
 * Find the primary page target from a list of CDP targets.
 *
 * Prefers a real page (not about:blank, chrome://, devtools://). Falls back to
 * any page target, then any target with a webSocketDebuggerUrl.
 *
 * @param targets - Targets from a `/json/list` response.
 * @returns The chosen target, or null if none is usable.
 */
export function findPageTarget(targets: readonly CDPTarget[]): CDPTarget | null {
  if (targets.length === 0) return null;

  // Prefer a page with a real URL
  const realPage = targets.find(
    (t) =>
      t.type === 'page' &&
      t.url &&
      !t.url.startsWith('about:') &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('devtools://')
  );
  if (realPage) return realPage;

  // Fall back to any page target
  const anyPage = targets.find((t) => t.type === 'page');
  if (anyPage) return anyPage;

  // Last resort: first target of any type with a webSocketDebuggerUrl
  return targets.find((t) => !!t.webSocketDebuggerUrl) ?? null;
}

/**
 * Fetch the live CDP page-target list from an HTTP endpoint.
 *
 * Used by the worker recovery loop to re-resolve the current page target after
 * a WebSocket drop: a CBM profile relaunch mints a fresh page-target GUID (and
 * rotates the CDP port), so a previously resolved webSocketDebuggerUrl is stale.
 * Re-querying the live `/json/list` endpoint returns the current targets.
 *
 * Attaches optional auth headers (e.g. Authorization: Bearer) for the
 * authenticated CDP path over a remote/tunnel host.
 *
 * Returns an empty array on any HTTP/network error so callers can retry
 * through the relaunch window where the profile is briefly stopped.
 *
 * @param url - Full HTTP URL of the `/json/list` endpoint (e.g. the CBM proxy).
 * @param headers - Optional request headers (e.g. Authorization: Bearer token).
 * @param logger - Optional logger for debug output.
 * @param timeoutMs - Request timeout in milliseconds (default 5000).
 * @returns Array of CDP targets (empty on error or non-array response).
 */
export async function fetchCdpTargetList(
  url: string,
  headers?: Record<string, string>,
  logger?: Logger,
  timeoutMs: number = CDP_LIST_TIMEOUT_MS
): Promise<CDPTarget[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        ...(headers ? { headers } : {}),
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        logger?.debug(
          `CDP list request failed: ${response.status} ${response.statusText} (${url})`
        );
        return [];
      }

      const data: unknown = await response.json();
      if (!Array.isArray(data)) {
        logger?.debug(`CDP list response is not an array (${url})`);
        return [];
      }

      return data as CDPTarget[];
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        logger?.debug(`CDP list request timed out after ${timeoutMs}ms (${url})`);
      } else {
        logger?.debug(`CDP list request error: ${error.message} (${url})`);
      }
    }
    return [];
  }
}
