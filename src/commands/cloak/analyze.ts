/**
 * `bdg cloak analyze` command.
 *
 * Runs a one-shot bot-detection test against a profile by POSTing to
 * /api/profiles/:id/analyze on the CBM server.
 *
 * Mirrors the CBM backend POST /api/profiles/<id>/analyze endpoint.
 */

import type { Command } from 'commander';

import { cbmPost } from '@/commands/cloak/client.js';
import { withProfileId } from '@/commands/cloak/resolve.js';
import type { CbmDetectionCheck, CbmDetectionReport } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Analyze command options. */
type AnalyzeOptions = BaseOptions;

/**
 * Loose shape the formatter accepts. CBM's analyze contract is the new
 * `checks[]` report (actual vs expected vs detail), but older pre-v0.6 servers
 * returned a `details[]` array of test/result rows with no `warnings`/`checks`.
 * The formatter renders whichever the server returns, so bdg works against both.
 */
export interface AnalysisInput {
  profile_id: string;
  passed?: number;
  failed?: number;
  warnings?: number;
  checks?: CbmDetectionCheck[];
  coherence_warnings?: string[];
  /** Legacy pre-v0.6 servers. */
  details?: { test: string; result: string }[];
  error?: string;
}

/** Truncate a string to n chars with an ellipsis. */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Compact JSON-ish rendering of an actual/expected check value. */
function fmtVal(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${truncate(v, 80)}"`;
  try {
    return truncate(JSON.stringify(v), 80);
  } catch {
    return '[unserializable]';
  }
}

/** Icon for a check status (pass/fail/warn). */
function statusIcon(status: string): string {
  if (status === 'pass') return '✅';
  if (status === 'fail') return '❌';
  return '⚠';
}

/**
 * Format analysis results for human-readable output.
 *
 * Renders the per-signal `checks` with actual-vs-expected-vs-detail (the
 * auto-discoverable detail CBM now returns), plus the static coherence
 * warnings. Falls back to the legacy `details[]` shape for older servers.
 */
export function formatAnalysis(data: AnalysisInput): string {
  const lines: (string | undefined)[] = [
    `Detection Test Results — ${data.profile_id}`,
    `  Passed:  ${data.passed ?? 0}   Failed:  ${data.failed ?? 0}   Warnings:  ${data.warnings ?? 0}`,
  ];

  if (data.error) {
    lines.push(undefined, `  ⚠  Error: ${data.error}`);
  }

  const checks = data.checks;
  if (checks && checks.length > 0) {
    lines.push(undefined, '  ── Checks ──');
    for (const c of checks) {
      const icon = statusIcon(c.status ?? '');
      const actualExpected = `actual=${fmtVal(c.actual)} expected=${fmtVal(c.expected)}`;
      const detail = c.detail ? ` — ${c.detail}` : '';
      lines.push(`  ${icon} ${c.test}: ${actualExpected}${detail}`);
    }
  } else if (data.details && data.details.length > 0) {
    // Back-compat: older CBM servers return { details: [{test, result}] }.
    lines.push(undefined, '  ── Checks (legacy server) ──');
    for (const d of data.details) {
      const r = (d.result ?? '').toLowerCase();
      const icon = r.includes('pass') || r.includes('ok') ? '✅' : r.includes('fail') ? '❌' : '⬜';
      lines.push(`  ${icon} ${d.test}: ${d.result}`);
    }
  } else if (!data.error) {
    lines.push(
      undefined,
      '  (no checks returned — the profile may need a valid proxy and fingerprint config for meaningful results)'
    );
  }

  const warnings = data.coherence_warnings;
  if (warnings && warnings.length > 0) {
    lines.push(undefined, `  ⚠  Coherence Warnings (${warnings.length}):`);
    for (const w of warnings) {
      lines.push(`     ${w}`);
    }
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
