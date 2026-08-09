import type { TelemetryType } from '@/types';

export interface WorkerConfig {
  url: string;
  port: number;
  timeout?: number;
  telemetry?: TelemetryType[];
  includeAll?: boolean;
  userDataDir?: string;
  maxBodySize?: number;
  headless?: boolean;
  chromeWsUrl?: string;
  /** Custom Chrome flags (e.g., ['--ignore-certificate-errors']) */
  chromeFlags?: string[];
  /** Custom HTTP headers for the CDP WebSocket upgrade */
  cdpHeaders?: Record<string, string>;
  /**
   * HTTP endpoint to re-query for the live CDP page-target list, used by the
   * worker to re-resolve the target after a WebSocket drop (e.g. a CBM profile
   * relaunch mints a fresh page-target GUID). When unset, the worker exits on
   * CDP loss (legacy behavior). Auth headers come from cdpHeaders.
   */
  cdpTargetListUrl?: string;
}
