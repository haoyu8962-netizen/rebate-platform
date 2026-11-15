// @vitest-environment jsdom
// D10-1745 ①: every x-auth optional request H5 sends carries the h5_token native gives (a
// read_only token too); x-auth none never reads a token; signed operations stay refused locally.
import { afterEach, expect, it, vi } from 'vitest';
import { SignedOperationError } from '../../../../apps/h5/src/shared/api/signed.ts';
import {
  appApi,
  deferred,
  drain,
  expectContract,
  httpServer,
  key,
  LINK,
  NONE_OPERATIONS,
  OPTIONAL_OPERATIONS,
  optionalBridge,
  PRODUCT,
  EVENTS,
  releaseAll,
  reply,
  send,
  settle,
  SIGNED_OPERATIONS,
  type Operation,
  type TokenAnswer,
} from './optional-kit.ts';

afterEach(() => {
  releaseAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Each request gets its own data, so a mixed-up response would not compare equal. */
function echo(request: Request): Response {
  return reply({ echo: `${request.method} ${new URL(request.url).pathname}` });
}

it('[AC-F1-01qa-OPT#1] 登录态（standard 令牌）发 H5 直接发的每个 optional 操作都带 Authorization: Bearer 该令牌，响应照常交回', async () => {
  expectContract(OPTIONAL_OPERATIONS, { auth: 'optional', signed: false });
  const native = optionalBridge(() => 'standard');
  const http = httpServer(echo);
  const api = appApi(native, http);
  for (const operation of OPTIONAL_OPERATIONS) {
    const result = await settle(send(api, operation));
    expect(result.status, key(operation)).toBe('fulfilled');
  }
  expect(http.requests.map((request) => request.method)).toEqual(
    OPTIONAL_OPERATIONS.map((operation) => operation.method),
  );
  expect(native.tokenCalls(), 'optional requests ask native').toBeGreaterThan(0);
  const bearers = native.bearers('A');
  expect(bearers.length).toBeGreaterThan(0);
  for (const [index, authorization] of http.authorizations().entries()) {
    expect(bearers, key(OPTIONAL_OPERATIONS[index]!)).toContain(authorization);
  }
});

/** The optional GET of OPTIONAL_OPERATIONS with this path template. */
function optionalGet(path: string): Operation {
  const found = OPTIONAL_OPERATIONS.find((op) => op.method === 'GET' && op.path === path);
  expect(found, path).toBeDefined();
  return found!;
}

it('[AC-F1-01qa-OPT#14] 同一客户端同时发起的多个 optional 请求单飞：整批只调 auth.getH5Token 恰好 1 次、都带同一个令牌；之后同会话顺序再发 optional 请求复用未过期令牌、不再向原生要', async () => {
  const batch = [
    optionalGet('/v1/pages/{page_key}'),
    optionalGet('/v1/pages/{page_key}/sections/{section_id}/items'),
    optionalGet('/v1/rank/hot'),
  ];
  expectContract(batch, { auth: 'optional', signed: false });
  // Native holds its first token answer until every request of the batch has had a chance to ask.
  const first = deferred<TokenAnswer>('standard');
  const native = optionalBridge((call) => (call === 1 ? first.promise : 'standard'));
  const http = httpServer(echo);
  const api = appApi(native, http);
  // Started together; none of them is awaited before the next one starts.
  const pending = Promise.all(batch.map((operation) => settle(send(api, operation))));
  await drain();
  expect(native.tokenCalls(), 'the whole batch shares one auth.getH5Token').toBe(1);
  first.resolve('standard');
  const results = await pending;
  for (const [index, result] of results.entries()) {
    expect(result.status, key(batch[index]!)).toBe('fulfilled');
  }
  expect(native.tokenCalls(), 'still one auth.getH5Token after the batch').toBe(1);
  const issued = native.issued();
  expect(issued).toHaveLength(1);
  const token = `Bearer ${issued[0]!.token}`;
  expect(http.requests).toHaveLength(batch.length);
  const same = batch.map(() => token);
  expect(http.authorizations(), 'one token for the whole batch').toEqual(same);

  // Same session, token not expired: the cached token is reused, native is not asked again.
  expect((await settle(send(api, PRODUCT))).status).toBe('fulfilled');
  expect(http.requests).toHaveLength(batch.length + 1);
  expect(http.authorizations()[batch.length]).toBe(token);
  expect(native.tokenCalls(), 'a later optional request reuses the cached token').toBe(1);
});

it('[AC-F1-01qa-OPT#2] read_only 令牌同样带上（GET 商品详情与 POST /v1/events），由服务端按作用域判', async () => {
  const cases = [
    [PRODUCT, 'GET /v1/products/fx-product'],
    [EVENTS, 'POST /v1/events'],
  ] as const;
  for (const [operation, echoed] of cases) {
    const native = optionalBridge(() => 'read_only');
    const http = httpServer(echo);
    const api = appApi(native, http);
    const result = await settle(send(api, operation));
    expect(result, key(operation)).toEqual({ status: 'fulfilled', value: { echo: echoed } });
    expect(http.requests, key(operation)).toHaveLength(1);
    const authorization = http.authorizations()[0];
    expect(native.issued().every((item) => item.scope === 'read_only')).toBe(true);
    expect(native.bearers('A'), key(operation)).toContain(authorization);
  }
});

it('[AC-F1-01qa-OPT#3] x-auth none 操作不带 Authorization、不为它向原生要令牌；同一会话里 optional 操作照样带令牌', async () => {
  expectContract(NONE_OPERATIONS, { auth: 'none', signed: false });
  const native = optionalBridge(() => 'standard');
  const http = httpServer(echo);
  const api = appApi(native, http);
  for (const operation of NONE_OPERATIONS) {
    expect((await settle(send(api, operation))).status, key(operation)).toBe('fulfilled');
  }
  expect(http.authorizations()).toEqual(NONE_OPERATIONS.map(() => null));
  expect(native.tokenCalls(), 'none operations never ask native for a token').toBe(0);

  expect((await settle(send(api, PRODUCT))).status).toBe('fulfilled');
  expect(http.requests).toHaveLength(NONE_OPERATIONS.length + 1);
  expect(native.bearers('A')).toContain(http.authorizations()[NONE_OPERATIONS.length]);
  const calls = native.tokenCalls();
  expect(calls).toBeGreaterThan(0);

  // A token already in memory does not leak into a none operation either.
  expect((await settle(send(api, NONE_OPERATIONS[0]!))).status).toBe('fulfilled');
  expect(http.requests).toHaveLength(NONE_OPERATIONS.length + 2);
  expect(http.authorizations()[NONE_OPERATIONS.length + 1]).toBeNull();
  expect(native.tokenCalls()).toBe(calls);
});

it('[AC-F1-01qa-OPT#13] 签名操作（解析、打开）登录态下仍本地拒绝 SignedOperationError、线上无请求；同路径的 GET 链接详情照 optional 带令牌发出', async () => {
  expectContract(SIGNED_OPERATIONS, { auth: 'optional', signed: true });
  expectContract([LINK], { auth: 'optional', signed: false });
  const methods = ['app.getEnv', 'auth.getH5Token', 'net.signedRequest'];
  const native = optionalBridge(() => 'standard', methods);
  const http = httpServer(echo);
  const api = appApi(native, http);
  for (const operation of SIGNED_OPERATIONS) {
    const result = await settle(send(api, operation));
    expect(result.status, key(operation)).toBe('rejected');
    const reason = result.status === 'rejected' ? result.reason : null;
    expect(reason, key(operation)).toBeInstanceOf(SignedOperationError);
  }
  expect(http.requests, 'signed operations never reach the wire').toHaveLength(0);

  expect(await settle(send(api, LINK))).toEqual({
    status: 'fulfilled',
    value: { echo: 'GET /v1/links/fx-link' },
  });
  expect(http.requests).toHaveLength(1);
  expect(http.requests[0]?.method).toBe('GET');
  expect(native.bearers('A')).toContain(http.authorizations()[0]);
  expect(native.bridgeMethods()).not.toContain('net.signedRequest');
});
