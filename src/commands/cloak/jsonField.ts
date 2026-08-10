/**
 * JSON-object field parsing for `bdg cloak create` / `bdg cloak update`.
 *
 * Several CBM profile fields are JSON objects (`storage_state`, `human_config`),
 * but Commander hands us strings. The naive `body[f.name] = val` path sent the
 * raw string to a dict-typed backend field (HTTP 422) — these flags were dead.
 *
 * `parseJsonObject` resolves a value that is either:
 *   - a path to an existing JSON file (read + parse), or
 *   - an inline JSON string (parse directly),
 * and requires the result to be a plain object (not an array / primitive).
 *
 * Shared by `bdg cloak create|update` (this repo) and mirrored by cbpm.
 */

import { existsSync, readFileSync } from 'node:fs';

/** Successful parse result. */
export interface JsonFieldOk {
  ok: true;
  /** The parsed plain object. */
  value: Record<string, unknown>;
}

/** Failed parse result. */
export interface JsonFieldErr {
  ok: false;
  /** Human-readable reason (suitable for a CLI error). */
  error: string;
}

export type JsonFieldResult = JsonFieldOk | JsonFieldErr;

/**
 * Parse a CLI string into a JSON object.
 *
 * Resolution order:
 *   1. If the string is a path to an existing file → read it and `JSON.parse`.
 *   2. Otherwise → `JSON.parse` the string inline.
 *   3. The parsed value must be a plain object (`{}`); arrays and primitives
 *      are rejected (the backend fields are dicts).
 *
 * @param value - The raw Commander string (a file path or inline JSON).
 * @param field - Backend field name, used in error messages (e.g. "storage_state").
 * @returns `{ ok: true, value }` on success, or `{ ok: false, error }` on failure.
 */
export function parseJsonObject(value: string, field: string): JsonFieldResult {
  const raw = resolveRaw(value, field);
  if (!raw.ok) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.value);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `--${field.replace(/_/g, '-')} is not valid JSON${raw.source === 'file' ? ` (file: ${value})` : ''}: ${msg}`,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `--${field.replace(/_/g, '-')} must be a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}).`,
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Resolve the raw text to parse: read from file if the string is an existing
 * file path, otherwise treat the string itself as inline JSON text.
 */
function resolveRaw(value: string, field: string): JsonFieldRawResult {
  if (value === '') {
    return { ok: false, error: `--${field.replace(/_/g, '-')} is empty.` };
  }
  // A JSON object string never names an existing file; a path that does exist
  // is read from disk. This keeps inline JSON the primary ergonomic while
  // still accepting a file path (the documented `--storage-state <file>` form).
  try {
    if (existsSync(value)) {
      return { ok: true, value: readFileSync(value, 'utf-8'), source: 'file' };
    }
  } catch {
    // existsSync/readFileSync can throw on paths with null bytes etc.; fall
    // through to inline parsing, which will produce a clear JSON error.
  }
  return { ok: true, value, source: 'inline' };
}

interface JsonFieldRawOk {
  ok: true;
  value: string;
  source: 'file' | 'inline';
}
type JsonFieldRawResult = JsonFieldRawOk | JsonFieldErr;
