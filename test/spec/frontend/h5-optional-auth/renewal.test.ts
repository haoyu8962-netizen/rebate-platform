// @vitest-environment jsdom
// D10-1745 ②: an optional request sent with the h5_token keeps token.ts's single flight and its
// one renewal plus one replay on 10002. When the renewal fails, that request fails as before and
// is never resent without Authorization.
import { afterEach, expect, it, vi } from 'vitest';
import {
  appApi,
  drain,
  EVENTS,
  expired,
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

const DATA = { product_key: 'fx-product', title: 'fx-member-view' };

it('[AC-F1-01qa-OPT#6] 带令牌的 optional 请求收到 10002：续期成功后用新令牌重放一次，结果交回调用方', async () => {
  for (const operation of [PRODUCT, EVENTS]) {
    const label = key(operation);
    const native = optionalBridge(() => 'standard');
    const http = httpServer((_request, index) => (index === 0 ? expired() : reply(DATA)));
    const api = appApi(native, http);
    const result = await settle(send(api, operation));
    expect(result, label).toEqual({ status: 'fulfilled', value: DATA });
    await drain();
    expect(http.requests, label).toHaveLength(2);
    const bearers = native.bearers('A');
    expect(bearers, label).toHaveLength(2);
    expect(http.authorizations(), label).toEqual(bearers);
    expect(bearers[0], label).not.toBe(bearers[1]);
  }
});

it('[AC-F1-01qa-OPT#7] 带令牌的 optional 请求收到 10002 而续期失败（90401 / 超时 / 不合法数据）：该请求以失败交回，之后线上没有它不带 Authorization 的重发', async () => {
  for (const failure of TOKEN_FAILURES) {
    for (const operation of [PRODUCT, EVENTS]) {
      const label = `${failure} ${key(operation)}`;
      const native = optionalBridge((call) => (call === 1 ? 'standard' : failure));
      // Anything after the first answer would succeed, so an anonymous resend could not hide.
      const http = httpServer((_request, index) => (index === 0 ? expired() : reply(DATA)));
      const api = appApi(native, http);
      const result = await settle(send(api, operation));
      await drain();
      expect(result.status, label).toBe('rejected');
      expect(http.requests, label).toHaveLength(1);
      expect(http.requests[0]?.method, label).toBe(operation.method);
      expect(http.authorizations(), label).toEqual(native.bearers('A'));
      expect(native.issued(), label).toHaveLength(1);
      expect(native.tokenCalls(), label).toBe(2);
    }
  }
});

it('[AC-F1-01qa-OPT#8] 续期后的重放仍是 10002：以 10002 失败交回，不再续取、不降成匿名第三次发送', async () => {
  for (const operation of [PRODUCT, EVENTS]) {
    const label = key(operation);
    const native = optionalBridge(() => 'standard');
    const http = httpServer((_request, index) => (index < 2 ? expired() : reply(DATA)));
    const api = appApi(native, http);
    const result = await settle(send(api, operation));
    await drain();
    expect(result.status, label).toBe('rejected');
    const reason = result.status === 'rejected' ? result.reason : null;
    expect(reason, label).toMatchObject({ code: 10002 });
    expect(http.requests, label).toHaveLength(2);
    expect(http.authorizations(), label).toEqual(native.bearers('A'));
    expect(native.tokenCalls(), label).toBe(2);
  }
});
