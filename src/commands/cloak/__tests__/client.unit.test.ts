/**
 * CBM HTTP Client Unit Tests
 *
 * Tests the CloakBrowser Manager API client functions.
 *
 * Following the existing testing conventions in src/utils/__tests__/http.unit.test.ts:
 * - Test BEHAVIOR: "HTTP errors return structured results, never throw"
 * - Test EDGE CASES: timeouts, network errors, non-JSON responses, 204 no-content
 * - Mock the BOUNDARY: global fetch()
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { cbmFetch, cbmGet, cbmPost } from '@/commands/cloak/client.js';
import type { CbmApiConfig } from '@/commands/cloak/types.js';

/** Fixed config for deterministic test results. */
const testConfig: CbmApiConfig = { api_url: 'http://test.local:8080', token: '' };
const testConfigWithToken: CbmApiConfig = {
  api_url: 'http://test.local:8080',
  token: 'test-token-123',
};

void describe('CBM HTTP Client', () => {
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

  void describe('cbmFetch()', () => {
    void it('returns success with data on HTTP 200', async () => {
      const mockData = {
        running_count: 2,
        binary_version: '1.0.0',
        profiles_total: 5,
        max_running: null,
        total_cpu_percent: null,
        total_mem_mb: null,
        total_proc_count: null,
      };

      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(mockData)),
        })
      );

      const result = await cbmFetch<typeof mockData>('GET', '/api/status', undefined, testConfig);

      assert.equal(result.success, true);
      assert.deepEqual(result.data, mockData);
      assert.equal(result.statusCode, 200);
    });

    void it('attaches Bearer auth header when token is configured', async () => {
      let capturedHeaders: Record<string, string> = {};

      fetchMock.mock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.headers) {
          capturedHeaders = init.headers as Record<string, string>;
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{}'),
        });
      });

      await cbmFetch('GET', '/api/profiles', undefined, testConfigWithToken);

      assert.equal(
        capturedHeaders['Authorization'],
        'Bearer test-token-123',
        'Should include Bearer token'
      );
    });

    void it('does not attach auth header when token is empty', async () => {
      let capturedHeaders: Record<string, string> = {};

      fetchMock.mock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.headers) {
          capturedHeaders = init.headers as Record<string, string>;
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{}'),
        });
      });

      await cbmFetch('GET', '/api/status', undefined, testConfig);

      assert.equal(
        capturedHeaders['Authorization'],
        undefined,
        'Should not include auth header when token is empty'
      );
    });

    void it('returns failure on HTTP 404 with JSON detail', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: () => Promise.resolve(JSON.stringify({ detail: 'Profile not found' })),
        })
      );

      const result = await cbmFetch('GET', '/api/profiles/nonexistent', undefined, testConfig);

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('Profile not found'));
      assert.equal(result.statusCode, 404);
    });

    void it('returns failure on HTTP 500 with no body', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: () => Promise.resolve(''),
        })
      );

      const result = await cbmFetch('GET', '/api/status', undefined, testConfig);

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('HTTP 500'));
    });

    void it('returns failure on network error', async () => {
      fetchMock.mock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await cbmFetch('GET', '/api/status', undefined, testConfig);

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('Network error'));
      assert.ok(result.error?.includes('ECONNREFUSED'));
    });

    void it('returns success with undefined on HTTP 204 No Content', async () => {
      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 204,
          text: () => Promise.resolve(''),
        })
      );

      const result = await cbmFetch('DELETE', '/api/profiles/p1', undefined, testConfig);

      assert.equal(result.success, true);
      assert.equal(result.data, undefined);
    });

    void it('sends JSON body on POST requests', async () => {
      let capturedBody = '';

      fetchMock.mock.mockImplementation((_url: string, init?: RequestInit) => {
        capturedBody = (init?.body as string) ?? '';
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{"profile_id":"p1","status":"running"}'),
        });
      });

      const body = {};
      await cbmFetch('POST', '/api/profiles/p1/launch', body, testConfig);

      assert.equal(capturedBody, JSON.stringify(body));
    });

    void it('constructs correct URL from config and path', async () => {
      let capturedUrl = '';

      fetchMock.mock.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('[]'),
        });
      });

      await cbmFetch('GET', '/api/profiles', undefined, testConfig);

      assert.equal(capturedUrl, 'http://test.local:8080/api/profiles');
    });

    void it('includes Accept: application/json header', async () => {
      let capturedHeaders: Record<string, string> = {};

      fetchMock.mock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.headers) {
          capturedHeaders = init.headers as Record<string, string>;
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{}'),
        });
      });

      await cbmFetch('GET', '/api/status', undefined, testConfig);

      assert.equal(capturedHeaders['Accept'], 'application/json');
    });
  });

  void describe('cbmGet() convenience wrapper', () => {
    void it('delegates to cbmFetch with GET method', async () => {
      const mockData = [{ id: 'p1', name: 'Test' }];

      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(mockData)),
        })
      );

      const result = await cbmGet<typeof mockData>('/api/profiles', testConfig);

      assert.equal(result.success, true);
      assert.deepEqual(result.data, mockData);
    });
  });

  void describe('cbmPost() convenience wrapper', () => {
    void it('delegates to cbmFetch with POST method and body', async () => {
      const mockResponse = { ok: true };

      fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(mockResponse)),
        })
      );

      const result = await cbmPost<typeof mockResponse>(
        '/api/profiles/p1/stop',
        undefined,
        testConfig
      );

      assert.equal(result.success, true);
      assert.deepEqual(result.data, mockResponse);
    });
  });
});
