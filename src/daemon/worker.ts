#!/usr/bin/env node
/**
 * Worker Process - Main Entry Point
 *
 * Orchestrates worker lifecycle by delegating to specialized modules.
 * This file contains only high-level coordination logic.
 */

import type { CDPConnection } from '@/connection/cdp.js';
import { ConnectionError } from '@/connection/errors.js';
import { WorkerError } from '@/daemon/errors.js';
import { setupCDPAndNavigate } from '@/daemon/lifecycle/cdpSetup.js';
import { setupChromeConnection } from '@/daemon/lifecycle/chromeConnection.js';
import { runCdpRecovery } from '@/daemon/lifecycle/recovery.js';
import { setupSignalHandlers } from '@/daemon/lifecycle/signalHandlers.js';
import { cleanupWorker } from '@/daemon/lifecycle/workerCleanup.js';
import { parseWorkerConfig } from '@/daemon/lifecycle/workerConfig.js';
import { setupStdinListener } from '@/daemon/lifecycle/workerIpc.js';
import { workerExitingConnectionLoss, workerSessionActive } from '@/daemon/messages.js';
import { TelemetryStore } from '@/daemon/worker/TelemetryStore.js';
import { createCommandRegistry } from '@/daemon/worker/commandRegistry.js';
import type { WorkerReadyMessage } from '@/daemon/workerIpc.js';
import type { ChromeNoticeCode, NoticeSink } from '@/errors/notices.js';
import { writeSessionMetadata } from '@/session/metadata.js';
import { writePid } from '@/session/pid.js';
import type { CleanupFunction, LaunchedChrome } from '@/types';
import { createLogger } from '@/ui/logging/index.js';
import { formatChromeIssue, formatChromeNotice } from '@/ui/messages/chrome.js';

const log = createLogger('worker');
const telemetryStore = new TelemetryStore();
const commandRegistry = createCommandRegistry(telemetryStore);

let chrome: LaunchedChrome | null = null;
let cdp: CDPConnection | null = null;
let cleanupFunctions: CleanupFunction[] = [];
/** True while a CDP recovery loop is in flight (guards against nested loops). */
let recovering = false;
/** Total successful CDP recoveries this session (for metadata/status). */
let recoveryCount = 0;

/**
 * Send worker_ready signal to parent via stdout.
 */
function sendReadySignal(workerPid: number, chromePid: number, port: number): void {
  const targetInfo = telemetryStore.targetInfo;
  if (!targetInfo) {
    throw new WorkerError(
      'Cannot send ready signal: Target not initialized',
      'TARGET_NOT_INITIALIZED'
    );
  }

  const message: WorkerReadyMessage = {
    type: 'worker_ready',
    requestId: 'ready',
    workerPid,
    chromePid,
    port,
    target: {
      url: targetInfo.url,
      title: targetInfo.title,
    },
  };

  console.log(JSON.stringify(message));
  log.debug(`[worker] Ready signal sent (PID ${workerPid}, Chrome PID ${chromePid})`);
}

/**
 * Initialize telemetry store to clean state.
 */
function initializeTelemetryStore(): void {
  telemetryStore.resetSessionStart();
  telemetryStore.setDomData(null);
  telemetryStore.networkRequests.length = 0;
  telemetryStore.consoleMessages.length = 0;
  telemetryStore.navigationEvents.length = 0;
  telemetryStore.setTargetInfo(null);
}

/**
 * Main worker entry point.
 */
async function main(): Promise<void> {
  console.error(`[worker] Starting (PID ${process.pid})`);

  try {
    const config = parseWorkerConfig();
    console.error(`[worker] Config: ${JSON.stringify(config)}`);

    initializeTelemetryStore();
    writePid(process.pid);

    const notify: NoticeSink<ChromeNoticeCode> = (notice) =>
      console.error(`[worker] ${formatChromeNotice(notice)}`);

    chrome = await setupChromeConnection(config, telemetryStore, log, notify);

    /**
     * Handle a CDP WebSocket drop. With a cdpTargetListUrl configured (cloak
     * path), re-resolve the current page target and reconnect automatically;
     * otherwise fall back to the legacy cleanup-and-exit. `recovering` guards
     * against nested loops — runCdpRecovery retries internally.
     */
    const handleCdpDisconnect = (): void => {
      if (recovering) {
        log.info('CDP disconnect during recovery — ignored (in-flight recovery will handle it)');
        return;
      }
      if (!cdp) {
        return; // defensive: no connection to recover
      }
      if (!config.cdpTargetListUrl) {
        void cleanupWorker('crash', {
          chrome,
          cdp,
          cleanupFunctions,
          telemetryStore,
          log,
          notify,
        }).then(() => process.exit(1));
        return;
      }
      const cdpConn = cdp;
      recovering = true;
      void (async () => {
        try {
          const recovered = await runCdpRecovery({
            cdp: cdpConn,
            config,
            telemetryStore,
            chrome,
            log,
            onDisconnect: handleCdpDisconnect,
            isStopped: () => false,
          });
          if (recovered) {
            cleanupFunctions = recovered.cleanupFunctions;
            recoveryCount++;
            writeSessionMetadata({
              bdgPid: process.pid,
              chromePid: chrome?.pid ?? 0,
              startTime: telemetryStore.sessionStartTime,
              port: config.port,
              targetId: recovered.target.id,
              webSocketDebuggerUrl: recovered.target.webSocketDebuggerUrl,
              activeTelemetry: telemetryStore.activeTelemetry,
              recovery: {
                count: recoveryCount,
                attempts: recovered.attempts,
                recoveredAt: Date.now(),
                lastReason: recovered.lastReason,
              },
            });
            console.error(`[worker] Session metadata refreshed after recovery #${recoveryCount}`);
            log.info(`recovery complete (total ${recoveryCount})`);
          } else {
            // Exhausted or aborted — fall back to legacy cleanup + exit.
            log.debug(workerExitingConnectionLoss());
            await cleanupWorker('crash', {
              chrome,
              cdp: cdpConn,
              cleanupFunctions,
              telemetryStore,
              log,
              notify,
            });
            process.exit(1);
          }
        } catch (error) {
          console.error(
            `[worker] Recovery error: ${error instanceof Error ? error.message : String(error)}`
          );
          await cleanupWorker('crash', {
            chrome,
            cdp: cdpConn,
            cleanupFunctions,
            telemetryStore,
            log,
            notify,
          });
          process.exit(1);
        } finally {
          recovering = false;
        }
      })();
    };

    const result = await setupCDPAndNavigate(
      config,
      telemetryStore,
      chrome,
      log,
      handleCdpDisconnect
    );

    cdp = result.cdp;
    cleanupFunctions = result.cleanupFunctions;

    writeSessionMetadata({
      bdgPid: process.pid,
      chromePid: chrome?.pid ?? 0,
      startTime: telemetryStore.sessionStartTime,
      port: config.port,
      targetId: telemetryStore.targetInfo?.id,
      webSocketDebuggerUrl: telemetryStore.targetInfo?.webSocketDebuggerUrl,
      activeTelemetry: telemetryStore.activeTelemetry,
    });
    console.error(`[worker] Session metadata written`);

    setupStdinListener(cdp, commandRegistry, log);

    sendReadySignal(process.pid, chrome?.pid ?? 0, config.port);

    setupSignalHandlers(
      { chrome, cdp, cleanupFunctions, telemetryStore, log, notify },
      config.timeout
    );

    log.debug(workerSessionActive());
  } catch (error) {
    const message =
      error instanceof ConnectionError && error.issue
        ? formatChromeIssue(error.issue)
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`[worker] Fatal error: ${message}`);
    const notify: NoticeSink<ChromeNoticeCode> = (n) =>
      console.error(`[worker] ${formatChromeNotice(n)}`);
    await cleanupWorker('crash', {
      chrome,
      cdp,
      cleanupFunctions,
      telemetryStore,
      log,
      notify,
    });
    process.exit(1);
  }
}

void main();
