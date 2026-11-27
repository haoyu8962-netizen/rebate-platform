// Unit tests of the /v1 CORS hook for the App's H5 pages (B1-01zzz). Pure: a structural stand-in
// for Fastify's addHook / reply, no application, no database, no listener.
import { expect, it } from 'vitest';
import { APP_H5_ALLOW_HEADERS, APP_H5_ALLOW_METHODS, installAppH5Cors } from './app-h5-cors.ts';

const TRUSTED = 'https://webview.example.test:8443';

type Hook = (request: object, reply: object) => Promise<unknown>;

function harness(readOrigins: () => Promise<ReadonlySet<string>>) {
  const hooks: [string, Hook][] = [];
  installAppH5Cors(
    { addHook: (name: string, hook: Hook) => hooks.push([name, hook]) },
    readOrigins,
  );
  async function run(method: string, url: string, headers: Record<string, string> = {}) {
    const set: Record<string, string> = {};
    let status: number | undefined;
    let sent = false;
    const reply = {
      header(name: string, value: string) {
        set[name.toLowerCase()] = value;
        return reply;
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
    const [, hook] = hooks[0] ?? [];
    const result = await hook?.({ method, url, headers }, reply);
    return { headers: set, status, sent, returnedReply: result === reply };
  }
  return { hooks, run };
}

it('[AC-B1-01zzz] one onRequest hook: runs before the preParsing request checks', () => {
  const { hooks } = harness(async () => new Set([TRUSTED]));
  expect(hooks.map(([name]) => name)).toEqual(['onRequest']);
  expect(() => installAppH5Cors({}, async () => new Set())).toThrow(TypeError);
});

it('[AC-B1-01zzz] exact origin match: scheme, host and port, no wildcard, never null', async () => {
  const { run } = harness(async () => new Set([TRUSTED]));
  const granted = await run('GET', '/v1/config', { origin: TRUSTED });
  expect(granted.headers['access-control-allow-origin']).toBe(TRUSTED);
  expect(granted.headers['vary']).toBe('Origin');
  expect(granted.headers['access-control-expose-headers']).toBe('X-Trace-Id');
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
