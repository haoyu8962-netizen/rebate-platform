// @vitest-environment jsdom
// D10-1745 ①: when auth.getH5Token fails (90401, a timeout, a malformed result, or any other
// failure) an optional request is still sent, anonymously, and its response goes back unchanged:
// no local refusal, no thrown error, no waiting, and no loop of token calls for one request.
import { afterEach, expect, it, vi } from 'vitest';
import {
  appApi,
  EVENTS,
  httpServer,
  key,
  optionalBridge,
  PRODUCT,
  releaseAll,
  reply,
  send,
  settle,
  TOKEN_FAILURES,
} from './optional-kit.ts';

afterEach(() => {
  releaseAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-01qa-OPT#4] getH5Token 失败（90401 / 90003 超时 / 返回不合法数据）时 optional 请求照常匿名发出、不带 Authorization，响应原样交回，一个请求只向原生要一次令牌', async () => {
  const cases = [
    [PRODUCT, { product_key: 'fx-product', title: 'fx-guest-view' }],
    [EVENTS, { accepted_count: 0, dropped_count: 0 }],
  ] as const;
  for (const failure of TOKEN_FAILURES) {
    for (const [operation, data] of cases) {
      const label = `${failure} ${key(operation)}`;
      // A fresh client per case: whether a later request asks native again is not pinned.
      const native = optionalBridge(() => failure);
      const http = httpServer(() => reply(data));
      const api = appApi(native, http);
      const result = await settle(send(api, operation));
      expect(result, label).toEqual({ status: 'fulfilled', value: data });
      expect(http.requests, label).toHaveLength(1);
      expect(http.requests[0]?.method, label).toBe(operation.method);
      expect(http.authorizations(), label).toEqual([null]);
      expect(native.issued(), label).toEqual([]);
      expect(native.tokenCalls(), `${label}: asked native once, no retry loop`).toBe(1);
    }
  }
});

it('[AC-F1-01qa-OPT#5] 取令牌失败后匿名发出的 optional 请求，服务端业务错误也原样交回（不吞、不改码、不重发）', async () => {
  for (const failure of TOKEN_FAILURES) {
    const native = optionalBridge(() => failure);
    // 30143 ref_expired is one of GET /v1/products/{product_key}'s contract error codes.
    const http = httpServer(() => reply(null, 30143, 422));
    const api = appApi(native, http);
    const result = await settle(send(api, PRODUCT));
    expect(result.status, failure).toBe('rejected');
    const reason = result.status === 'rejected' ? result.reason : null;
    expect(reason, failure).toMatchObject({ code: 30143 });
    expect(http.authorizations(), failure).toEqual([null]);
    expect(native.tokenCalls(), `${failure}: asked native once, no retry loop`).toBe(1);
  }
});
