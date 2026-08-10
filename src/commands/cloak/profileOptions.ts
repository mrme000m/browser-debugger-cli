/**
 * Shared option wiring for `bdg cloak create` / `bdg cloak update`.
 *
 * - applyProfileOptions(): adds one Commander option per PROFILE_FIELDS entry
 *   (keeps the CLI surface in sync with the schema).
 * - bodyFromOptions(): builds the create/update payload (only provided fields),
 *   mirroring cbpm's bodyFromOptions in CloakBrowser-Manager/cli/src/commands/profiles.ts.
 */

import { Option } from 'commander';

import type { Command } from 'commander';

import { HUMAN_CONFIG_KEYS } from '@/commands/cloak/humanConfig.js';
import { parseJsonObject } from '@/commands/cloak/jsonField.js';
import { PROFILE_FIELDS } from '@/commands/cloak/schema.js';
import type { CbmTag } from '@/commands/cloak/types.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Convert a snake_case field name to the camelCase key Commander uses for the option. */
function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_m: string, c: string) => c.toUpperCase());
}

/** Commander repeatable-option accumulator. */
function collect(v: string, p: string[]): string[] {
  p.push(v);
  return p;
}

/** Build a tag/color pair as accepted by the profile create/update endpoints. */
function makeTag(t: string, color?: string): CbmTag {
  return color ? { tag: t, color } : { tag: t, color: null };
}

/**
 * Add a Commander option per field in PROFILE_FIELDS.
 * Special-cases clipboard_sync (negated as --no-clipboard-sync).
 */
export function applyProfileOptions(cmd: Command): void {
  for (const f of PROFILE_FIELDS) {
    if (f.name === 'clipboard_sync') {
      cmd.option('--no-clipboard-sync', 'Disable clipboard sync (default: enabled)');
      continue;
    }
    if (f.type === 'bool') {
      cmd.option(f.flag, f.description);
    } else if (f.type === 'int') {
      cmd.option(`${f.flag} <n>`, f.description, (v: string) => parseInt(v, 10));
    } else if (f.type === 'float') {
      cmd.option(`${f.flag} <n>`, f.description, (v: string) => parseFloat(v));
    } else if (f.type === 'list[string]') {
      cmd.option(`${f.flag} <v>`, `${f.description} (repeatable)`, collect, [] as string[]);
    } else if (f.type.startsWith('enum:')) {
      const choices = f.type.slice(5).split('|');
      cmd.addOption(new Option(`${f.flag} <v>`, f.description).choices(choices));
    } else {
      cmd.option(`${f.flag} <v>`, f.description);
    }
  }
}

/**
 * Result of building a create/update body.
 *
 * `bodyFromOptions` now parses the dict-typed fields (`storage_state`,
 * `human_config`) instead of forwarding raw strings — those flags previously
 * sent a path/JSON string to dict-typed backend fields (HTTP 422). On a parse
 * failure `error`/`exitCode` are set; soft diagnostics (e.g. unknown
 * `--human-config` keys the SDK would silently ignore) are returned as
 * `warnings` for the caller to surface as a stderr hint.
 */
export interface BodyBuildResult {
  /** The create/update payload (only provided fields). */
  body: Record<string, unknown>;
  /** Set when a provided field value was invalid (e.g. malformed JSON). */
  error?: string;
  /** Exit code to use when `error` is set. */
  exitCode?: number;
  /** Soft diagnostics to show as a stderr hint on success. */
  warnings?: string[];
}

/**
 * Build the create/update body from parsed options (only includes provided fields).
 * Mirrors cbpm's bodyFromOptions: snake_case field names, tag:color parsing,
 * and clipboard_sync only sent when explicitly disabled.
 *
 * The Commander option key is derived from the field's flag (not its name), which
 * fixes a latent mismatch in cbpm for fields whose flag is not the kebab of the
 * name: --tag (tags), --proxy-credential (proxy_credential_id),
 * --proxy-group (proxy_group_id), --launch-arg (launch_args).
 *
 * Dict-typed fields (`storage_state`, `human_config`) are parsed: `storage_state`
 * accepts a JSON file path or inline JSON; `human_config` accepts inline JSON and
 * warns on keys the SDK's `HumanConfigOverrides` doesn't define (the SDK silently
 * ignores unknown keys — a footgun this surfaces).
 */
export function bodyFromOptions(opts: Record<string, unknown>): BodyBuildResult {
  const body: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const f of PROFILE_FIELDS) {
    // Commander stores options under the camelCase of the flag, not the field name.
    const key = camel(f.flag.replace(/^--/, '').replace(/-/g, '_'));
    const val = opts[key];
    if (val === undefined) continue;
    if (f.name === 'tags') {
      const arr = val as string[];
      // Skip the default empty array so omitting --tag leaves tags unchanged
      // (and so `update` with no real fields is detected as empty).
      if (arr.length) {
        body['tags'] = arr.map((t) => {
          const i = t.indexOf(':');
          return i > 0 ? makeTag(t.slice(0, i), t.slice(i + 1)) : makeTag(t);
        });
      }
      continue;
    }
    if (f.name === 'clipboard_sync') {
      // --no-clipboard-sync -> false; otherwise omit (server default true)
      if (val === false) body['clipboard_sync'] = false;
      continue;
    }
    if (f.name === 'storage_state') {
      // --storage-state <file|json>: send a parsed object, not the raw string
      // (the backend field is dict-typed; a raw string is HTTP 422).
      const parsed = parseJsonObject(val as string, f.name);
      if (!parsed.ok) return { body, error: parsed.error, exitCode: EXIT_CODES.INVALID_ARGUMENTS };
      body['storage_state'] = parsed.value;
      continue;
    }
    if (f.name === 'human_config') {
      // --human-config '<json>': send a parsed object, and warn on keys the SDK
      // would silently ignore (HumanConfigOverrides is a fixed TypedDict).
      const parsed = parseJsonObject(val as string, f.name);
      if (!parsed.ok) return { body, error: parsed.error, exitCode: EXIT_CODES.INVALID_ARGUMENTS };
      const unknown = Object.keys(parsed.value).filter((k) => !HUMAN_CONFIG_KEYS.has(k));
      if (unknown.length) {
        warnings.push(
          `--human-config: unknown key${unknown.length > 1 ? 's' : ''} ` +
            `${unknown.map((k) => `'${k}'`).join(', ')} (silently ignored by the SDK). ` +
            `Run \`bdg cloak human-config\` for the valid keys.`
        );
      }
      body['human_config'] = parsed.value;
      continue;
    }
    if (f.type === 'list[string]') {
      if ((val as string[]).length) body[f.name] = val;
      continue;
    }
    body[f.name] = val;
  }
  return warnings.length ? { body, warnings } : { body };
}
