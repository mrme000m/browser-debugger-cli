/**
 * bdg general configuration — persistent defaults for the generic
 * `bdg <url>` attach-to-existing-Chrome path.
 *
 * Lets you bake `--chrome-ws-url` and `--cdp-headers` into a config file so
 * they don't have to be passed on every invocation (useful for reaching an
 * authenticated / remote CDP endpoint such as a CloakBrowser Manager profile
 * exposed over a Cloudflare tunnel).
 *
 * Config file locations (first found):
 *   1. $BDG_CONFIG_FILE          — explicit path override
 *   2. $XDG_CONFIG_HOME/bdg/config.json   (default ~/.config/bdg/config.json)
 *
 * See docs/configuration.md for the field reference and an example config file.
 *
 * Env overrides (take precedence over the config file; CLI flags take
 * precedence over both, applied by the caller):
 *   BDG_CHROME_WS_URL   → default for --chrome-ws-url
 *   BDG_CDP_HEADERS     → default for --cdp-headers (JSON object string)
 *
 * Per-field precedence (highest to lowest): CLI flag, then env var, then config
 * file, then undefined.
 *
 * Note: this is independent of the CloakBrowser Manager config
 * (~/.cbpm/config.json) used by `bdg cloak`. For CBM, prefer
 * `bdg cloak connect`, which derives the auth header from the cbpm token
 * automatically.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolved bdg attach defaults. */
export interface BdgConfig {
  /** Default --chrome-ws-url (existing Chrome CDP endpoint). */
  chromeWsUrl?: string | undefined;
  /** Default --cdp-headers (HTTP headers for the CDP WebSocket upgrade). */
  cdpHeaders?: Record<string, string> | undefined;
}

/** Raw shape of the config file (values are validated before use). */
interface BdgConfigFile {
  chromeWsUrl?: unknown;
  cdpHeaders?: unknown;
}

const CONFIG_SUBDIR = 'bdg';
const CONFIG_FILENAME = 'config.json';

/** Resolve the config file path from the env override or XDG/home fallback. */
function configFilePath(): string {
  const override = process.env['BDG_CONFIG_FILE'];
  if (override) return override;
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, CONFIG_SUBDIR, CONFIG_FILENAME);
}

/** Read and parse the config file if present; returns an empty object on any error. */
function readConfigFile(): BdgConfigFile {
  try {
    const raw = readFileSync(configFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as BdgConfigFile;
    }
    return {};
  } catch {
    // Missing file or invalid JSON → treat as no config.
    return {};
  }
}

/**
 * Parse a JSON object string into a header map.
 *
 * Accepts a JSON object string such as a Bearer authorization map. Returns
 * undefined for empty input, malformed JSON, or any non-object (e.g. arrays / primitives),
 * so callers can fall through with `??`.
 *
 * @param value - JSON string (or undefined).
 * @returns Header map, or undefined if unparseable / not an object.
 */
export function parseHeadersObject(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore malformed JSON
  }
  return undefined;
}

/**
 * Resolve effective bdg attach defaults.
 *
 * Per-field precedence (highest to lowest): env var, then config file. CLI
 * flags are applied by the caller (buildSessionOptions), which take precedence
 *
 * @returns Resolved config (fields undefined when unset).
 *
 * @example
 * ```typescript
 * const cfg = getBdgConfig();
 * // cfg.chromeWsUrl, cfg.cdpHeaders
 * ```
 */
export function getBdgConfig(): BdgConfig {
  const file = readConfigFile();

  const chromeWsUrl =
    process.env['BDG_CHROME_WS_URL'] ??
    (typeof file.chromeWsUrl === 'string' ? file.chromeWsUrl : undefined);

  const envHeaders = parseHeadersObject(process.env['BDG_CDP_HEADERS']);
  const fileHeaders =
    file.cdpHeaders && typeof file.cdpHeaders === 'object' && !Array.isArray(file.cdpHeaders)
      ? (file.cdpHeaders as Record<string, string>)
      : undefined;
  const cdpHeaders = envHeaders ?? fileHeaders;

  return { chromeWsUrl, cdpHeaders };
}
