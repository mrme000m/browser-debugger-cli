/**
 * `bdg cloak analyze` command.
 *
 * Runs a one-shot bot-detection test against a profile by POSTing to
 * /api/profiles/:id/analyze on the CBM server.
 *
 * Mirrors: CBM backend/main.py POST /api/profiles/{id}/analyze.
 */

import type { Command } from 'commander';

import { cbmPost } from '@/commands/cloak/client.js';
import { withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmDetectionReport } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Analyze command options. */
type AnalyzeOptions = BaseOptions;

/** Pass/fail icon. */
function statusMark(result: string): string {
  const r = result.toLowerCase();
  if (r.includes('pass') || r.includes('true') || r.includes('ok')) return '  ✅';
  if (r.includes('fail') || r.includes('false') || r.includes('missing')) return '  ❌';
  return '  ⬜';
}

/**
 * Format analysis results for human-readable output.
 */
function formatAnalysis(data: CbmDetectionReport): string {
  const lines: (string | undefined)[] = [
    `Detection Test Results — ${data.profile_id}`,
    `  Passed:  ${data.passed}`,
    `  Failed:  ${data.failed}`,
    undefined,
    '  ── Checks ──',
  ];
  for (const d of data.details) {
    lines.push(`  ${statusMark(d.result)} ${d.test}: ${d.result}`);
  }
  if (data.coherence_warnings && data.coherence_warnings.length > 0) {
    lines.push(undefined, `  ⚠  Coherence Warnings (${data.coherence_warnings.length}):`);
    for (const w of data.coherence_warnings) {
      lines.push(`     ${w}`);
    }
  }
  if (data.error) {
    lines.push(undefined, `  ⚠  Error: ${data.error}`);
  }
  return joinLines(...lines);
}

/**
 * Register the `cloak analyze` subcommand.
 */
export function registerCloakAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Run bot-detection test against a profile (POST /analyze)')
    .argument('<id>', 'Profile ID or name')
    .addOption(jsonOption())
    .action(async (id: string, options: AnalyzeOptions) => {
      await runCommand<AnalyzeOptions, CbmDetectionReport>(
        async () => {
          const result = await withProfileId<CbmDetectionReport>(id, (pid) =>
            cbmPost<CbmDetectionReport>(`/api/profiles/${encodeURIComponent(pid)}/analyze`)
          );

          if (!result.success) {
            return {
              success: false,
              error: result.error ?? 'Detection analysis failed',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion:
                  'The profile may need to have a valid proxy and fingerprint config for meaningful results.',
              },
            };
          }

          const data = result.data;
          if (!data) {
            return {
              success: false,
              error: 'CBM returned no analysis data',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
            };
          }

          return {
            success: true,
            data,
          };
        },
        options,
        formatAnalysis
      );
    });
}
