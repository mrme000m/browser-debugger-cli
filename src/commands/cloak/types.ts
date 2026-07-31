/**
 * Type definitions aligned with CloakBrowser-Manager (CBM) REST API.
 *
 * Mirrors the Pydantic models from the CBM backend, matching the types
 * used by the cbpm CLI in /home/m/ob/CloakBrowser-Manager/cli/src/types.ts.
 *
 * Shared between bdg and cbpm — both consume the same API.
 */

// ── Tags ──────────────────────────────────────────────────────────────────────

export interface CbmTag {
  tag: string;
  color: string | null;
}

// ── Profile resources (runtime stats) ─────────────────────────────────────────

export interface CbmProfileResources {
  cpu_percent: number | null;
  mem_mb: number | null;
  uptime_s: number | null;
  proc_count: number | null;
}

// ── Profile ───────────────────────────────────────────────────────────────────

export interface CbmProfile {
  id: string;
  name: string;
  fingerprint_seed: number;
  proxy: string | null;
  proxy_credential_id: string | null;
  proxy_credential: unknown;
  proxy_group_id: string | null;
  proxy_group: unknown;
  timezone: string | null;
  locale: string | null;
  platform: string;
  user_agent: string | null;
  screen_width: number;
  screen_height: number;
  gpu_vendor: string | null;
  gpu_renderer: string | null;
  hardware_concurrency: number | null;
  humanize: boolean;
  human_preset: string;
  headless: boolean;
  geoip: boolean;
  clipboard_sync: boolean;
  auto_launch: boolean;
  color_scheme: string | null;
  launch_args: string[];
  notes: string | null;
  is_template: boolean;
  restart_on_crash: boolean;
  max_restarts: number;
  user_data_dir: string;
  created_at: string;
  updated_at: string;
  tags: CbmTag[];
  status: 'running' | 'stopped';
  vnc_ws_port: number | null;
  cdp_url: string | null;
  cdp_endpoint: string | null;
  resources: CbmProfileResources | null;
}

// ── Profile status (runtime detail) ───────────────────────────────────────────

export interface CbmProfileStatus {
  status: string;
  vnc_ws_port: number | null;
  display: string | null;
  cdp_url: string | null;
  cdp_endpoint: string | null;
  cdp_clients: number;
  exit_ip: string | null;
  effective_timezone: string | null;
  effective_locale: string | null;
  resources: CbmProfileResources | null;
}

// ── Launch result ─────────────────────────────────────────────────────────────

export interface CbmLaunchResult {
  profile_id: string;
  status: string;
  vnc_ws_port: number;
  display: string;
  cdp_url: string | null;
  cdp_endpoint: string | null;
}

// ── System status ─────────────────────────────────────────────────────────────

export interface CbmSystemStatus {
  running_count: number;
  binary_version: string;
  profiles_total: number;
  max_running: number | null;
  total_cpu_percent: number | null;
  total_mem_mb: number | null;
  total_proc_count: number | null;
}

// ── Generic responses ─────────────────────────────────────────────────────────

export interface CbmOkResponse {
  ok: boolean;
}

// ── Bulk operations ───────────────────────────────────────────────────────────

export interface CbmBulkResultItem {
  id: string;
  ok: boolean;
  error: string | null;
}

export interface CbmBulkResultResponse {
  results: CbmBulkResultItem[];
}

// ── CDP target (Chrome /json/list endpoint, proxied by CBM) ───────────────────

/**
 * A CDP target entry as returned by Chrome's /json/list endpoint,
 * proxied through the CBM local-CDP endpoint.
 *
 * This is the raw Chrome DevTools Protocol target format.
 */
export interface CbmCdpTarget {
  description: string;
  devtoolsFrontendUrl: string;
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
  faviconUrl?: string;
}

// ── API config ────────────────────────────────────────────────────────────────

/**
 * Resolved API configuration matching ~/.cbpm/config.json.
 */
export interface CbmApiConfig {
  /** Base URL of the CBM API (e.g., http://127.0.0.1:8080). No trailing slash. */
  api_url: string;
  /** Bearer token for authenticated requests (empty string if not set). */
  token: string;
}
