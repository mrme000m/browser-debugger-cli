/**
 * HTTP client for CloakBrowser Manager (CBM) REST API.
 *
 * Mirrors the pattern in /home/m/ob/CloakBrowser-Manager/cli/src/client.ts:
 * - AbortController-based timeout (30s, matching cbpm's REQUEST_TIMEOUT_MS)
 * - Bearer token via Authorization header
 * - Structured error handling via CbmApiResult (never throws for HTTP/network errors)
 * - Base URL is resolved at call time from config
 */

import { getCbmApiConfig } from '@/commands/cloak/config.js';
import type { CbmApiConfig } from '@/commands/cloak/types.js';

/** Request timeout in milliseconds (matches cbpm's REQUEST_TIMEOUT_MS). */
const CBM_HTTP_TIMEOUT_MS = 30_000;

/** Result of a CBM API call. */
export interface CbmApiResult<T = unknown> {
  /** Whether the request succeeded (HTTP 2xx + valid body). */
  success: boolean;
  /** Response data (when successful). */
  data?: T;
  /** Error message (when unsuccessful). */
  error?: string;
  /** HTTP status code (when available). */
  statusCode?: number;
}

/**
 * Perform an HTTP request to the CBM API.
 *
 * Automatically resolves the API base URL via getCbmApiConfig() and
 * attaches Bearer token if configured. Handles timeouts, network errors,
 * and non-2xx responses gracefully by returning structured results.
 *
 * The path should include the leading `/api/` prefix (e.g., `/api/status`).
 *
 * @param method - HTTP method (GET, POST, DELETE).
 * @param path - API path relative to base URL (e.g., '/api/profiles').
 * @param body - Optional request body (serialized as JSON).
 * @param config - Optional API config override (defaults to getCbmApiConfig()).
 * @returns Structured result with typed data on success.
 *
 * @example
 * ```typescript
 * const result = await cbmFetch<CbmSystemStatus>('GET', '/api/status');
 * if (result.success) {
 *   console.log('Running:', result.data.running_count);
 * }
 * ```
 */
export async function cbmFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  config?: CbmApiConfig
): Promise<CbmApiResult<T>> {
  const cfg = config ?? getCbmApiConfig();
  const url = `${cfg.api_url}${path}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CBM_HTTP_TIMEOUT_MS);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (cfg.token) {
      headers['Authorization'] = `Bearer ${cfg.token}`;
    }

    let response: Response;
    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }
      response = await fetch(url, fetchOptions);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore body read errors
      }

      // Try to extract JSON detail from error response (mirrors cbpm errorDetail())
      let detail: string | undefined;
      try {
        if (errorBody) {
          const parsed = JSON.parse(errorBody) as { detail?: string; message?: string };
          detail = parsed.detail ?? parsed.message;
        }
      } catch {
        // not JSON
      }

      const message =
        detail ??
        (errorBody && errorBody.length < 500
          ? errorBody
          : `HTTP ${response.status} ${response.statusText}`);

      return {
        success: false,
        error: message,
        statusCode: response.status,
      };
    }

    // 204 No Content or empty body
    if (response.status === 204) {
      return { success: true, data: undefined as T, statusCode: response.status };
    }

    const text = await response.text();
    if (!text) {
      return { success: true, data: undefined as T, statusCode: response.status };
    }

    try {
      const data = JSON.parse(text) as T;
      return { success: true, data, statusCode: response.status };
    } catch {
      return {
        success: false,
        error: `Invalid JSON response from ${method} ${path}`,
        statusCode: response.status,
      };
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: `Request timed out after ${CBM_HTTP_TIMEOUT_MS}ms: ${method} ${path}`,
        };
      }
      return {
        success: false,
        error: `Network error: ${error.message}`,
      };
    }
    return {
      success: false,
      error: `Unknown error: ${String(error)}`,
    };
  }
}

/**
 * Convenience wrapper for GET requests.
 */
export async function cbmGet<T = unknown>(
  path: string,
  config?: CbmApiConfig
): Promise<CbmApiResult<T>> {
  return cbmFetch<T>('GET', path, undefined, config);
}

/**
 * Convenience wrapper for POST requests.
 */
export async function cbmPost<T = unknown>(
  path: string,
  body?: unknown,
  config?: CbmApiConfig
): Promise<CbmApiResult<T>> {
  return cbmFetch<T>('POST', path, body, config);
}
