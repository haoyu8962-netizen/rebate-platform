// CORS of the api entry's /v1 for the App's H5 pages (B1-01zzz; D10-3534 / D10-3592; 02 §3.4).
// The allowed origins are the environment's trusted H5 origins (content's readAppH5Origins: every
// App's bridge_origins, else its h5_base_url origin), read afresh on every request that carries
// an Origin, so a console change takes effect at once. The contract's app auth is a bearer token
// in Authorization, never a cookie: no Access-Control-Allow-Credentials.
//
// installAppH5Cors(server, readOrigins) adds an `onRequest` hook (it runs for unmatched routes
// too, so a preflight needs no OPTIONS route, and before the request checks' preParsing stage, so
// a response those checks refuse, e.g. 401 without Authorization, keeps the headers) and an
// `onSend` hook, for paths under /v1/:
// - every response's Vary gains `Origin` in the send stage (D10-3608): merged into whatever Vary
//   the response already has, field names compared case-insensitively and not repeated; an
//   existing `Vary: *` stays `*`. Requests without an Origin get only this (D10-3596);
// - when the request's Origin is exactly one of the trusted origins (string equality on the
//   serialized origin: scheme, host and port; no wildcard, no suffix match, never `null`), the
//   response carries Access-Control-Allow-Origin with that origin and exposes the non-safelisted
//   response headers the /v1 contract declares (X-Trace-Id, ETag, Retry-After);
// - a preflight (OPTIONS with Access-Control-Request-Method) from that origin is answered here
//   with 204, the methods the /v1 contract uses and the request headers it declares (fixed lists,
//   never reflected from the request);
// - any other origin, no Origin, or a failed read: no CORS header besides Vary (the origins are
//   not read without an Origin); the request is handled as usual and a preflight falls through
//   to the 404 handler.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no `process.env`, no logging. Fastify is reached through
// the structural types below.

interface CorsRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface CorsReply {
  header(name: string, value: string): unknown;
  getHeader(name: string): unknown;
  code(status: number): CorsReply;
  send(payload?: unknown): unknown;
}

interface CorsServer {
  addHook(
    name: 'onRequest',
    hook: (request: CorsRequest, reply: CorsReply) => Promise<unknown>,
  ): unknown;
  addHook(
    name: 'onSend',
    hook: (request: CorsRequest, reply: CorsReply, payload: unknown) => Promise<unknown>,
  ): unknown;
}

const API_PREFIX = '/v1/';
/** Every method of a /v1 operation in contracts/openapi.yaml. */
export const APP_H5_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE';
/** Every request header a /v1 operation declares in contracts/openapi.yaml, plus its bearer auth. */
export const APP_H5_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'If-None-Match',
  'X-App-Id',
  'X-App-Version',
  'X-Build',
  'X-Channel',
  'X-Device-Id',
  'X-Nonce',
  'X-Platform',
  'X-Sign',
  'X-Step-Up-Token',
  'X-Timestamp',
  'X-Trace-Id',
].join(', ');
/**
 * The response headers a /v1 operation declares in contracts/openapi.yaml that are not
 * CORS-safelisted (Cache-Control is): X-Trace-Id on every response, ETag on getConfig (200 / 304),
 * Retry-After on TooManyRequests / NoStoreTooManyRequests (429).
 */
export const APP_H5_EXPOSE_HEADERS = ['X-Trace-Id', 'ETag', 'Retry-After'].join(', ');
const MAX_AGE_SEC = '600';

/** Vary with `Origin` merged in: existing fields kept once each (case-insensitive), `*` kept. */
export function mergeVaryOrigin(existing: unknown): string {
  const raw = Array.isArray(existing)
    ? existing.join(',')
    : typeof existing === 'string' || typeof existing === 'number'
      ? String(existing)
      : '';
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const field = part.trim();
    if (field === '') continue;
    if (field === '*') return '*';
    const key = field.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push(field);
  }
  if (!seen.has('origin')) fields.push('Origin');
  return fields.join(', ');
}

export function installAppH5Cors(
  server: object,
  readOrigins: () => Promise<ReadonlySet<string>>,
): void {
  const candidate = server as Partial<Record<keyof CorsServer, unknown>>;
  if (typeof candidate.addHook !== 'function') {
    throw new TypeError('installAppH5Cors needs a Fastify instance');
  }
  if (typeof readOrigins !== 'function') {
    throw new TypeError('installAppH5Cors needs an origin reader');
  }
  (server as CorsServer).addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(API_PREFIX)) return undefined;
    const origin = request.headers['origin'];
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return undefined;
    let trusted: boolean;
    try {
      trusted = (await readOrigins()).has(origin);
    } catch {
      // A failed read grants nothing; the request itself is handled as usual.
      trusted = false;
    }
    if (!trusted) return undefined;
    reply.header('Access-Control-Allow-Origin', origin);
    const preflight =
      request.method === 'OPTIONS' &&
      typeof request.headers['access-control-request-method'] === 'string';
    if (!preflight) {
      reply.header('Access-Control-Expose-Headers', APP_H5_EXPOSE_HEADERS);
      return undefined;
    }
    reply.header('Access-Control-Allow-Methods', APP_H5_ALLOW_METHODS);
    reply.header('Access-Control-Allow-Headers', APP_H5_ALLOW_HEADERS);
    reply.header('Access-Control-Max-Age', MAX_AGE_SEC);
    reply.code(204).send();
    return reply;
  });
  // The send stage sees every Vary the handler and earlier hooks wrote, so Origin is appended,
  // never overwriting them (a 204 preflight and the 404 / error replies pass here as well).
  (server as CorsServer).addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith(API_PREFIX)) {
      reply.header('Vary', mergeVaryOrigin(reply.getHeader('vary')));
    }
    return payload;
  });
}
