/**
 * `bdg cloak check <id>` — static coherence dry-run (no browser launch).
 *
 * CBM computes `coherence_warnings` statically on every profile read
 * (fingerprint_coherence.analyze_profile), so `GET /api/profiles/:id` already
 * returns them. `check` surfaces them as a focused lint that exits non-zero
 * when warnings are present — a fast, proxy-free tuning loop that doesn't
 * launch a browser (unlike `bdg cloak analyze`, which launches a one-shot
 * headless copy for live verification).
 *
 * Exit codes: 0 when coherent, 1 (GENERIC_FAILURE) when any warnings exist
 * (linter contract). `--json` returns the warnings array on both paths.
 */

import type { Command } from 'commander';

import { cbmGet } from '@/commands/cloak/client.js';
import { exitCodeFromStatus, withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmProfile } from '@/commands/cloak/types.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { genericError } from '@/errors/messages.js';
import { buildSuccessResponse, OutputBuilder } from '@/ui/OutputBuilder.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

type CheckOptions = BaseOptions;

/** Coherence dry-run report (the `--json` data and the formatter input). */
export interface CoherenceReport {
  profile_id: string;
  count: number;
  warnings: string[];
}

/** Render a coherence dry-run report for human-readable output. */
export function formatCheck(r: CoherenceReport): string {
  const header = `Coherence Check — ${r.profile_id}`;
  if (r.count === 0) {
    return joinLines(
      header,
      `  warnings: 0`,
      '',
      '  \u2713 coherent — no static cross-field warnings.',
      '  Run `bdg cloak analyze ' +
        r.profile_id +
        '` for a live browser check (launches a one-shot headless copy).'
    );
  }
  const lines: (string | undefined)[] = [
    header,
    `  warnings: ${r.count}`,
    '',
    `  \u26a0  Coherence Warnings (${r.count}):`,
  ];
  for (const w of r.warnings) lines.push(`     ${w}`);
  lines.push(
    '',
    '  Fix the profile (bdg cloak update) then re-run `bdg cloak check ' + r.profile_id + '`.'
  );
  return joinLines(...lines);
}

/** Register `bdg cloak check <id>`. */
export function registerCloakCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Static coherence dry-run — no browser launch (exit 0 if coherent, 1 if warnings)')
    .argument('<id>', 'Profile ID or name')
    .addOption(jsonOption())
    .action(async (id: string, options: CheckOptions) => {
      const result = await withProfileId<CbmProfile>(id, (pid) =>
        cbmGet<CbmProfile>(`/api/profiles/${encodeURIComponent(pid)}`)
      );

      if (!result.success) {
        const exitCode = exitCodeFromStatus(result.statusCode);
        if (options.json) {
          console.log(
            JSON.stringify(
              OutputBuilder.buildJsonError(result.error ?? `Failed to fetch profile '${id}'`, {
                exitCode,
                suggestion: 'Verify the profile exists. List profiles with: bdg cloak profiles',
              }),
              null,
              2
            )
          );
        } else {
          console.error(genericError(result.error ?? `Failed to fetch profile '${id}'`));
        }
        process.exit(exitCode);
      }

      const profile = result.data;
      if (!profile) {
        if (options.json) {
          console.log(
            JSON.stringify(
              OutputBuilder.buildJsonError('CBM returned no profile data', {
                exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
                suggestion: 'Verify the profile exists. List profiles with: bdg cloak profiles',
              }),
              null,
              2
            )
          );
        } else {
          console.error(genericError('CBM returned no profile data'));
        }
        process.exit(EXIT_CODES.RESOURCE_NOT_FOUND);
      }

      const warnings = profile.coherence_warnings ?? [];
      const report: CoherenceReport = {
        profile_id: id,
        count: warnings.length,
        warnings,
      };

      if (options.json) {
        if (warnings.length) {
          const errObj = OutputBuilder.buildJsonError(
            `${warnings.length} coherence warning(s) for '${id}'`,
            { exitCode: EXIT_CODES.GENERIC_FAILURE }
          );
          console.log(JSON.stringify({ ...errObj, warnings }, null, 2));
        } else {
          console.log(JSON.stringify(buildSuccessResponse(report), null, 2));
        }
      } else {
        console.log(formatCheck(report));
      }
      process.exit(warnings.length ? EXIT_CODES.GENERIC_FAILURE : EXIT_CODES.SUCCESS);
    });
}
