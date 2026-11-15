import type { BridgeRequest, BridgeResponse, BridgeTransport } from '@couli/bridge-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountChangedError, createAppApi } from './app-api.ts';

// 单元测试：原生边界用假的 __REBATE_BRIDGE__（真实 SDK 令牌管理器），HTTP 用假的 fetch；不联网、不 listen。

const ENV = { apiBaseUrl: 'https://api.fixture.invalid', appId: 'fixture_brand' };
const NATIVE_ENV = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function token(suffix: string) {
  return { token: `h5-unit-${suffix}`, scope: 'standard', expire_at: '2099-01-01T00:00:00Z' };
}

/** 每次 auth.getH5Token 由测试决定何时返回；app.getEnv 也可挂起。 */
function nativeBridge(options: { holdEnv?: boolean } = {}) {
  const tokens: PromiseWithResolvers<unknown>[] = [];
  const env = Promise.withResolvers<unknown>();
  if (options.holdEnv !== true) env.resolve(NATIVE_ENV);
  const postMessage = async (request: BridgeRequest): Promise<BridgeResponse> => {
    if (request.method === 'app.getEnv') {
      return { id: request.id, code: 0, msg: '', data: await env.promise };
    }
    const pending = Promise.withResolvers<unknown>();
    tokens.push(pending);
    return { id: request.id, code: 0, msg: '', data: await pending.promise };
  };
  const transport: BridgeTransport = {
    version: 1,
    methods: ['app.getEnv', 'auth.getH5Token'],
    postMessage,
    subscribe: () => () => undefined,
  };
  vi.stubGlobal('__REBATE_BRIDGE__', transport);
  return { tokens, env };
}

function reply(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 't' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wire(handler: () => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(input instanceof Request ? input : new Request(input, init));
    return handler();
  };
  return { requests, fetch };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

it('logout while the first token acquisition is pending: no second token call and nothing is sent', async () => {
  const native = nativeBridge();
  const http = wire(() => reply({ id: 'me' }));
  const api = createAppApi({ env: ENV, fetch: http.fetch })!;
  const old = api.request('GET', '/v1/me', {}).then(
    () => 'fulfilled',
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(native.tokens).toHaveLength(1));
  api.invalidateToken();
  native.tokens[0]!.resolve(token('A'));
  expect(await old).toBeInstanceOf(AccountChangedError);
  await flush();
  expect(native.tokens).toHaveLength(1);
  expect(http.requests).toHaveLength(0);

  // A request after the switch asks native for a new token and sends only that one.
  const next = api.request('GET', '/v1/me', {});
  await vi.waitFor(() => expect(native.tokens).toHaveLength(2));
  native.tokens[1]!.resolve(token('B'));
  expect(await next).toEqual({ id: 'me' });
  expect(http.requests.map((request) => request.headers.get('Authorization'))).toEqual([
    'Bearer h5-unit-B',
  ]);
});

it('a request still reading app.getEnv when the account changes never asks for a token', async () => {
  const native = nativeBridge({ holdEnv: true });
  const http = wire(() => reply({ id: 'me' }));
  const api = createAppApi({ env: ENV, fetch: http.fetch })!;
  const old = api.request('GET', '/v1/me', {}).then(
    () => 'fulfilled',
    (error: unknown) => error,
  );
  await flush();
  api.invalidateToken();
  native.env.resolve(NATIVE_ENV);
  expect(await old).toBeInstanceOf(AccountChangedError);
  await flush();
  expect(native.tokens).toHaveLength(0);
  expect(http.requests).toHaveLength(0);
});

it('a 10002 answer arriving after the account changed is not renewed or replayed', async () => {
  const native = nativeBridge();
  const response = Promise.withResolvers<Response>();
  const http = wire(() => response.promise);
  const api = createAppApi({ env: ENV, fetch: http.fetch })!;
  const old = api.request('GET', '/v1/me', {}).then(
    () => 'fulfilled',
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(native.tokens).toHaveLength(1));
  native.tokens[0]!.resolve(token('A'));
  await vi.waitFor(() => expect(http.requests).toHaveLength(1));
  api.invalidateToken();
  response.resolve(reply(null, 10002));
  expect(await old).toBeInstanceOf(AccountChangedError);
  await flush();
  expect(native.tokens).toHaveLength(1);
  expect(http.requests).toHaveLength(1);
});

it('x-auth none operations are unaffected by the account change and carry no token', async () => {
  const native = nativeBridge();
  const http = wire(() => reply({ items: [], next_cursor: null }));
  const api = createAppApi({ env: ENV, fetch: http.fetch })!;
  api.invalidateToken();
  await api.request('GET', '/v1/articles', { params: { query: { category: 'help' } } });
  expect(native.tokens).toHaveLength(0);
  expect(http.requests).toHaveLength(1);
  expect(http.requests[0]!.headers.has('Authorization')).toBe(false);
});

it('x-auth optional operations carry the token when native gives one and go anonymously when it fails', async () => {
  const native = nativeBridge();
  const http = wire(() => reply({ items: [] }));
  const api = createAppApi({ env: ENV, fetch: http.fetch })!;
  const signedOut = api.request('GET', '/v1/rank/hot', {
    params: { query: { platform: 'taobao' } },
  });
  await vi.waitFor(() => expect(native.tokens).toHaveLength(1));
  native.tokens[0]!.reject(new Error('native refused'));
  expect(await signedOut).toEqual({ items: [] });
  const signedIn = api.request('GET', '/v1/rank/hot', {
    params: { query: { platform: 'taobao' } },
  });
  await vi.waitFor(() => expect(native.tokens).toHaveLength(2));
  native.tokens[1]!.resolve(token('A'));
  expect(await signedIn).toEqual({ items: [] });
  expect(http.requests.map((request) => request.headers.get('Authorization'))).toEqual([
    null,
    'Bearer h5-unit-A',
  ]);
});
