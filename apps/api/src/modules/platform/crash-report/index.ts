// Crash reporting of the five backend processes (api / stream / admin / worker / payout) to
// GlitchTip (QA-13d; 01 F-OBS-01, 02 §13 崩溃行, §12.6): @sentry/core plus a minimal Node
// integration of our own (fetch transport, Node stack-line parser, process hooks, start-up,
// beforeSend allowlist). No @sentry/node, no OpenTelemetry takeover, no tracing / replay / profiles.
// CRASH_REPORT_DSN unset → nothing is created and no process hook is installed. payout reports only
// to an internal DSN host. Skeleton: every function throws NotImplemented until the implementation.
import type { AppConfig } from '../config/index.ts';
import type { EntryName } from '../entries.ts';
import type { RootLogger } from '../logging/index.ts';

/** How envelopes are sent: globalThis.fetch in production; tests inject one (never the network). */
export type CrashFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The process whose uncaughtException / unhandledRejection hooks are installed. */
export interface CrashProcess {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  exit(code?: number): unknown;
}

/** One breadcrumb handed to captureException; only allowlisted fields may be reported. */
export interface CrashBreadcrumb {
  readonly type?: string;
  readonly category?: string;
  readonly level?: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** What the caller knows about the HTTP request; only method, route template and status may leave. */
export interface CrashRequest {
  readonly method?: string;
  /** The concrete URL, possibly with ids and a query string (never reported as is). */
  readonly url?: string;
  /** The route template, e.g. `/v1/orders/:order_id`. */
  readonly route?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
  readonly query_string?: string;
  readonly data?: unknown;
  readonly response?: {
    readonly status_code?: number;
    readonly body?: unknown;
  };
}

/** Optional context of one captured error (scrubbed by the allowlist before it is sent). */
export interface CrashCaptureContext {
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly contexts?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly tags?: Readonly<Record<string, string>>;
  /** At most a hash of `id` (the user_id) is reported. */
  readonly user?: Readonly<Record<string, unknown>>;
  readonly breadcrumbs?: readonly CrashBreadcrumb[];
  readonly request?: CrashRequest;
}

export interface CrashReportOptions {
  readonly entry: EntryName;
  /** From loadConfig: the DSN is read here, never from process.env. */
  readonly config: AppConfig;
  readonly logger: RootLogger;
  /** The transport's fetch; globalThis.fetch when absent. */
  readonly fetch?: CrashFetch;
  /** Whose hooks are installed; the real process when absent. */
  readonly process?: CrashProcess;
}

export interface CrashReporter {
  /** True only when a client was created (DSN configured; payout: internal DSN host only). */
  readonly enabled: boolean;
  /** Reports one error; never throws and never waits for the transport. Undefined when disabled. */
  captureException(error: unknown, context?: CrashCaptureContext): string | undefined;
  /** Waits at most timeoutMs for pending sends; never rejects. */
  flush(timeoutMs: number): Promise<boolean>;
  /** Flushes (bounded), removes the process hooks and stops reporting; never rejects. */
  close(timeoutMs?: number): Promise<void>;
}

/**
 * Starts crash reporting of one entry, once, at process start (runEntry). Never throws for an
 * unconfigured or refused DSN: it returns a disabled reporter instead.
 */
export function startCrashReporting(options: CrashReportOptions): Promise<CrashReporter> {
  void options;
  throw new Error('NotImplemented: startCrashReporting');
}
