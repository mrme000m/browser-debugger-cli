/**
 * CDP target selection / re-resolution unit tests.
 *
 * Following the testing philosophy:
 * - Test the BEHAVIOR: "findPageTarget prefers a real page; fetchCdpTargetList
 *   returns [] on any HTTP/network error so callers retry through the relaunch
 *   window".
 * - Test the PROPERTY: "errors never throw — they return null/[]".
 * - Mock the BOUNDARY: fetch() (external HTTP dependency).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { CDPTarget } from '@/types';
import { fetchCdpTargetList, findPageTarget } from '@/utils/cdpTargets.js';

/** Build a CDP target for tests. */
function target(partial: Partial<CDPTarget>): CDPTarget {
  return {
    id: partial.id ?? 't-1',
    type: partial.type ?? 'page',
    title: partial.title ?? 'Page',
    url: partial.url ?? 'http://localhost:3000',
    webSocketDebuggerUrl: partial.webSocketDebuggerUrl ?? 'ws://127.0.0.1:9222/devtools/page/t-1',
  };
}

void describe('cdpTargets', () => {
  void describe('findPageTarget()', () => {
    void it('returns null for an empty list', () => {
      assert.equal(findPageTarget([]), null);
    });

    void it('prefers a real page over about:blank / chrome:// / devtools://', () => {
      const targets = [
        target({ id: 'blank', url: 'about:blank', webSocketDebuggerUrl: 'ws://blank' }),
        target({ id: 'chrome', url: 'chrome://newtab', webSocketDebuggerUrl: 'ws://chrome' }),
        target({ id: 'real', url: 'https://example.com', webSocketDebuggerUrl: 'ws://real' }),
      ];
      const found = findPageTarget(targets);
      assert.equal(found?.id, 'real');
    });

    void it('falls back to any page target when no real-URL page exists', () => {
      const targets = [
        target({ id: 'blank', url: 'about:blank', webSocketDebuggerUrl: 'ws://blank' }),
      ];
      const found = findPageTarget(targets);
      assert.equal(found?.id, 'blank');
    });

    void it('falls back to the first target of any type with a webSocketDebuggerUrl', () => {
      const targets = [
        target({ id: 'bg', type: 'background_page', webSocketDebuggerUrl: 'ws://bg' }),
      ];
      const found = findPageTarget(targets);
      assert.equal(found?.id, 'bg');
    });

    void it('returns null when no target has a webSocketDebuggerUrl', () => {
      const targets = [target({ id: 'x', type: 'other', webSocketDebuggerUrl: '' })];
      // Empty-string webSocketDebuggerUrl is falsy → not chosen by last-resort.
      assert.equal(findPageTarget(targets), null);
    });

    void it('picks the real page among a mixed list', () => {
      const targets = [
        target({ id: 'sw', type: 'service_worker', webSocketDebuggerUrl: 'ws://sw' }),
        target({ id: 'real', url: 'https://shop.example', webSocketDebuggerUrl: 'ws://real' }),
        target({ id: 'blank', url: 'about:blank', webSocketDebuggerUrl: 'ws://blank' }),
      ];
      assert.equal(findPageTarget(targets)?.id, 'real');
    });
  });

  void describe('fetchCdpTargetList()', () => {
    let originalFetch: typeof global.fetch;
    let fetchMock: ReturnType<typeof mock.fn>;

    beforeEach(() => {
      originalFetch = global.fetch;
      fetchMock = mock.fn(global.fetch);
      global.fetch = fetchMock as unknown as typeof global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    void it('returns the target array when the request succeeds', async () => {
      const list = [target({ id: 'a' }), target({ id: 'b' })];
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(list) })
      );

      const result = await fetchCdpTargetList('https://host/api/profiles/x/cdp/json/list');

      assert.ok(Array.isArray(result));
      assert.equal(result.length, 2);
      assert.equal(result[0]?.id, 'a');
    });

    void it('returns [] on a non-2xx (profile stopped → 404)', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' })
      );
      assert.deepEqual(await fetchCdpTargetList('u'), []);
    });

    void it('returns [] on a 502 (Chrome unreachable)', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: false, status: 502, statusText: 'Bad Gateway' })
      );
      assert.deepEqual(await fetchCdpTargetList('u'), []);
    });

    void it('returns [] when the response is not an array', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ detail: 'nope' }) })
      );
      assert.deepEqual(await fetchCdpTargetList('u'), []);
    });

    void it('returns [] on a network error', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
      assert.deepEqual(await fetchCdpTargetList('u'), []);
    });

    void it('returns [] on abort/timeout', async () => {
      fetchMock.mock.mockImplementation((_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });
      assert.deepEqual(await fetchCdpTargetList('u', undefined, undefined, 50), []);
    });

    void it('passes the given auth headers on the request', async () => {
      let receivedHeaders: unknown;
      fetchMock.mock.mockImplementation((_url: string, options?: { headers?: unknown }) => {
        receivedHeaders = options?.headers;
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const headers = { Authorization: 'Bearer tok' };
      await fetchCdpTargetList('u', headers);

      assert.equal(receivedHeaders, headers);
    });

    void it('omits headers when none are provided', async () => {
      let optionsKeys: string[] = [];
      fetchMock.mock.mockImplementation((_url: string, options?: Record<string, unknown>) => {
        optionsKeys = Object.keys(options ?? {});
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      await fetchCdpTargetList('u');

      assert.ok(!optionsKeys.includes('headers'), 'should not send a headers key');
    });

    void it('requests the exact URL provided', async () => {
      let requestedUrl = '';
      fetchMock.mock.mockImplementation((url: string) => {
        requestedUrl = url;
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const url = 'https://clk.example/api/profiles/abc/cdp/local/json/list';
      await fetchCdpTargetList(url);
      assert.equal(requestedUrl, url);
    });
  });
});
