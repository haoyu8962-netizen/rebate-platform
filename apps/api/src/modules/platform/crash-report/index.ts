// Crash reporting of the five backend processes (api / stream / admin / worker / payout) to
// GlitchTip (QA-13d; 01 F-OBS-01, 02 §13 崩溃行, §12.6): @sentry/core plus a minimal Node
// integration of our own (fetch transport, Node stack-line parser, process hooks, start-up,
// beforeSend allowlist). No @sentry/node, no OpenTelemetry takeover, no tracing / replay / profiles.
// CRASH_REPORT_DSN unset → nothing is created and no process hook is installed. payout reports only
// to an internal DSN host.
import { inspect } from 'node:util';
import {
  Scope,
  createStackParser,
  dedupeIntegration,
  getClient,
  getCurrentScope,
  initAndBind,
  linkedErrorsIntegration,
  type Breadcrumb,
  type Event,
  type EventHint,
  type SeverityLevel,
} from '@sentry/core';
import { ServerRuntimeClient, type ServerRuntimeClientOptions } from '@sentry/core/server';
import type { AppConfig } from '../config/index.ts';
import type { EntryName } from '../entries.ts';
import type { RootLogger } from '../logging/index.ts';
import { hookLogger, installProcessHooks, type LogLevelName } from './hooks.ts';
import { scrubEvent, scrubText } from './scrub.ts';
import { nodeStackLineParser } from './stack-parser.ts';
import { makeFetchTransport, envelopeTarget } from './transport.ts';

/** How envelopes are sent: globalThis.fetch in production; tests inject one (never the network). */
export type CrashFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The process whose uncaughtException / unhandledRejection hooks are installed. */
export interface CrashProcess {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  exit(code?: number): unknown;
  /** Where an escaped error is written before the exit, as Node does (the real process's stderr). */
  readonly stderr?: { write(chunk: string): unknown };
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

const CLOSE_TIMEOUT_MS = 2_000;
const MAX_BREADCRUMBS = 50;
const LEVELS = new Set<string>(['fatal', 'error', 'warning', 'log', 'info', 'debug']);

const DISABLED: CrashReporter = Object.freeze({
  enabled: false,
  captureException: () => undefined,
  flush: async () => true,
  close: async () => undefined,
});

/** 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. */
function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a = -1, b = -1] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** payout's rule: a private-range IPv4 address or a host under an operator-given internal suffix. */
export function isInternalHost(host: string, suffixes: readonly string[] = []): boolean {
  const name = host.toLowerCase();
  if (isPrivateIPv4(name)) return true;
  return suffixes.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
}

function hostOf(dsn: string): string {
  try {
    return new URL(dsn).hostname;
  } catch {
    return '';
  }
}

function describeEscaped(error: unknown): string {
  try {
    const text = error instanceof Error ? (error.stack ?? String(error)) : inspect(error);
    return `${text}\n`;
  } catch {
    return 'Uncaught error\n';
  }
}

function firstError(fields: Record<string, unknown>): Error | undefined {
  for (const key of ['err', 'error']) {
    const value = fields[key];
    if (value instanceof Error) return value;
  }
  for (const value of Object.values(fields)) if (value instanceof Error) return value;
  return undefined;
}

/** The scope of one captured error: the caller's context, scrubbed later by beforeSend. */
function scopeOf(entry: EntryName, context: CrashCaptureContext | undefined): Scope {
  const scope = new Scope();
  scope.setTag('entry', entry);
  if (context === undefined) return scope;
  if (context.tags !== undefined) scope.setTags({ ...context.tags });
  if (context.extra !== undefined) scope.setExtras({ ...context.extra });
  for (const [name, value] of Object.entries(context.contexts ?? {})) {
    scope.setContext(name, { ...value });
  }
  const id = context.user?.['id'];
  if (typeof id === 'string' || typeof id === 'number') scope.setUser({ id: String(id) });
  for (const crumb of context.breadcrumbs ?? []) {
    const breadcrumb: Breadcrumb = {};
    if (crumb.type !== undefined) breadcrumb.type = crumb.type;
    if (crumb.category !== undefined) breadcrumb.category = crumb.category;
    if (crumb.level !== undefined && LEVELS.has(crumb.level)) {
      breadcrumb.level = crumb.level as SeverityLevel;
    }
    if (crumb.message !== undefined) breadcrumb.message = crumb.message;
    if (crumb.data !== undefined) breadcrumb.data = { ...crumb.data };
    scope.addBreadcrumb(breadcrumb, MAX_BREADCRUMBS);
  }
  const request = context.request;
  if (request !== undefined) {
    // Only the method and the route template; the concrete URL never leaves (scrub.ts again).
    const route = request.route;
    const status = request.response?.status_code;
    scope.addEventProcessor((event) => {
      event.request = {
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(route === undefined ? {} : { url: route }),
      };
      if (typeof status === 'number') {
        event.contexts = { ...event.contexts, response: { status_code: status } };
      }
      return event;
    });
  }
  return scope;
}

/**
 * Starts crash reporting of one entry, once, at process start (runEntry). Never throws for an
 * unconfigured or refused DSN: it returns a disabled reporter instead.
 */
export async function startCrashReporting(options: CrashReportOptions): Promise<CrashReporter> {
  const { entry, config, logger } = options;
  const settings = config.crashReport;
  if (settings === undefined || settings.dsn === '') return DISABLED;
  const target = envelopeTarget(settings.dsn);
  if (target === undefined) return DISABLED;
  if (entry === 'payout' && !isInternalHost(hostOf(settings.dsn), settings.internalHostSuffixes)) {
    // payout has no public egress (ADR-0001 §4.2 #20); neither the DSN nor its host is logged.
    logger.warn({ entry }, 'crash_report_disabled_public_dsn_host');
    return DISABLED;
  }
  const stackParser = createStackParser(nodeStackLineParser);
  const clientOptions: ServerRuntimeClientOptions = {
    dsn: settings.dsn,
    environment: config.appEnv,
    ...(config.deployVersion === undefined ? {} : { release: config.deployVersion }),
    sendDefaultPii: false,
    sendClientReports: false,
    attachStacktrace: false,
    maxBreadcrumbs: MAX_BREADCRUMBS,
    // No span streaming integration (ServerRuntimeClient adds one otherwise): no tracing at all.
    traceLifecycle: 'static',
    platform: 'node',
    runtime: { name: 'node', version: process.version },
    integrations: [dedupeIntegration(), linkedErrorsIntegration()],
    stackParser,
    transport: makeFetchTransport({
      target,
      fetch: options.fetch ?? globalThis.fetch,
      logger,
    }),
    beforeSend: (event) => scrubEvent(event) as typeof event,
  };
  const client = initAndBind(ServerRuntimeClient, clientOptions);
  let open = true;

  const capture = (error: unknown, hint: EventHint, scope: Scope): string | undefined => {
    if (!open) return undefined;
    try {
      return client.captureException(error, hint, scope);
    } catch {
      return undefined;
    }
  };

  const captureException = (error: unknown, context?: CrashCaptureContext): string | undefined => {
    try {
      const scope = scopeOf(entry, context);
      return capture(error, { mechanism: { type: 'generic', handled: true } }, scope);
    } catch {
      return undefined;
    }
  };

  /** An error line without an Error object: one event marked as that logged error. */
  const captureLogLine = (
    level: LogLevelName,
    message: string,
    fields: Record<string, unknown>,
  ): void => {
    const errorClass = fields['error_class'];
    const stack = fields['stack'];
    const frames = typeof stack === 'string' ? stackParser(stack) : [];
    const scope = scopeOf(entry, { extra: fields });
    scope.setTag('source', 'logger');
    scope.setTag('log_message', message);
    const event: Event = {
      level,
      exception: {
        values: [
          {
            type:
              typeof errorClass === 'string' && /^[A-Za-z_$][\w$.]{0,127}$/.test(errorClass)
                ? errorClass
                : 'LoggedError',
            value: message,
            ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
            mechanism: { type: 'logger', handled: true, synthetic: true },
          },
        ],
      },
    };
    if (open) client.captureEvent(event, {}, scope);
  };

  const removeLoggerHook = hookLogger(logger, (level, args) => {
    if (!open) return;
    const [first, second] = args;
    const message = typeof second === 'string' ? second : typeof first === 'string' ? first : '';
    if (first instanceof Error) {
      const scope = scopeOf(entry, undefined);
      scope.setTag('source', 'logger');
      if (message !== '') scope.setTag('log_message', message);
      scope.setLevel(level);
      capture(first, { mechanism: { type: 'logger', handled: true } }, scope);
      return;
    }
    const fields =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {};
    const error = firstError(fields);
    if (error !== undefined) {
      const scope = scopeOf(entry, { extra: fields });
      scope.setTag('source', 'logger');
      if (message !== '') scope.setTag('log_message', message);
      scope.setLevel(level);
      capture(error, { mechanism: { type: 'logger', handled: true } }, scope);
      return;
    }
    captureLogLine(level, scrubText(message === '' ? 'logged_error' : message), fields);
  });

  const flush = async (timeoutMs: number): Promise<boolean> => {
    try {
      return await client.flush(timeoutMs);
    } catch {
      return false;
    }
  };

  const removeProcessHooks = installProcessHooks({
    process: options.process ?? process,
    report: (error, kind) => {
      const scope = scopeOf(entry, undefined);
      scope.setLevel('fatal');
      capture(error, { mechanism: { type: `auto.node.${kind}`, handled: false } }, scope);
    },
    flush,
    describe: describeEscaped,
  });

  let closing: Promise<void> | undefined;
  const close = (timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> => {
    closing ??= (async () => {
      removeProcessHooks();
      removeLoggerHook();
      try {
        await client.close(timeoutMs);
      } catch {
        // Closing never fails the caller.
      }
      open = false;
      if (getClient() === client) getCurrentScope().setClient(undefined);
    })();
    return closing;
  };

  return {
    enabled: true,
    captureException,
    flush,
    close,
  };
}
