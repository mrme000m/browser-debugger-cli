/**
 * CDP auto-recovery loop unit tests.
 *
 * Following the testing philosophy:
 * - Test the BEHAVIOR: "runCdpRecovery re-resolves the live page target and
 *   reconnects the same CDPConnection after a WebSocket drop, retrying through
 *   the relaunch window where the list endpoint is briefly empty/404".
 * - Test the PROPERTY: "bounded — exhausts to null on attempt/timeout cap;
 *   aborts on isStopped; never throws".
 * - Mock the BOUNDARY: fetch() (the live CDP /json/list endpoint) and the
 *   CDPConnection object. The re-attach routine is injected via the `reattach`
 *   seam so the loop is tested in isolation. Backoff is driven to ~1ms via
 *   BDG_CDP_RECOVERY_BACKOFF_MS so the loop runs in milliseconds.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { CDPConnection } from '@/connection/cdp.js';
import { runCdpRecovery } from '@/daemon/lifecycle/recovery.js';
import { TelemetryStore } from '@/daemon/worker/TelemetryStore.js';
import type { WorkerConfig } from '@/daemon/worker/types.js';
import type { CDPTarget, CleanupFunction, LaunchedChrome } from '@/types';
import type { Logger } from '@/ui/logging/index.js';

const LIST_URL = 'https://cbm.test/api/profiles/p1/cdp/json/list';
const NOOP_CLEANUP: CleanupFunction[] = [() => {}];
/** Argument tuple of the injected re-attach routine (matches reattachToTarget). */
type ReattachArgs = [CDPConnection, WorkerConfig, TelemetryStore, LaunchedChrome | null, Logger];

/** Build a CDP page target for tests. */
function target(id: string, url = 'http://localhost:3000'): CDPTarget {
  return {
    id,
    type: 'page',
    title: 'Page',
    url,
    webSocketDebuggerUrl: `wss://cbm.test/api/profiles/p1/cdp/devtools/page/${id}`,
  };
}

/** A no-op logger that satisfies the Logger interface without printing. */
function makeLogger(): Logger {
  return Object.assign(() => {}, {
    info: (_message: string) => {},
    debug: (_message: string) => {},
  }) as unknown as Logger;
}

/** A CDPConnection stub exposing mock connect/close. */
function makeCdp(): {
  cdp: CDPConnection;
  connect: ReturnType<typeof mock.fn>;
  close: ReturnType<typeof mock.fn>;
} {
  const connect = mock.fn(async (_url: string, _opts: unknown) => {});
  const close = mock.fn(() => {});
  return { cdp: { connect, close } as unknown as CDPConnection, connect, close };
}

/** Build a WorkerConfig with cdpTargetListUrl set (and optional auth headers). */
function makeConfig(headers?: Record<string, string>): WorkerConfig {
  const config: WorkerConfig = { url: 'about:blank', port: 0, cdpTargetListUrl: LIST_URL };
  if (headers !== undefined) config.cdpHeaders = headers;
  return config;
}

/** fetch response carrying a target list. */
function okResponse(targets: CDPTarget[]): unknown {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(targets) };
}

/** fetch response with an empty target list. */
function emptyResponse(): unknown {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve([]) };
}

/** fetch response for a stopped profile (404 → fetchCdpTargetList returns []). */
function notFoundResponse(): unknown {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    json: () => Promise.resolve({ detail: 'Profile not running' }),
  };
}

/** The options object passed to CDPConnection.connect (cast from unknown). */
function connectOpts(
  connectMock: ReturnType<typeof mock.fn>,
  index = 0
): {
  autoReconnect?: boolean;
  maxRetries?: number;
  headers?: Record<string, string>;
  onDisconnect?: unknown;
} {
  return connectMock.mock.calls[index]?.arguments[1] as {
    autoReconnect?: boolean;
    maxRetries?: number;
    headers?: Record<string, string>;
    onDisconnect?: unknown;
  };
}

void describe('runCdpRecovery', () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: ReturnType<typeof mock.fn>;
  let responses: unknown[];

  beforeEach(() => {
    process.env['BDG_CDP_RECOVERY_BACKOFF_MS'] = '1';
    responses = [];
    originalFetch = global.fetch;
    fetchMock = mock.fn();
    fetchMock.mock.mockImplementation(() => Promise.resolve(responses.shift() ?? emptyResponse()));
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    delete process.env['BDG_CDP_RECOVERY_BACKOFF_MS'];
    delete process.env['BDG_CDP_RECOVERY_MAX_ATTEMPTS'];
    delete process.env['BDG_CDP_RECOVERY_MAX_SECONDS'];
    global.fetch = originalFetch;
  });

  void it('returns null immediately when cdpTargetListUrl is unset', async () => {
    const { cdp } = makeCdp();
    const result = await runCdpRecovery({
      cdp,
      config: { url: 'about:blank', port: 0 },
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach: mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP)),
    });

    assert.equal(result, null);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  void it('recovers on the first attempt: re-resolves, reconnects, re-attaches', async () => {
    const t = target('T-1');
    responses.push(okResponse([t]));
    const { cdp, connect } = makeCdp();
    const telemetryStore = new TelemetryStore();
    const cleanupFns: CleanupFunction[] = [() => {}];
    const reattach = mock.fn((..._args: ReattachArgs) => Promise.resolve(cleanupFns));

    const result = await runCdpRecovery({
      cdp,
      config: makeConfig(),
      telemetryStore,
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach,
    });

    assert.ok(result);
    assert.equal(result.attempts, 1);
    assert.equal(result.target.id, 'T-1');
    assert.equal(result.cleanupFunctions, cleanupFns);
    assert.equal(telemetryStore.targetInfo?.id, 'T-1');
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(connect.mock.calls[0]?.arguments[0], t.webSocketDebuggerUrl);
    const opts = connectOpts(connect);
    assert.equal(opts.autoReconnect, false);
    assert.equal(opts.maxRetries, 3);
    assert.equal(typeof opts.onDisconnect, 'function');
    assert.equal(reattach.mock.callCount(), 1);
    assert.equal(reattach.mock.calls[0]?.arguments[0], cdp);
  });

  void it('retries through an empty list (profile stopped) then recovers', async () => {
    responses.push(emptyResponse(), okResponse([target('T-2')]));
    const { cdp, connect } = makeCdp();
    const result = await runCdpRecovery({
      cdp,
      config: makeConfig(),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach: mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP)),
    });

    assert.ok(result);
    assert.equal(result.attempts, 2);
    assert.equal(result.lastReason, 'no targets (profile stopped/relaunching)');
    assert.equal(connect.mock.callCount(), 1);
  });

  void it('retries after a 404 list then recovers', async () => {
    responses.push(notFoundResponse(), okResponse([target('T-3')]));
    const result = await runCdpRecovery({
      cdp: makeCdp().cdp,
      config: makeConfig(),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach: mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP)),
    });

    assert.ok(result);
    assert.equal(result.attempts, 2);
    assert.equal(result.lastReason, 'no targets (profile stopped/relaunching)');
  });

  void it('retries after a network error then recovers', async () => {
    fetchMock.mock.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    responses.push(okResponse([target('T-4')]));
    const result = await runCdpRecovery({
      cdp: makeCdp().cdp,
      config: makeConfig(),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach: mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP)),
    });

    assert.ok(result);
    assert.equal(result.attempts, 2);
    assert.equal(result.lastReason, 'no targets (profile stopped/relaunching)');
  });

  void it('retries after a connect failure then recovers', async () => {
    responses.push(okResponse([target('T-5')]), okResponse([target('T-5')]));
    const { cdp, connect } = makeCdp();
    connect.mock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const result = await runCdpRecovery({
      cdp,
      config: makeConfig(),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach: mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP)),
    });

    assert.ok(result);
    assert.equal(result.attempts, 2);
    assert.equal(result.lastReason, 'reconnect failed: boom');
    assert.equal(connect.mock.callCount(), 2);
  });

  void it('retries after a reattach failure (closing the socket) then recovers', async () => {
    responses.push(okResponse([target('T-6')]), okResponse([target('T-6')]));
    const { cdp, connect, close } = makeCdp();
    const reattach = mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP));
    reattach.mock.mockImplementationOnce(() => Promise.reject(new Error('reattach boom')));
    const result = await runCdpRecovery({
      cdp,
      config: makeConfig(),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach,
    });

    assert.ok(result);
    assert.equal(result.attempts, 2);
    assert.equal(result.lastReason, 'reattach failed: reattach boom');
    assert.equal(close.mock.callCount(), 1);
    assert.equal(connect.mock.callCount(), 2);
    assert.equal(reattach.mock.callCount(), 2);
  });

  void it('exhausts to null when no target ever appears', async () => {
    process.env['BDG_CDP_RECOVERY_MAX_ATTEMPTS'] = '2';
    const { connect } = makeCdp();
    const reattach = mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP));
    const result = await runCdpRecovery({
      cdp: makeCdp().cdp,
      config: makeConfig(),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach,
    });

    assert.equal(result, null);
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(reattach.mock.callCount(), 0);
  });

  void it('aborts (returns null) when isStopped is true, before any fetch', async () => {
    const result = await runCdpRecovery({
      cdp: makeCdp().cdp,
      config: makeConfig(),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => true,
      reattach: mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP)),
    });

    assert.equal(result, null);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  void it('threads cdpHeaders to the list fetch and the reconnect', async () => {
    const headers = { Authorization: 'Bearer token' };
    responses.push(okResponse([target('T-7')]));
    const { cdp, connect } = makeCdp();
    await runCdpRecovery({
      cdp,
      config: makeConfig(headers),
      telemetryStore: new TelemetryStore(),
      chrome: null,
      log: makeLogger(),
      onDisconnect: () => {},
      isStopped: () => false,
      reattach: mock.fn((..._args: ReattachArgs) => Promise.resolve(NOOP_CLEANUP)),
    });

    const fetchArgs = fetchMock.mock.calls[0]?.arguments[1] as { headers?: Record<string, string> };
    assert.equal(fetchArgs.headers?.['Authorization'], 'Bearer token');
    assert.equal(connectOpts(connect).headers?.['Authorization'], 'Bearer token');
  });
});
