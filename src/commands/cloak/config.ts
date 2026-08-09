/**
 * Configuration resolver for CloakBrowser Manager (CBM) API.
 *
 * Reads configuration from:
 * 1. Environment variables: CBPM_API_URL, CBPM_API_TOKEN
 * 2. Config file: ~/.cbpm/config.json (\{ api_url, token \})
 *
 * Environment variables take precedence over the config file.
 * bdg and cbpm share the same config so users configure once.
 *
 * Mirrors: /home/m/ob/CloakBrowser-Manager/cli/src/config.ts
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CbmApiConfig } from '@/commands/cloak/types.js';

/** Default CBM API base URL (loopback). Same as cbpm's DEFAULT_API_URL. */
const DEFAULT_API_URL = 'http://127.0.0.1:8080';

/** Env-var override names (mirrors cbpm's ENV_API_URL / ENV_API_TOKEN). */
const ENV_API_URL = 'CBPM_API_URL';
const ENV_API_TOKEN = 'CBPM_API_TOKEN';

/** Config directory and file name. */
const CONFIG_DIR = '.cbpm';
const CONFIG_FILE = 'config.json';

/**
 * Read the CBM config file if it exists.
 *
 * @returns Parsed config object or null if file doesn't exist or is invalid.
 */
function readConfigFile(): CbmApiConfig | null {
  try {
    const configPath = join(homedir(), CONFIG_DIR, CONFIG_FILE);
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const api_url =
        typeof obj['api_url'] === 'string' && obj['api_url'].length > 0
          ? obj['api_url']
          : DEFAULT_API_URL;
      const token = typeof obj['token'] === 'string' ? obj['token'] : '';
      return { api_url, token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective CBM API configuration.
 *
 * Precedence: env vars \> config file \> defaults.
 * Matches cbpm's effectiveConfig() logic.
 *
 * @returns Resolved API configuration.
 *
 * @example
 * ```typescript
 * const config = getCbmApiConfig();
 * // config.api_url = 'http://127.0.0.1:8080'
 * // config.token = 'my-secret-token'  // or '' if not configured
 * ```
 */
export function getCbmApiConfig(): CbmApiConfig {
  const envUrl = process.env[ENV_API_URL];
  const envToken = process.env[ENV_API_TOKEN];

  const fileConfig = readConfigFile();
  const fileUrl = fileConfig?.api_url ?? DEFAULT_API_URL;
  const fileToken = fileConfig?.token ?? '';

  return {
    api_url: (envUrl ?? fileUrl).replace(/\/+$/, ''), // strip trailing slashes
    token: envToken ?? fileToken,
  };
}
