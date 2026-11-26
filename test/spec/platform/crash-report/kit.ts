// Shared helpers of the QA-13d crash reporting rule tests (01 F-OBS-01; 02 §13 崩溃行, §12.6; D10-3242
// / D10-3244). Every report goes through an injected fake fetch (never the network) and every
// process hook through an injected fake process (never the Vitest worker's own process), except
// the child-process tests (exit.test.ts), which run a real `node` process. Expected values are
// written out from the task text, never taken from the implementation.
import { EventEmitter } from 'node:events';
import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import type {
  CrashFetch,
  CrashProcess,
} from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { apiRequire } from '../tracing/kit.ts';

export { tracingFootprint, waitFor } from '../tracing/kit.ts';

export const DSN_VAR = 'CRASH_REPORT_DSN';
export const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
export type Entry = (typeof ENTRIES)[number];

/** The public key of every test DSN: 32 hex digits, distinctive enough to search logs for. */
export const PUBLIC_KEY = 'c0ffee13d0a1b2c3d4e5f60718293a4b';

/** A GlitchTip DSN: `<scheme>://<public key>@<host>/<project id>`. */
export function dsnFor(host: string, scheme: 'http' | 'https' = 'https', project = '3'): string {
  return `${scheme}://${PUBLIC_KEY}@${host}/${project}`;
}

/** An internal GlitchTip (private IPv4, 172.16.0.0/12), as payout may use it. */
export const INTERNAL_DSN = dsnFor('172.20.0.5:8000', 'http');
/** A public host name. */
export const PUBLIC_DSN = dsnFor('glitchtip.example.com');

/** loadConfig with APP_ENV=test plus `env` (the only way crash reporting gets its settings). */
export function configOf(env: Readonly<Record<string, string | undefined>> = {}): AppConfig {
  return loadConfig({ APP_ENV: 'test', ...env });
}

// ---------------------------------------------------------------------------------------------
// Logging.

export interface LogRecord {
  readonly level: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

export const WARN = 40;

/** A root logger at level trace whose JSON lines are kept in `lines`. */
export function memoryLogger(entry: string): {
  logger: RootLogger;
  lines: string[];
  records(): LogRecord[];
} {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry, appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as LogRecord) };
}

// ---------------------------------------------------------------------------------------------
// The envelope endpoint (https://develop.sentry.dev/sdk/overview/#parsing-the-dsn): a DSN
// `<scheme>://<public key>@<host>[/<prefix>]/<project id>` is sent to
// `<scheme>://<host>[/<prefix>]/api/<project id>/envelope/` with POST, authenticated with the DSN's
// public key: `sentry_key=<public key>` in the query string or in the `X-Sentry-Auth` header
// (`Sentry sentry_version=7, sentry_key=<public key>, …`). The old `/api/<project id>/store/`
// endpoint is not it.

/** The envelope endpoint of `dsn`, without query string. */
export function envelopeEndpoint(dsn: string): string {
  const url = new URL(dsn);
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const project = segments.pop() ?? '';
  const prefix = segments.map((segment) => `/${segment}`).join('');
  return `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`;
}

/** `url` without query string and fragment; empty when it is not a URL. */
export function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** The public key of `dsn` (the user part of the DSN URL). */
export function publicKeyOf(dsn: string): string {
  try {
    return decodeURIComponent(new URL(dsn).username);
  } catch {
    return '';
  }
}

/**
 * The public key a request authenticates with: `sentry_key` in the query string, else in the
 * `X-Sentry-Auth` header; undefined when neither carries one.
 */
export function sentKeyOf(url: string, headers: Headers): string | undefined {
  let fromQuery: string | null = null;
  try {
    fromQuery = new URL(url).searchParams.get('sentry_key');
  } catch {
    fromQuery = null;
  }
  if (fromQuery !== null && fromQuery !== '') return fromQuery;
  const header = headers.get('x-sentry-auth') ?? '';
  const fromHeader = /(?:^|[\s,])sentry_key=([^,\s]+)/.exec(header)?.[1];
  return fromHeader === undefined || fromHeader === '' ? undefined : fromHeader;
}

// ---------------------------------------------------------------------------------------------
// The fake fetch of the transport.

/**
 * ok: 200 for an authenticated POST to the envelope endpoint, 401 for one without the public key,
 * 404 for anything else; error: 500; fail: rejects like an unreachable server; throw: throws
 * synchronously; hang: never answers (rejects only when the caller aborts its signal, as fetch
 * does); redirect: answers `redirectStatus` (default 307) to `redirectTo` and then behaves as fetch
 * does with the request's redirect option (follow: a second request to the Location — the same
 * POST for 307 / 308, a GET without body for 303 and for a POST answered 301 / 302; manual: the
 * redirect response itself; error: rejects).
 */
export type FetchMode = 'ok' | 'error' | 'fail' | 'throw' | 'hang' | 'redirect';

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

export interface FakeFetchOptions {
  /**
   * Only a POST to this DSN's envelope endpoint, carrying this DSN's public key, answers 200;
   * without it any /api/<n>/envelope/ carrying PUBLIC_KEY.
   */
  readonly dsn?: string;
  /** Where mode `redirect` points (its Location). */
  readonly redirectTo?: string;
  /** The status of mode `redirect`; 307 when not given. */
  readonly redirectStatus?: RedirectStatus;
}

export interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The decoded (decompressed) body as text. */
  readonly body: Promise<string>;
  /** The request's redirect option (`follow` when not given, as in fetch). */
  readonly redirect: string;
  /** The status answered (401: no or wrong public key); 0 when none was (fail, throw, hang). */
  readonly status: number;
  /** True for the second request fetch itself makes when it follows a redirect. */
  readonly followed: boolean;
}

function decompress(bytes: Buffer, encoding: string): Buffer {
  if (encoding.includes('gzip') || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    return gunzipSync(bytes);
  }
  if (encoding.includes('deflate')) {
    try {
      return inflateSync(bytes);
    } catch {
      return inflateRawSync(bytes);
    }
  }
  return bytes;
}

async function bodyOf(
  input: string | URL | Request,
  init: RequestInit | undefined,
  encoding: string,
): Promise<string> {
  const raw =
    init?.body !== undefined && init.body !== null
      ? await new Response(init.body).arrayBuffer()
      : input instanceof Request
        ? await input.clone().arrayBuffer()
        : new ArrayBuffer(0);
  return decompress(Buffer.from(raw), encoding).toString('utf8');
}

export interface FakeFetch {
  readonly fetch: CrashFetch;
  readonly requests: SentRequest[];
  mode: FetchMode;
}

/**
 * A fetch that records every call (in `requests`, and as `fetch` in `log` when given). It answers
 * 200 only to a POST to the envelope endpoint (of `options.dsn` when given) that carries the DSN's
 * public key (query string `sentry_key` or `X-Sentry-Auth` header): a wrong project id, the old
 * store endpoint or another method gets 404; the right endpoint without the key (or with another
 * key) gets 401.
 */
export function fakeFetch(
  mode: FetchMode = 'ok',
  log?: string[],
  options: FakeFetchOptions = {},
): FakeFetch {
  const state: { mode: FetchMode } = { mode };
  const requests: SentRequest[] = [];
  const expectedKey = options.dsn === undefined ? PUBLIC_KEY : publicKeyOf(options.dsn);
  const isEndpoint = (url: string): boolean => {
    if (options.dsn !== undefined) return endpointOf(url) === envelopeEndpoint(options.dsn);
    return /^https?:\/\/[^/]+(?:\/[^/]+)*\/api\/\d+\/envelope\/$/.test(endpointOf(url));
  };
  const statusFor = (url: string, method: string, headers: Headers): number => {
    if (method.toUpperCase() !== 'POST' || !isEndpoint(url)) return 404;
    return sentKeyOf(url, headers) === expectedKey ? 200 : 401;
  };
  const fetch: CrashFetch = (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    const body = bodyOf(input, init, headers.get('content-encoding') ?? '');
    body.catch(() => undefined);
    const record = (
      to: string,
      status: number,
      followed: boolean,
      sent: { method: string; body: Promise<string> } = { method, body },
    ): void => {
      const sentHeaders = Object.fromEntries(headers.entries());
      requests.push({
        url: to,
        method: sent.method,
        headers: sentHeaders,
        body: sent.body,
        redirect,
        status,
        followed,
      });
      log?.push('fetch');
    };
    if (state.mode === 'throw') {
      record(url, 0, false);
      throw new TypeError('qa13d fake fetch: thrown synchronously');
    }
    if (state.mode === 'fail') {
      record(url, 0, false);
      return Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED (qa13d fake)'));
    }
    if (state.mode === 'hang') {
      record(url, 0, false);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        signal?.addEventListener('abort', () => reject(signal.reason as Error));
      });
    }
    const target = options.redirectTo;
    if (state.mode === 'redirect' && target !== undefined && hostOf(url) !== hostOf(target)) {
      const redirectStatus = options.redirectStatus ?? 307;
      record(url, redirectStatus, false);
      if (redirect === 'error') {
        return Promise.reject(new TypeError('fetch failed: unexpected redirect (qa13d fake)'));
      }
      if (redirect === 'manual') {
        return Promise.resolve(
          new Response(null, { status: redirectStatus, headers: { location: target } }),
        );
      }
      // follow: what fetch does by itself (WHATWG fetch, HTTP-redirect fetch step 12) — 307 / 308
      // repeat the same POST with its body; 303, and 301 / 302 after a POST, send a GET without it.
      const upper = method.toUpperCase();
      const becomesGet =
        ((redirectStatus === 301 || redirectStatus === 302) && upper === 'POST') ||
        (redirectStatus === 303 && upper !== 'GET' && upper !== 'HEAD');
      const sent = becomesGet ? { method: 'GET', body: Promise.resolve('') } : { method, body };
      const followedStatus = statusFor(target, sent.method, headers);
      record(target, followedStatus, true, sent);
      return Promise.resolve(new Response('{}', { status: followedStatus }));
    }
    const status = state.mode === 'error' ? 500 : statusFor(url, method, headers);
    record(url, status, false);
    return Promise.resolve(new Response('{}', { status }));
  };
  return {
    fetch,
    requests,
    get mode() {
      return state.mode;
    },
    set mode(next: FetchMode) {
      state.mode = next;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Envelopes (https://develop.sentry.dev/sdk/data-model/envelopes/): a header line, then item
// header / payload line pairs. Only JSON items are read.

export interface StackFrame {
  readonly filename?: string;
  readonly function?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app?: boolean;
}

export interface SentEvent {
  readonly event_id?: string;
  readonly message?: unknown;
  readonly environment?: string;
  readonly release?: string;
  readonly exception?: {
    readonly values?: readonly {
      readonly type?: string;
      readonly value?: string;
      readonly stacktrace?: { readonly frames?: readonly StackFrame[] };
    }[];
  };
  readonly user?: Readonly<Record<string, unknown>>;
  readonly request?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly contexts?: Readonly<Record<string, unknown>>;
  readonly tags?: Readonly<Record<string, unknown>>;
  readonly breadcrumbs?: unknown;
  readonly [key: string]: unknown;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The JSON items of one envelope body: [item type, payload]. */
export function envelopeItems(body: string): { type: string; payload: unknown }[] {
  const lines = body.split('\n');
  const items: { type: string; payload: unknown }[] = [];
  for (let index = 1; index < lines.length; index += 2) {
    const header = parseJson(lines[index] ?? '') as { type?: unknown } | undefined;
    if (header === undefined || typeof header.type !== 'string') continue;
    items.push({ type: header.type, payload: parseJson(lines[index + 1] ?? '') });
  }
  return items;
}

/** Every event item sent so far, in order. */
export async function sentEvents(requests: readonly SentRequest[]): Promise<SentEvent[]> {
  const events: SentEvent[] = [];
  for (const request of requests) {
    for (const item of envelopeItems(await request.body)) {
      if (item.type === 'event') events.push(item.payload as SentEvent);
    }
  }
  return events;
}

/** Every body sent so far, decoded, joined (what left the process apart from URL and headers). */
export async function sentText(requests: readonly SentRequest[]): Promise<string> {
  return (await Promise.all(requests.map((request) => request.body))).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Process hooks.

export const HOOK_EVENTS = [
  'uncaughtException',
  'unhandledRejection',
  'uncaughtExceptionMonitor',
] as const;

/** A stand-in process: its hooks are ordinary listeners and exit() only records the code. */
export class FakeProcess extends EventEmitter implements CrashProcess {
  readonly exits: number[] = [];
  readonly log: string[];

  constructor(log: string[] = []) {
    super();
    this.log = log;
  }

  exit(code?: number): void {
    this.exits.push(code ?? 0);
    this.log.push(`exit:${String(code)}`);
  }

  hookCount(): number {
    return HOOK_EVENTS.reduce((sum, event) => sum + this.listenerCount(event), 0);
  }
}

/** The real process's listeners on the hook events, per event. */
export function realHookCounts(): Record<string, number> {
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, process.listenerCount(event)]));
}

// ---------------------------------------------------------------------------------------------
// @sentry/core as apps/api has it (the test package does not depend on it). Its client lives on a
// global carrier keyed by the SDK version, so this instance sees the client the code under test
// bound with initAndBind.

interface SentryCore {
  getClient(): { getOptions(): Record<string, unknown> } | undefined;
}

export function sentryClient(): { getOptions(): Record<string, unknown> } | undefined {
  return (apiRequire('@sentry/core') as SentryCore).getClient();
}

// ---------------------------------------------------------------------------------------------
// Outcomes.

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Runs `run` and keeps its value or what it threw / rejected with. */
export async function settle<T>(run: () => T | Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The text of what a settled call threw (for the assertion message), or `returned`. */
export function failureText(outcome: Settled<unknown>): string {
  if (outcome.ok) return 'returned';
  return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
