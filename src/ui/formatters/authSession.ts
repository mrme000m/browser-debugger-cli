/**
 * Formatters for saved authenticated-session output.
 */

import { OutputFormatter, pluralize } from '@/ui/formatting.js';

/**
 * Format a saved-session health summary for human output.
 *
 * @param name - Session name
 * @param data - Health summary
 * @returns Formatted string
 */
export function formatSessionHealth(
  name: string,
  data: { total: number; expired: number; expiringSoon: number; hasAuthTokens: boolean }
): string {
  const fmt = new OutputFormatter();
  const expiredParts: string[] = [];
  if (data.expired > 0) expiredParts.push(`${data.expired} expired`);
  if (data.expiringSoon > 0) expiredParts.push(`${data.expiringSoon} expiring within 7d`);
  const expiryNote = expiredParts.length > 0 ? ` (${expiredParts.join(', ')})` : '';
  const authMark = data.hasAuthTokens ? 'authenticated' : 'session cookies only (no auth tokens)';

  fmt
    .text(`Session "${name}": ${data.total} cookies${expiryNote}`)
    .text(`  Status: ${authMark}`)
    .text(
      data.expired > 0
        ? '  ⚠ Expired cookies — import will likely be rejected. Re-capture the session.'
        : '  ✓ None expired'
    );
  return fmt.build();
}

/**
 * Format the list of saved sessions.
 *
 * @param sessions - Session summaries
 * @returns Formatted string
 */
export function formatSessionList(
  sessions: { name: string; capturedAt: string; cookieCount: number }[]
): string {
  const fmt = new OutputFormatter();
  if (sessions.length === 0) {
    return 'No saved sessions. Run `bdg session export <name>` to capture one.';
  }
  fmt.text(pluralize(sessions.length, 'Saved session', 'Saved sessions') + ':').blank();
  sessions.forEach((s) => {
    const when = s.capturedAt ? ` (captured ${s.capturedAt})` : ' (unknown date)';
    fmt.text(`  ${s.name}  —  ${s.cookieCount} cookies${when}`);
  });
  return fmt.build();
}
