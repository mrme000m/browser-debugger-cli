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
}
