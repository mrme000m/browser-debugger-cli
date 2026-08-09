/**
 * Authenticated session commands.
 *
 * Capture, store, list, validate and restore a logged-in browser's cookie set
 * across CloakBrowser profiles (e.g. moving a Google login from one proxy
 * profile to another). Cookies are persisted to ~/.bdg/sessions/<name>.json.
 *
 * - export:   capture current page cookies into a named session file
 * - list:     show saved sessions
 * - validate: check a session's cookies for expiry / auth tokens
 * - import:   inject a saved session into the current browser
 * - delete:   remove a saved session file
 */

import { Option, type Command } from 'commander';

import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { SessionCommandOptions } from '@/commands/shared/optionTypes.js';
import { callCDP, domEval } from '@/ipc/client.js';
import { validateIPCResponse } from '@/ipc/index.js';
import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession,
  sessionHealth,
  type StoredSession,
} from '@/session/authSessions.js';
import { cookiesFromProfile, scanCookieDump, scanProfileDir } from '@/session/cookieDumpScan.js';
import { formatSessionHealth, formatSessionList } from '@/ui/formatters/authSession.js';
import type { Cookie } from '@/ui/formatters/index.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

const AUTH_DOMAIN_HINT = 'google.com, amazon.com, github.com, ...';

/** Commander repeatable-option accumulator. */
function collect(v: string, p: string[]): string[] {
  p.push(v);
  return p;
}

const domainOption = new Option(
  '--domain <domain>',
  `Only keep cookies for these domains (repeatable; e.g. ${AUTH_DOMAIN_HINT})`
)
  .argParser(collect)
  .default([]);

/**
 * Register the `session` command group.
 *
 * @param program - Commander program
 */
export function registerSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('Store and restore authenticated browser sessions (cookie sets)');

  session
    .command('export <name>')
    .description('Capture current page cookies into a saved session')
    .option('--source <src>', 'Source note (e.g. proxy profile id)')
    .option('--force', 'Overwrite an existing session with the same name')
    .addOption(domainOption)
    .addOption(jsonOption())
    .action(async (name: string, options: SessionCommandOptions) => {
      await runCommand(
        async (opts) => {
          const response = await callCDP('Network.getAllCookies', {});
          validateIPCResponse(response);
          const all = (response.data?.result as { cookies?: Cookie[] })?.cookies ?? [];

          const domains = (opts.domain ?? []).map((d) => d.toLowerCase());
          const filtered =
            domains.length > 0
              ? all.filter((c) => domains.some((d) => (c.domain || '').includes(d)))
              : all;

          if (filtered.length === 0) {
            return {
              success: false,
              error: domains.length
                ? `No cookies matched any of: ${domains.join(', ')}`
                : 'No cookies found on the current page',
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: { suggestion: `Try --domain ${AUTH_DOMAIN_HINT}` },
            } as const;
          }

          const file = saveSession(name, filtered, opts.source, opts.force);
          const health = sessionHealth({
            name,
            capturedAt: new Date().toISOString(),
            cookies: filtered,
          } as StoredSession);
          return {
            success: true,
            data: {
              name,
              file,
              captured: filtered.length,
              capturedAt: new Date().toISOString(),
              ...health,
            },
          };
        },
        options,
        (data) =>
          `Saved ${data.captured} cookies as "${name}" -> ${data.file}\n` +
          [
            data.total ? `  ${data.total} cookies total` : '',
            data.hasAuthTokens
              ? '  includes auth tokens (SID/SSID/...) ✓'
              : '  no recognizable auth tokens',
            data.expired > 0 ? `  ${data.expired} expired` : '  none expired',
            `  capture: ${data.capturedAt}`,
          ]
            .filter(Boolean)
            .join('\n')
      );
    });

  session
    .command('list')
    .description('List saved sessions')
    .addOption(jsonOption())
    .action(async (options: SessionCommandOptions) => {
      await runCommand(
        async () => ({ success: true, data: listSessions() }),
        options,
        formatSessionList
      );
    });

  session
    .command('validate <name>')
    .description('Check a saved session for healthy cookies')
    .addOption(jsonOption())
    .action(async (name: string, options: SessionCommandOptions) => {
      await runCommand(
        async () => {
          const stored = loadSession(name);
          const health = sessionHealth(stored);
          return { success: true, data: { name, ...health } };
        },
        options,
        (data) => formatSessionHealth(data.name, data)
      );
    });

  session
    .command('import <name>')
    .description('Inject a saved session into the current browser')
    .option(
      '--url <url>',
      'Navigate to a URL afterwards to confirm the session (e.g. https://mail.google.com)'
    )
    .addOption(jsonOption())
    .action(async (name: string, options: SessionCommandOptions) => {
      await runCommand(
        async (opts) => {
          const stored = loadSession(name);
          const cookies = stored.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path ?? '/',
            ...(c.expires !== undefined && c.expires !== -1 ? { expires: c.expires } : {}),
            ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
            ...(c.secure !== undefined ? { secure: c.secure } : {}),
          }));
          const resp = await callCDP('Network.setCookies', { cookies });
          validateIPCResponse(resp);

          let navigated = false;
          let sessionConfirmed = false;
          if (opts.url) {
            await callCDP('Page.navigate', { url: opts.url });
            navigated = true;
            await new Promise((r) => setTimeout(r, 4000));
            try {
              const titleRes = await domEval('document.title');
              const t = (titleRes as { data?: { result?: string } }).data?.result;
              if (t) sessionConfirmed = t.length > 0;
            } catch {
              /* best-effort title check */
            }
          }
          return {
            success: true,
            data: { imported: cookies.length, navigated, navigateConfirmed: sessionConfirmed },
          };
        },
        options,
        (data) =>
          `Imported ${data.imported} cookies into the browser${data.navigated ? ` and navigated to confirm` : ''}` +
          (data.navigateConfirmed ? ' (title present — likely logged in)' : '')
      );
    });

  session
    .command('scan <dir>')
    .description(
      'Recursively scan a cookie dump folder for profiles holding a full authenticated session'
    )
    .addOption(jsonOption())
    .action(async (dir: string, options: SessionCommandOptions) => {
      await runCommand(
        async () => {
          const profiles = scanCookieDump(dir);
          if (profiles.length === 0) {
            return {
              success: false,
              error: `No profile folders (with Cookies/ or GoogleAccounts/) found under: ${dir}`,
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: { suggestion: 'Pass the root that contains the per-profile folders.' },
            } as const;
          }
          const full = profiles.filter((p) => p.fullSession);
          return {
            success: true,
            data: { dir, total: profiles.length, full: full.length, profiles },
          };
        },
        options,
        (data) => {
          const lines = [`Scanned ${data.total} profiles under ${data.dir}`];
          const full = data.profiles.filter((p) => p.fullSession);
          lines.push(`  ${full.length} with a FULL authenticated session:`);
          full.forEach((p) =>
            lines.push(
              `    ${p.dir}  (${p.authCookies} auth cookies, ${p.totalCookies} total${p.hasGoogleAccounts ? ', account line' : ''})`
            )
          );
          const partial = data.profiles.filter((p) => !p.fullSession);
          if (partial.length)
            lines.push(
              `  ${partial.length} without a full session (${partial.filter((p) => p.totalCookies === 0).length} empty)`
            );
          return lines.join('\n');
        }
      );
    });

  session
    .command('load-from <dir>')
    .description(
      'Inject the first full-session profile found under a directory into the current browser'
    )
    .option('--url <url>', 'Navigate to a URL after injecting to confirm the session')
    .option('--profile <path>', 'Explicit profile folder to load (skip auto-detect)')
    .addOption(jsonOption())
    .action(async (dir: string, options: SessionCommandOptions) => {
      await runCommand(
        async (opts) => {
          const target = opts.profile
            ? scanProfileDir(opts.profile)
            : scanCookieDump(dir).find((p) => p.fullSession);
          if (!target || !target.hasCookiesDir || !target.fullSession) {
            return {
              success: false,
              error: opts.profile
                ? `No profile found at: ${opts.profile}`
                : `No full session found under: ${dir}`,
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: { suggestion: 'Run `bdg session scan <dir>` to list candidates.' },
            } as const;
          }
          const cookies = cookiesFromProfile(target.dir);
          if (cookies.length === 0) {
            return {
              success: false,
              error: `Loaded profile has 0 cookies: ${target.dir}`,
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
            } as const;
          }
          const resp = await callCDP('Network.setCookies', { cookies });
          validateIPCResponse(resp);
          let navigated = false;
          if (opts.url) {
            await callCDP('Page.navigate', { url: opts.url });
            navigated = true;
          }
          return {
            success: true,
            data: {
              profile: target.dir,
              imported: cookies.length,
              authCookies: target.authCookies,
              navigated,
            },
          };
        },
        options,
        (data) =>
          `Loaded ${data.imported} cookies (${data.authCookies} auth) from:\n  ${data.profile}${data.navigated ? '\n  and navigated to confirm.' : ''}`
      );
    });

  session
    .command('delete <name>')
    .description('Delete a saved session file')
    .addOption(jsonOption())
    .action(async (name: string, options: SessionCommandOptions) => {
      await runCommand(
        async () => {
          const file = deleteSession(name);
          return { success: true, data: { name, file, existed: file.length > 0 } };
        },
        options,
        (data) => `Deleted session "${name}"${data.file ? ` -> ${data.file}` : ' (not found)'}`
      );
    });
}
