/**
 * `bdg cloak connect` command — the bridge between bdg and CloakBrowser Manager.
 *
 * Connects bdg's existing session machinery to a CBM-managed browser profile:
 * 1. Resolve profile by ID via GET /api/profiles
 * 2. If stopped, POST /api/profiles/:id/launch (Bearer if token set)
 * 3. GET /api/profiles/:id/cdp[/local]/json/list → pick the page target
 *    (local path when no token; authenticated /cdp path when CBPM_API_TOKEN is set)
 * 4. targetUrl = [url] ?? page.url
 * 5. startSessionViaDaemon(targetUrl, \{ chromeWsUrl, cdpHeaders, cdpTargetListUrl \})
 * 6. Print the standard landing page
 *
 * Reliability: the page-target GUID is per-launch, so a CBM profile relaunch
 * mints a fresh GUID and the webSocketDebuggerUrl resolved here goes stale.
 * `cdpTargetListUrl` (the same /json/list endpoint) is threaded to the worker
 * so it can re-resolve the current page target and reconnect automatically on a
 * WebSocket drop (see src/daemon/lifecycle/recovery.ts). `cdpHeaders` carries
 * the Bearer token for both the initial and recovery list fetches.
 *
 * Caveats (documented in command help):
 * - With CBPM_API_TOKEN set: connects to the authenticated /cdp path and injects
 *   the Bearer header on the CDP WebSocket upgrade, so it works over a remote /
 *   Cloudflare-tunnel host as well as locally.
 * - Without a token: falls back to the loopback /cdp/local path, which requires
 *   ALLOW_LOCAL_CDP=true on the CBM server + loopback reachability.
 * - bdg's single-session model means run `bdg stop` first if a session is active,
 *   or pass --force to stop-and-reconnect in one step.
 * - Passing the page's current URL means bdg's unconditional Page.navigate is a
 *   same-URL reload, not a disruptive navigation
 *   (verified: cdpSetup.ts navigates even for external Chrome)
 *
 * Mirrors: cbpm profiles connect in CloakBrowser-Manager/cli/src/commands/profiles.ts
 */

import type { Command } from 'commander';

import { cbmGet, cbmPost } from '@/commands/cloak/client.js';
import { getCbmApiConfig } from '@/commands/cloak/config.js';
import type { CbmLaunchResult, CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { startSessionViaDaemon } from '@/commands/shared/startHelpers.js';
import { isDaemonRunning, launchDaemon } from '@/daemon/launcher.js';
import { stopSession } from '@/ipc/client.js';
import { delay } from '@/utils/async.js';
import { fetchCdpTargetList, findPageTarget } from '@/utils/cdpTargets.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Connect command options. */
type ConnectOptions = BaseOptions & {
  /** Stop any existing bdg session first, then reconnect with a fresh target. */
  force?: boolean;
};

/** Internal result for connect flow output. */
interface ConnectResult {
  profileId: string;
  profileName: string;
  targetUrl: string;
  pageTitle: string;
}

/**
 * Resolve a profile by ID or name. Fetches all profiles and finds a match.
 */
async function resolveProfile(id: string): Promise<CbmProfile | null> {
  const result = await cbmGet<CbmProfile[]>('/api/profiles');
  if (!result.success || !result.data) return null;
  return result.data.find((p) => p.id === id || p.name === id) ?? null;
}

/**
 * Launch a profile if it is currently stopped.
 * Returns the LaunchResult on success, null on failure.
 */
async function launchIfStopped(profileId: string): Promise<CbmLaunchResult | null> {
  const result = await cbmPost<CbmLaunchResult>(
    `/api/profiles/${encodeURIComponent(profileId)}/launch`
  );
  if (!result.success || !result.data) return null;
  return result.data;
}

/**
 * Stop any existing bdg session and (re)start the daemon for a fresh connect.
 *
 * The `--force` path: `stopSession()` tears down the running worker AND asks the
 * daemon to shut down (its normal stop behavior). The daemon is then relaunched
 * so the connect below has a daemon to talk to. Best-effort: if there was no
 * session/daemon, nothing is stopped and a fresh daemon is started.
 *
 * @throws on a real daemon-launch failure (a "already running" outcome is not an
 *   error — the running daemon is reused).
 */
async function forceReconnectDaemon(): Promise<void> {
  try {
    await stopSession();
  } catch {
    // No session or no daemon — nothing to stop.
  }

  // The daemon shuts itself down after a successful stop; wait for it to exit
  // so the fresh launch below doesn't collide with the dying process/lock.
  for (let i = 0; i < 30 && isDaemonRunning(); i++) {
    await delay(100);
  }
  // Grace period for PID-file / lock cleanup after the process exits.
  await delay(150);

  if (isDaemonRunning()) {
    // It never exited (or came back) — reuse it.
    return;
  }

  try {
    await launchDaemon();
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (code === 'DAEMON_ALREADY_RUNNING') {
      // A daemon is up — reuse it.
      return;
    }
    throw error;
  }
}

/**
 * Format connect result for human-readable output.
 */
function formatConnect(data: ConnectResult): string {
  return [
    '',
    `Connected to CloakBrowser profile: ${data.profileName}`,
    `  Profile ID:  ${data.profileId}`,
    `  Target URL:  ${data.targetUrl}`,
    `  Page Title:  ${data.pageTitle}`,
    '',
    'The bdg daemon is now attached. Use bdg commands (dom, network, console, cdp)',
    'to inspect this browser. Run `bdg stop` when done.',
    '',
  ].join('\n');
}

/**
 * Register the `cloak connect` subcommand.
 */
export function registerCloakConnectCommand(program: Command): void {
  program
    .command('connect')
    .description(
      'Connect bdg to a CloakBrowser-managed profile for inspection. ' +
        'With CBPM_API_TOKEN set, works locally or over a remote/tunnel host; ' +
        'without a token, requires ALLOW_LOCAL_CDP=true + loopback reachability. ' +
        'Auto-recovers if the profile relaunches; use --force to reset first.'
    )
    .argument('<id>', 'Profile ID or name to connect to')
    .argument('[url]', 'Optional URL to navigate to (defaults to current page URL)')
    .addOption(jsonOption())
    .option('--force', 'Stop any existing bdg session first, then reconnect fresh')
    .action(async (id: string, url: string | undefined, options: ConnectOptions) => {
      await runCommand<ConnectOptions, ConnectResult>(
        async () => {
          // Step 0 (optional): --force tears down any existing bdg session and
          // restarts the daemon so this connect starts fresh with a newly
          // resolved target.
          if (options.force) {
            try {
              await forceReconnectDaemon();
            } catch (error) {
              return {
                success: false,
                error: `--force failed to reset the session: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                exitCode: EXIT_CODES.SOFTWARE_ERROR,
              };
            }
          }

          // Step 1: Resolve profile
          const profile = await resolveProfile(id);
          if (!profile) {
            return {
              success: false,
              error: `Profile '${id}' not found`,
              exitCode: EXIT_CODES.RESOURCE_NOT_FOUND,
              errorContext: {
                suggestion: 'List available profiles with: bdg cloak profiles',
              },
            };
          }

          // Step 2: Launch if stopped
          if (profile.status === 'stopped') {
            const launchResult = await launchIfStopped(profile.id);
            if (!launchResult) {
              return {
                success: false,
                error: `Failed to launch profile '${id}'`,
                exitCode: EXIT_CODES.CHROME_LAUNCH_FAILURE,
                errorContext: {
                  suggestion: 'Check CBM server logs for details.',
                },
              };
            }
            // Merge launch result into profile (cdp_endpoint may now be set)
            profile.status = 'running';
            if (launchResult.cdp_endpoint) {
              profile.cdp_endpoint = launchResult.cdp_endpoint;
            }
            if (launchResult.cdp_url) {
              profile.cdp_url = launchResult.cdp_url;
            }
          }

          // Step 3: Fetch CDP targets via the CBM proxy and compute the list URL
          // the worker will re-query to recover from a profile relaunch. With a
          // token, use the authenticated /cdp path (works locally and over a
          // tunnel); without one, fall back to the loopback /cdp/local path.
          const { token, api_url } = getCbmApiConfig();
          const useLocal = !token;
          const cdpListPath = useLocal
            ? `/api/profiles/${encodeURIComponent(profile.id)}/cdp/local/json/list`
            : `/api/profiles/${encodeURIComponent(profile.id)}/cdp/json/list`;
          const cdpTargetListUrl = `${api_url}${cdpListPath}`;
          const cdpHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;

          const targets = await fetchCdpTargetList(cdpTargetListUrl, cdpHeaders);
          if (targets.length === 0) {
            return {
              success: false,
              error: `No CDP targets found for profile '${id}'`,
              exitCode: EXIT_CODES.CDP_CONNECTION_FAILURE,
              errorContext: {
                suggestion: useLocal
                  ? 'Ensure ALLOW_LOCAL_CDP=true is set on the CBM server and the profile is running.'
                  : 'Ensure the profile is running and CBPM_API_TOKEN is valid for the CBM server.',
              },
            };
          }

          // Step 4: Pick the page target
          const pageTarget = findPageTarget(targets);
          if (!pageTarget) {
            return {
              success: false,
              error: `No page target found among ${targets.length} CDP target(s)`,
              exitCode: EXIT_CODES.CDP_CONNECTION_FAILURE,
              errorContext: {
                suggestion: 'Verify the profile has a browser page open.',
              },
            };
          }

          if (!pageTarget.webSocketDebuggerUrl) {
            return {
              success: false,
              error: 'Page target has no webSocketDebuggerUrl',
              exitCode: EXIT_CODES.CDP_CONNECTION_FAILURE,
            };
          }

          // Step 5: Determine target URL
          // Use the provided [url] argument; otherwise use the current page URL.
          // bdg's cdpSetup.ts does an unconditional Page.navigate, so passing the
          // current URL makes it a same-URL reload instead of a disruptive
          // navigation.
          const targetUrl = url ?? pageTarget.url;

          // Step 6: Start session via daemon (reuses bdg's normal session path).
          // cdpTargetListUrl + cdpHeaders are threaded so the worker can
          // re-resolve the page target and reconnect automatically if the profile
          // relaunches (the page-target GUID is per-launch). startSessionViaDaemon
          // calls process.exit() internally, so we never reach the return below.
          await startSessionViaDaemon(
            targetUrl,
            {
              port: 0,
              timeout: undefined,
              userDataDir: undefined,
              includeAll: false,
              maxBodySize: undefined,
              compact: false,
              headless: false,
              chromeWsUrl: pageTarget.webSocketDebuggerUrl,
              // Inject the Bearer token on the CDP WebSocket upgrade so bdg can
              // reach the authenticated /cdp endpoint over a remote/tunnel host.
              cdpHeaders,
              // The /json/list endpoint the worker re-queries to recover.
              cdpTargetListUrl,
              quiet: false,
              chromeFlags: undefined,
            },
            ['dom', 'network', 'console']
          );

          // Not reached (startSessionViaDaemon exits), kept for type completeness
          return {
            success: true,
            data: {
              profileId: profile.id,
              profileName: profile.name,
              targetUrl,
              pageTitle: pageTarget.title || pageTarget.url,
            },
          };
        },
        options,
        formatConnect
      );
    });
}
