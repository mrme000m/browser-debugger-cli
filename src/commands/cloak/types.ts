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

// ── Proxy credentials / providers / groups ────────────────────────────────────

export interface CbmProxyCredential {
  id: string;
  name: string;
  scheme: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  proxy_url: string;
  provider_id: string | null;
  provider_location: string | null;
  last_status: string | null;
  last_exit_ip: string | null;
  last_country: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CbmProxyProvider {
  id: string;
  name: string;
  type: string;
  scheme: string;
  host_template: string;
  port: number;
  username: string;
  has_password: boolean;
  options: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CbmProxyGroupMember {
  credential_id: string;
  position: number;
  name: string;
  scheme: string;
  host: string;
  port: number;
  username: string;
  provider_id: string | null;
  provider_location: string | null;
  last_status: string | null;
  last_exit_ip: string | null;
  last_country: string | null;
}

export interface CbmProxyGroup {
  id: string;
  name: string;
  rotation_mode: string;
  member_count: number;
  members: CbmProxyGroupMember[];
  created_at: string;
  updated_at: string;
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
  // ── Organic fingerprint fields ──
  device_memory: number | null;
  brand: string | null;
  brand_version: string | null;
  platform_version: string | null;
  fonts_dir: string | null;
  storage_quota_mb: number | null;
  taskbar_height: number | null;
  geolocation_lat: number | null;
  geolocation_lon: number | null;
  webrtc_ip: string | null;
  noise_enabled: boolean;
  humanize: boolean;
  human_preset: string;
  human_config: Record<string, unknown> | null;
  headless: boolean;
  geoip: boolean;
  clipboard_sync: boolean;
  auto_launch: boolean;
  // ── Session hygiene ──
  clear_on_launch: boolean;
  storage_state: Record<string, unknown> | null;
  permissions: string[] | null;
  device_scale_factor: number | null;
  is_mobile: boolean;
  has_touch: boolean;
  extension_paths: string[] | null;
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
  // ── Coherence ──
  coherence_warnings: string[];
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
  coherence_warnings: string[];
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

// ── Detection report ─────────────────────────────────────────────────────────

export interface CbmDetectionDetail {
  test: string;
  result: string;
}

export interface CbmDetectionReport {
  profile_id: string;
  passed: number;
  failed: number;
  details: CbmDetectionDetail[];
  coherence_warnings: string[];
  error?: string;
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
