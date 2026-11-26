// fetch transport of crash reporting (QA-13d ①): createTransport around one POST to the envelope
// endpoint derived from the DSN (`<scheme>://<host>[:<port>][/<prefix>]/api/<project>/envelope/`),
// authenticated with the DSN's public key in the X-Sentry-Auth header (never in the URL). Redirects
// are never followed (payout: no hop may leave the internal network). Each send has a time limit.
// A failed send (unreachable, time-out, non-2xx, a fetch that throws) is swallowed with one warn
// line that carries neither the DSN, its key nor the endpoint; it never reaches the caller.
import {
  createTransport,
  type BaseTransportOptions,
  type Transport,
  type TransportMakeRequestResponse,
  type TransportRequest,
} from '@sentry/core';
import type { RootLogger } from '../logging/logger.ts';

export type TransportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** The longest one envelope POST may take. */
export const SEND_TIMEOUT_MS = 5_000;

const SDK_CLIENT = 'couli-crash-report/1.0';

export interface EnvelopeTarget {
  /** The envelope endpoint, without query string. */
  readonly endpoint: string;
  readonly publicKey: string;
}

/** The endpoint and public key of `dsn`; undefined for anything that is not a DSN. */
export function envelopeTarget(dsn: string): EnvelopeTarget | undefined {
  // Parsed here rather than with makeDsn, which writes a malformed DSN to the console.
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const publicKey = decodeURIComponent(url.username);
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const projectId = segments.pop() ?? '';
  if (publicKey === '' || url.hostname === '' || !/^\d+$/.test(projectId)) return undefined;
  const prefix = segments.map((segment) => `/${segment}`).join('');
  return {
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    publicKey,
  };
}

export interface FetchTransportSettings {
  readonly target: EnvelopeTarget;
  readonly fetch: TransportFetch;
  readonly logger: RootLogger;
  readonly timeoutMs?: number;
}

function rateLimitHeaders(
  response: Response,
): NonNullable<TransportMakeRequestResponse['headers']> {
  return {
    'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
    'retry-after': response.headers.get('retry-after'),
  };
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The executor createTransport calls for one envelope; it never rejects. */
export function envelopeSender(
  settings: FetchTransportSettings,
  extraHeaders: Readonly<Record<string, string>> = {},
): (request: TransportRequest) => Promise<TransportMakeRequestResponse> {
  const { target, logger } = settings;
  const timeoutMs = settings.timeoutMs ?? SEND_TIMEOUT_MS;
  const warn = (fields: Record<string, unknown>): void => {
    try {
      logger.warn(fields, 'crash_report_send_failed');
    } catch {
      // A broken logger must not turn a failed report into a failure of the caller.
    }
  };
  return async (request) => {
    try {
      const response = await settings.fetch(target.endpoint, {
        method: 'POST',
        body: request.body as NonNullable<RequestInit['body']>,
        headers: {
          ...extraHeaders,
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=${SDK_CLIENT}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status >= 300) {
        warn({ status: response.status });
        // Retry-After / X-Sentry-Rate-Limits of a 429 (or any refusal) reach the SDK's rate limiter;
        // a 3xx stays an unfollowed failure.
        return { statusCode: response.status, headers: rateLimitHeaders(response) };
      }
      return { statusCode: response.status, headers: rateLimitHeaders(response) };
    } catch (error) {
      warn({ error_class: errorClass(error) });
      return {};
    }
  };
}

/** The `transport` option of the client: createTransport around envelopeSender. */
export function makeFetchTransport(
  settings: FetchTransportSettings,
): (options: BaseTransportOptions) => Transport {
  return (options) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      // Only the SDK's own user-agent; auth and content headers are set by the sender.
      if (name.toLowerCase() === 'user-agent') headers['user-agent'] = value;
    }
    return createTransport(options, envelopeSender(settings, headers));
  };
}
