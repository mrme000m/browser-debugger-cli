/**
 * `bdg cloak connect` command — the bridge between bdg and CloakBrowser Manager.
 *
 * Connects bdg's existing session machinery to a CBM-managed browser profile:
 * 1. Resolve profile by ID via GET /api/profiles
 * 2. If stopped, POST /api/profiles/:id/launch (Bearer if token set)
 * 3. GET /api/profiles/:id/cdp/local/json/list → pick the page target
 * 4. targetUrl = [url] ?? page.url
 * 5. startSessionViaDaemon(targetUrl, \{ chromeWsUrl: page.webSocketDebuggerUrl \})
 * 6. Print the standard landing page
 *
 * Caveats (documented in command help):
 * - Requires ALLOW_LOCAL_CDP=true on the CBM server + loopback reachability
 *   (bdg's CDP WS client sends no auth headers, relying on the local-CDP bypass;
 *   the tunnel/remote path can't be used for the WS — only REST)
 * - bdg's single-session model means run `bdg stop` first if a session is active
 * - Passing the page's current URL means bdg's unconditional Page.navigate is a
 *   same-URL reload, not a disruptive navigation
 *   (verified: cdpSetup.ts:60-62 navigates even for external Chrome)
 *
 * Mirrors: cbpm profiles connect in CloakBrowser-Manager/cli/src/commands/profiles.ts
 */

import type { Command } from 'commander';

import { cbmGet, cbmPost } from '@/commands/cloak/client.js';
import type { CbmCdpTarget, CbmLaunchResult, CbmProfile } from '@/commands/cloak/types.js';
import { runCommand } from '@/commands/shared/CommandRunner.js';
import { jsonOption } from '@/commands/shared/commonOptions.js';
import type { BaseOptions } from '@/commands/shared/optionTypes.js';
import { startSessionViaDaemon } from '@/commands/shared/startHelpers.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** Connect command options. */
type ConnectOptions = BaseOptions;

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
 * Fetch CDP targets from the profile's local CDP endpoint via the CBM proxy.
 *
 * Uses the local (no-auth) CDP HTTP endpoint at:
 *   GET /api/profiles/:id/cdp/local/json/list
 *
 * Relies on ALLOW_LOCAL_CDP=true on the server so no Bearer token is required
 * for loopback requests to this endpoint.
 */
async function fetchProfileCdpTargets(profileId: string): Promise<CbmCdpTarget[]> {
  const result = await cbmGet<CbmCdpTarget[]>(
    `/api/profiles/${encodeURIComponent(profileId)}/cdp/local/json/list`
  );
  if (!result.success || !result.data) return [];

  const targets = result.data;
  if (!Array.isArray(targets)) return [];
  return targets;
}

/**
 * Find the primary page target from a list of CDP targets.
 *
 * Prefers a real page (not about:blank, chrome://, devtools://).
 * Falls back to any page target, then any target with a webSocketDebuggerUrl.
 */
function findPageTarget(targets: CbmCdpTarget[]): CbmCdpTarget | null {
  if (targets.length === 0) return null;

  // Prefer a page with a real URL
  const realPage = targets.find(
    (t) =>
      t.type === 'page' &&
      t.url &&
      !t.url.startsWith('about:') &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('devtools://')
  );
  if (realPage) return realPage;

  // Fall back to any page target
  const anyPage = targets.find((t) => t.type === 'page');
  if (anyPage) return anyPage;

  // Last resort: first target of any type with a webSocketDebuggerUrl
  return targets.find((t) => !!t.webSocketDebuggerUrl) ?? null;
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
        'Requires ALLOW_LOCAL_CDP=true on the CBM server.'
    )
    .argument('<id>', 'Profile ID or name to connect to')
    .argument('[url]', 'Optional URL to navigate to (defaults to current page URL)')
    .addOption(jsonOption())
    .action(async (id: string, url: string | undefined, options: ConnectOptions) => {
      await runCommand<ConnectOptions, ConnectResult>(
        async () => {
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

          // Step 3: Fetch CDP targets via local CDP proxy
          const targets = await fetchProfileCdpTargets(profile.id);
          if (targets.length === 0) {
            return {
              success: false,
              error: `No CDP targets found for profile '${id}'`,
              exitCode: EXIT_CODES.CDP_CONNECTION_FAILURE,
              errorContext: {
                suggestion:
                  'Ensure ALLOW_LOCAL_CDP=true is set on the CBM server and the profile is running.',
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
          // bdg's cdpSetup.ts:60-62 does an unconditional Page.navigate, so
          // passing the current URL makes it a same-URL reload instead of a
          // disruptive navigation.
          const targetUrl = url ?? pageTarget.url;

          // Step 6: Start session via daemon (reuses bdg's normal session path)
          // startSessionViaDaemon calls process.exit() internally, so we never
          // reach the return below in normal flow.
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
