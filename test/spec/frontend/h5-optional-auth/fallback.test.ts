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
  PROMPT_METHODS,
  QUIET_METHODS,
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

/** Native also declares prompt / login methods, so a "提示" or a login attempt is observable. */
const WITH_PROMPTS: readonly string[] = [...QUIET_METHODS, ...PROMPT_METHODS];

/** Bridge methods H5 called other than app.getEnv and auth.getH5Token (expected none). */
function loudCalls(native: ReturnType<typeof optionalBridge>): string[] {
  return native.bridgeMethods().filter((method) => !QUIET_METHODS.includes(method));
}

it('[AC-F1-01qa-OPT#4] getH5Token 失败（90401 / 90003 超时 / 返回不合法数据）时 optional 请求照常匿名发出、不带 Authorization，响应原样交回，一个请求只向原生要一次令牌', async () => {
  const cases = [
    [PRODUCT, { product_key: 'fx-product', title: 'fx-guest-view' }],
    [EVENTS, { accepted_count: 0, dropped_count: 0 }],
  ] as const;
  for (const failure of TOKEN_FAILURES) {
    for (const [operation, data] of cases) {
      const label = `${failure} ${key(operation)}`;
      // A fresh client per case: whether a later request asks native again is not pinned.
      const native = optionalBridge(() => failure, WITH_PROMPTS);
      const http = httpServer(() => reply(data));
      const api = appApi(native, http);
      const result = await settle(send(api, operation));
      expect(result, label).toEqual({ status: 'fulfilled', value: data });
      expect(http.requests, label).toHaveLength(1);
      expect(http.requests[0]?.method, label).toBe(operation.method);
      expect(http.authorizations(), label).toEqual([null]);
      expect(native.issued(), label).toEqual([]);
      expect(native.tokenCalls(), `${label}: asked native once, no retry loop`).toBe(1);
      // 不提示：no toast, no loading, no login attempt; only app.getEnv and auth.getH5Token.
      expect(loudCalls(native), `${label}: no prompt or login over the bridge`).toEqual([]);
    }
  }
});

it('[AC-F1-01qa-OPT#5] 取令牌失败后匿名发出的 optional 请求，服务端业务错误也原样交回（不吞、不改码、不重发）', async () => {
  for (const failure of TOKEN_FAILURES) {
    const native = optionalBridge(() => failure, WITH_PROMPTS);
    // 30143 ref_expired is one of GET /v1/products/{product_key}'s contract error codes.
    const http = httpServer(() => reply(null, 30143, 422));
    const api = appApi(native, http);
    const result = await settle(send(api, PRODUCT));
    expect(result.status, failure).toBe('rejected');
    const reason = result.status === 'rejected' ? result.reason : null;
    expect(reason, failure).toMatchObject({ code: 30143 });
    expect(http.authorizations(), failure).toEqual([null]);
    expect(native.tokenCalls(), `${failure}: asked native once, no retry loop`).toBe(1);
    expect(loudCalls(native), `${failure}: no prompt or login over the bridge`).toEqual([]);
  }
});

it('[AC-F1-01qa-OPT#15] 原生不支持 auth.getH5Token（调用返回 90001，或桥上根本不声明该方法）：optional 请求照常匿名发出、不带 Authorization、不本地拒绝，桥上只有 app.getEnv / auth.getH5Token 调用', async () => {
  const cases = [
    [PRODUCT, { product_key: 'fx-product', title: 'fx-guest-view' }],
    [EVENTS, { accepted_count: 0, dropped_count: 0 }],
  ] as const;
  // Declared, but native answers 90001 (not supported) to the call.
  for (const [operation, data] of cases) {
    const label = `90001 ${key(operation)}`;
    const native = optionalBridge(() => 'unsupported', WITH_PROMPTS);
    const http = httpServer(() => reply(data));
    const api = appApi(native, http);
    const result = await settle(send(api, operation));
    expect(result, label).toEqual({ status: 'fulfilled', value: data });
    expect(http.authorizations(), label).toEqual([null]);
    expect(native.tokenCalls(), `${label}: asked native once, no retry loop`).toBe(1);
    expect(loudCalls(native), `${label}: no prompt or login over the bridge`).toEqual([]);
  }
  // Not declared at all: has('auth.getH5Token') is null, so native is never asked for a token.
  const undeclared = WITH_PROMPTS.filter((method) => method !== 'auth.getH5Token');
  for (const [operation, data] of cases) {
    const label = `undeclared ${key(operation)}`;
    const native = optionalBridge(() => 'standard', undeclared);
    const http = httpServer(() => reply(data));
    const api = appApi(native, http);
    const result = await settle(send(api, operation));
    expect(result, label).toEqual({ status: 'fulfilled', value: data });
    expect(http.requests, label).toHaveLength(1);
    expect(http.requests[0]?.method, label).toBe(operation.method);
    expect(http.authorizations(), label).toEqual([null]);
    expect(native.tokenCalls(), label).toBe(0);
    expect(native.bridgeMethods(), label).not.toContain('auth.getH5Token');
    expect(loudCalls(native), `${label}: no prompt or login over the bridge`).toEqual([]);
  }
});
