// Unit tests of the /v1 CORS hook for the App's H5 pages (B1-01zzz). Pure: a structural stand-in
// for Fastify's addHook / reply, no application, no database, no listener.
import { expect, it } from 'vitest';
import {
  APP_H5_ALLOW_HEADERS,
  APP_H5_ALLOW_METHODS,
  APP_H5_EXPOSE_HEADERS,
  installAppH5Cors,
  mergeVaryOrigin,
} from './app-h5-cors.ts';

const TRUSTED = 'https://webview.example.test:8443';

type Hook = (request: object, reply: object, payload?: unknown) => Promise<unknown>;

function harness(readOrigins: () => Promise<ReadonlySet<string>>) {
  const hooks: [string, Hook][] = [];
  installAppH5Cors(
    { addHook: (name: string, hook: Hook) => hooks.push([name, hook]) },
    readOrigins,
  );
  async function run(
    method: string,
    url: string,
    headers: Record<string, string> = {},
    preset: Record<string, string | string[]> = {},
  ) {
    const set: Record<string, string | string[]> = { ...preset };
    let status: number | undefined;
    let sent = false;
    const reply = {
      header(name: string, value: string) {
        set[name.toLowerCase()] = value;
        return reply;
      },
      getHeader(name: string) {
        return set[name.toLowerCase()];
      },
      code(code: number) {
        status = code;
        return reply;
      },
      send() {
        sent = true;
        return reply;
      },
    };
    const request = { method, url, headers };
    const onRequest = hooks.find(([name]) => name === 'onRequest')?.[1];
    const onSend = hooks.find(([name]) => name === 'onSend')?.[1];
    const result = await onRequest?.(request, reply);
    // Fastify runs onSend for every reply, including one sent from onRequest.
    const payload = await onSend?.(request, reply, 'body');
    return { headers: set, status, sent, returnedReply: result === reply, payload };
  }
  return { hooks, run };
}

it('[AC-B1-01zzz] onRequest before the preParsing checks, onSend for Vary', async () => {
  const { hooks, run } = harness(async () => new Set([TRUSTED]));
  expect(hooks.map(([name]) => name)).toEqual(['onRequest', 'onSend']);
  expect((await run('GET', '/v1/config')).payload).toBe('body');
  expect(() => installAppH5Cors({}, async () => new Set())).toThrow(TypeError);
});

it('[AC-B1-01zzz] exact origin match: scheme, host and port, no wildcard, never null', async () => {
  const { run } = harness(async () => new Set([TRUSTED]));
  const granted = await run('GET', '/v1/config', { origin: TRUSTED });
  expect(granted.headers['access-control-allow-origin']).toBe(TRUSTED);
  expect(granted.headers['vary']).toBe('Origin');
  expect(granted.headers['access-control-expose-headers']).toBe(APP_H5_EXPOSE_HEADERS);
  expect(granted.headers['access-control-allow-credentials']).toBeUndefined();
  expect(granted.sent).toBe(false);
  for (const origin of [
    'http://webview.example.test:8443',
    'https://webview.example.test',
    'https://webview.example.test:443',
    'https://WEBVIEW.example.test:8443',
    'https://webview.example.test:8443/',
    'https://a.webview.example.test:8443',
    'https://webview.example.test:8443.evil.invalid',
    '*',
    'null',
    '',
  ]) {
    const denied = await run('GET', '/v1/config', { origin });
    expect(denied.headers['access-control-allow-origin'], origin).toBeUndefined();
    expect(denied.headers['vary'], origin).toBe('Origin');
  }
});

it('[AC-B1-01zzz] the trusted origins are read on every request with an Origin', async () => {
  let current = new Set([TRUSTED]);
  let reads = 0;
  const { run } = harness(async () => {
    reads += 1;
    return current;
  });
  expect((await run('GET', '/v1/me', {})).headers['vary']).toBe('Origin');
  expect(reads).toBe(0);
  expect((await run('GET', '/v1/me', { origin: TRUSTED })).headers).toHaveProperty(
    'access-control-allow-origin',
    TRUSTED,
  );
  current = new Set(['https://new.example.test']);
  expect(
    (await run('GET', '/v1/me', { origin: TRUSTED })).headers['access-control-allow-origin'],
  ).toBeUndefined();
  expect(
    (await run('GET', '/v1/me', { origin: 'https://new.example.test' })).headers[
      'access-control-allow-origin'
    ],
  ).toBe('https://new.example.test');
  expect(reads).toBe(3);
});

it('[AC-B1-01zzz] a trusted preflight is answered 204 with fixed methods and headers', async () => {
  const { run } = harness(async () => new Set([TRUSTED]));
  const answered = await run('OPTIONS', '/v1/withdrawals', {
    origin: TRUSTED,
    'access-control-request-method': 'TRACE',
    'access-control-request-headers': 'x-unlisted',
  });
  expect(answered.status).toBe(204);
  expect(answered.sent).toBe(true);
  expect(answered.returnedReply).toBe(true);
  expect(answered.headers['access-control-allow-origin']).toBe(TRUSTED);
  expect(answered.headers['access-control-allow-methods']).toBe(APP_H5_ALLOW_METHODS);
  expect(answered.headers['access-control-allow-headers']).toBe(APP_H5_ALLOW_HEADERS);
  expect(APP_H5_ALLOW_METHODS).not.toContain('TRACE');
  expect(APP_H5_ALLOW_HEADERS.toLowerCase()).not.toContain('x-unlisted');
  for (const header of [
    'x-app-id',
    'x-platform',
    'x-app-version',
    'x-build',
    'x-trace-id',
    'authorization',
    'content-type',
    'idempotency-key',
  ]) {
    expect(APP_H5_ALLOW_HEADERS.toLowerCase().split(', ')).toContain(header);
  }
  expect(answered.headers['access-control-allow-credentials']).toBeUndefined();
});

it('[AC-B1-01zzz] untrusted preflight, other paths and a failed read get no grant', async () => {
  const { run } = harness(async () => new Set([TRUSTED]));
  const untrusted = await run('OPTIONS', '/v1/config', {
    origin: 'https://other.example.test',
    'access-control-request-method': 'GET',
  });
  expect(untrusted.sent).toBe(false);
  expect(untrusted.status).toBeUndefined();
  expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();
  for (const url of ['/healthz', '/admin/v1/auth/login', '/v1x/config']) {
    expect((await run('GET', url, { origin: TRUSTED })).headers, url).toEqual({});
  }
  const failing = harness(async () => {
    throw new Error('read failed');
  });
  const failed = await failing.run('OPTIONS', '/v1/config', {
    origin: TRUSTED,
    'access-control-request-method': 'GET',
  });
  expect(failed.sent).toBe(false);
  expect(failed.headers).toEqual({ vary: 'Origin' });
});

it('[AC-B1-01zzz] a trusted actual response exposes X-Trace-Id, ETag and Retry-After', async () => {
  // contracts/openapi.yaml: X-Trace-Id on every response; ETag on getConfig 200 / 304 (ConfigETag);
  // Retry-After on TooManyRequests / NoStoreTooManyRequests (429). Cache-Control is safelisted.
  const exposed = APP_H5_EXPOSE_HEADERS.toLowerCase().split(', ');
  expect(exposed).toEqual(['x-trace-id', 'etag', 'retry-after']);
  const { run } = harness(async () => new Set([TRUSTED]));
  const limited = await run('POST', '/v1/auth/sms', { origin: TRUSTED });
  expect(limited.headers['access-control-expose-headers']).toBe('X-Trace-Id, ETag, Retry-After');
  const preflight = await run('OPTIONS', '/v1/config', {
    origin: TRUSTED,
    'access-control-request-method': 'GET',
  });
  expect(preflight.headers['access-control-expose-headers']).toBeUndefined();
  const untrusted = await run('GET', '/v1/config', { origin: 'https://other.example.test' });
  expect(untrusted.headers['access-control-expose-headers']).toBeUndefined();
});

it('[AC-B1-01zzz] Vary gains Origin in the send stage, merged with what is there', async () => {
  const { run } = harness(async () => new Set([TRUSTED]));
  for (const headers of [{}, { origin: TRUSTED }, { origin: 'https://other.example.test' }]) {
    const merged = await run('GET', '/v1/config', headers, { vary: 'Accept-Encoding' });
    expect(merged.headers['vary']).toBe('Accept-Encoding, Origin');
    const star = await run('GET', '/v1/config', headers, { vary: '*' });
    expect(star.headers['vary']).toBe('*');
    const already = await run('GET', '/v1/config', headers, { vary: 'origin, Accept-Encoding' });
    expect(already.headers['vary']).toBe('origin, Accept-Encoding');
  }
  const preflight = await run(
    'OPTIONS',
    '/v1/config',
    { origin: TRUSTED, 'access-control-request-method': 'GET' },
    { vary: 'Accept-Encoding' },
  );
  expect(preflight.headers['vary']).toBe('Accept-Encoding, Origin');
  expect((await run('GET', '/admin/v1/me', {}, { vary: 'Accept-Encoding' })).headers['vary']).toBe(
    'Accept-Encoding',
  );
});

it('[AC-B1-01zzz] mergeVaryOrigin: case-insensitive, no repeats, * kept', () => {
  expect(mergeVaryOrigin(undefined)).toBe('Origin');
  expect(mergeVaryOrigin('')).toBe('Origin');
  expect(mergeVaryOrigin('Accept-Encoding')).toBe('Accept-Encoding, Origin');
  expect(mergeVaryOrigin('ORIGIN')).toBe('ORIGIN');
  expect(mergeVaryOrigin('Origin, origin,Accept-Encoding , accept-encoding')).toBe(
    'Origin, Accept-Encoding',
  );
  expect(mergeVaryOrigin(['Accept-Encoding', 'Origin'])).toBe('Accept-Encoding, Origin');
  expect(mergeVaryOrigin('Accept-Encoding, *')).toBe('*');
  expect(mergeVaryOrigin('*')).toBe('*');
});
