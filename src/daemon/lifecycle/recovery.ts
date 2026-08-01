/**
 * CDP auto-recovery loop.
 *
 * When a CBM-managed profile's browser (re)launches, Chrome mints a fresh
 * page-target GUID (and CBM rotates the CDP port), so the webSocketDebuggerUrl
 * the worker is attached to becomes stale and its WebSocket closes. Instead of
 * exiting, the worker calls `runCdpRecovery`: it re-queries the live CDP
 * `/json/list` endpoint (`config.cdpTargetListUrl`, with `config.cdpHeaders`),
 * picks the current page target, reconnects the SAME CDPConnection to the new
 * URL, and re-attaches telemetry (re-enables domains + re-navigates).
 *
 * The loop is bounded by a max-attempts and max-duration cap (configurable via
 * env) and backs off exponentially so it rides out the relaunch window where the
 * profile is briefly `stopped` (the list endpoint returns 404/empty). On
 * exhaustion it returns null so the caller can fall back to the legacy
 * cleanup-and-exit behavior.
 *
 * The worker keeps a `recovering` guard so a close fired during an in-flight
 * recovery (e.g. a failed reconnect attempt) does not start a nested loop —
 * the loop here already retries internally.
 */

import type { CDPConnection } from '@/connection/cdp.js';
import { reattachToTarget } from '@/daemon/lifecycle/cdpSetup.js';
import type { TelemetryStore } from '@/daemon/worker/TelemetryStore.js';
import type { WorkerConfig } from '@/daemon/worker/types.js';
import type { CDPTarget, CleanupFunction, LaunchedChrome } from '@/types';
import type { Logger } from '@/ui/logging/index.js';
import { delay } from '@/utils/async.js';
import { fetchCdpTargetList, findPageTarget } from '@/utils/cdpTargets.js';

/** Default base backoff delay for the first recovery attempt (ms). */
const DEFAULT_BACKOFF_MS = 1000;
/** Maximum backoff delay between recovery attempts (ms). */
const MAX_BACKOFF_MS = 30_000;
/** Default maximum recovery attempts before giving up. */
const DEFAULT_MAX_ATTEMPTS = 30;
/** Default maximum total recovery duration before giving up (seconds). */
const DEFAULT_MAX_SECONDS = 300;

/** Context passed to `runCdpRecovery`. */
export interface RecoveryContext {
  /** The CDPConnection to reconnect (reused, not replaced). */
  cdp: CDPConnection;
  /** Worker config (carries cdpTargetListUrl, cdpHeaders, url, port). */
  config: WorkerConfig;
  /** Telemetry store (its targetInfo is updated to the recovered target). */
  telemetryStore: TelemetryStore;
  /** Launched Chrome (null on the external/cloak path). */
  chrome: LaunchedChrome | null;
  /** Logger. */
  log: Logger;
  /**
   * Callback to invoke when the recovered WebSocket later drops, so the worker
   * starts another recovery (recursion). Passed as onDisconnect to the new
   * cdp.connect so future losses are handled identically.
   */
  onDisconnect: () => void;
  /** Returns true when the worker is shutting down (bdg stop); aborts the loop. */
  isStopped: () => boolean;
  /**
   * Re-attach routine run after a fresh connect (re-enables telemetry domains and
   * re-navigates). Defaults to `reattachToTarget`; injected for tests.
   * @internal
   */
  reattach?: typeof reattachToTarget;
}

/** Result of a successful recovery. */
export interface RecoveryResult {
  /** Collector cleanup functions for the re-attached session. */
  cleanupFunctions: CleanupFunction[];
  /** The target the session re-attached to. */
  target: CDPTarget;
  /** Attempts made in this recovery cycle. */
  attempts: number;
  /** Reason for the loss that triggered this recovery, if known. */
  lastReason?: string | undefined;
}

/**
 * Parse a positive integer env var with a fallback.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Exponential backoff delay for a 1-based attempt number (base, 2*base, ...,
 * capped at max). The base is read from the env at call time so tests (and live
 * tuning) can override `BDG_CDP_RECOVERY_BACKOFF_MS` without reloading the module.
 */
function backoffDelayMs(attempt: number): number {
  const base = envInt('BDG_CDP_RECOVERY_BACKOFF_MS', DEFAULT_BACKOFF_MS);
  return Math.min(base * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Re-resolve the current CDP page target and reconnect after a WebSocket drop.
 *
 * Loops with exponential backoff until a fresh page target is found and the
 * CDPConnection is re-attached, or until the attempt/duration cap is hit, or
 * until `isStopped()` reports the worker is shutting down.
 *
 * @returns The recovery result on success, or null if exhausted/aborted (the
 *   caller should then fall back to its legacy cleanup-and-exit behavior).
 */
export async function runCdpRecovery(ctx: RecoveryContext): Promise<RecoveryResult | null> {
  const { cdp, config, telemetryStore, chrome, log, onDisconnect, isStopped } = ctx;
  const listUrl = config.cdpTargetListUrl;
  if (!listUrl) {
    // No recovery context (general bdg <url> path) — caller falls back to exit.
    return null;
  }

  const maxAttempts = envInt('BDG_CDP_RECOVERY_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  const maxSeconds = envInt('BDG_CDP_RECOVERY_MAX_SECONDS', DEFAULT_MAX_SECONDS);
  const deadline = Date.now() + maxSeconds * 1000;

  let attempts = 0;
  let lastReason: string | undefined;

  while (attempts < maxAttempts && Date.now() < deadline) {
    if (isStopped()) return null;
    attempts++;
    const waitMs = backoffDelayMs(attempts);
    log.info(
      `[recovery] attempt ${attempts}/${maxAttempts} in ${Math.round(waitMs / 100) / 10}s (list: ${listUrl})`
    );
    await delay(waitMs);
    if (isStopped()) return null;

    // Re-query the live target list. Empty/404/502 means the profile is briefly
    // stopped (relaunching) — back off and retry.
    const targets = await fetchCdpTargetList(listUrl, config.cdpHeaders, log);
    const target = findPageTarget(targets);
    if (!target?.webSocketDebuggerUrl) {
      lastReason =
        targets.length === 0
          ? 'no targets (profile stopped/relaunching)'
          : 'no page target with a webSocketDebuggerUrl';
      log.info(`[recovery] no usable target yet: ${lastReason}`);
      continue;
    }

    log.info(`[recovery] re-resolved target ${target.id} (${target.title || target.url})`);
    telemetryStore.setTargetInfo(target);

    // Reconnect the SAME CDPConnection to the fresh URL. A future drop of this
    // new socket must trigger another recovery, so thread onDisconnect through.
    try {
      await cdp.connect(target.webSocketDebuggerUrl, {
        autoReconnect: false,
        maxRetries: 3,
        ...(config.cdpHeaders ? { headers: config.cdpHeaders } : {}),
        onDisconnect: (code, reason) => {
          log.info(`Chrome connection lost after recovery (code: ${code}, reason: ${reason})`);
          onDisconnect();
        },
      });
    } catch (error) {
      lastReason = `reconnect failed: ${error instanceof Error ? error.message : String(error)}`;
      log.info(`[recovery] ${lastReason}`);
      continue;
    }

    // Re-enable telemetry domains + re-navigate on the fresh WebSocket.
    try {
      const reattach = ctx.reattach ?? reattachToTarget;
      const cleanupFunctions = await reattach(cdp, config, telemetryStore, chrome, log);
      log.info(`[recovery] recovered to target ${target.id} after ${attempts} attempt(s)`);
      return { cleanupFunctions, target, attempts, lastReason };
    } catch (error) {
      lastReason = `reattach failed: ${error instanceof Error ? error.message : String(error)}`;
      log.info(`[recovery] ${lastReason}`);
      try {
        cdp.close();
      } catch {
        // ignore — best-effort cleanup before retrying
      }
      continue;
    }
  }

  log.info(`[recovery] exhausted after ${attempts} attempt(s): ${lastReason ?? 'unknown'}`);
  return null;
}
