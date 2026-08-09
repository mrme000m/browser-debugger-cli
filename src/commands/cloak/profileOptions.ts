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

import { PROFILE_FIELDS } from '@/commands/cloak/schema.js';
import type { CbmTag } from '@/commands/cloak/types.js';

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
 * Build the create/update body from parsed options (only includes provided fields).
 * Mirrors cbpm's bodyFromOptions: snake_case field names, tag:color parsing,
 * and clipboard_sync only sent when explicitly disabled.
 *
 * The Commander option key is derived from the field's flag (not its name), which
 * fixes a latent mismatch in cbpm for fields whose flag is not the kebab of the
 * name: --tag (tags), --proxy-credential (proxy_credential_id),
 * --proxy-group (proxy_group_id), --launch-arg (launch_args).
 */
export function bodyFromOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
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
    if (f.type === 'list[string]') {
      if ((val as string[]).length) body[f.name] = val;
      continue;
    }
    body[f.name] = val;
  }
  return body;
}
