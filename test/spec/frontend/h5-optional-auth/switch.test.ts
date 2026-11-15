// @vitest-environment jsdom
// D10-1745 ③: after auth.changed (the shell calls invalidateToken()) the old token and whatever
// was fetched as the old identity are dropped: an optional request of the old session that has
// not returned yet never hands its result to the caller, whether it went out with A's token or
// anonymously because no token could be had; the next request asks native again and carries the
// new token, so A's member quote is never shown to B.
import { afterEach, expect, it, vi } from 'vitest';
import {
  appApi,
  deferred,
  drain,
  httpServer,
  optionalBridge,
  PRODUCT,
  releaseAll,
  reply,
  send,
  settle,
  type TokenAnswer,
} from './optional-kit.ts';

afterEach(() => {
  releaseAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const WAIT = { timeout: 1000, interval: 5 };

/** The quote a server would give for the identity the request was sent as. */
function quoteFor(authorization: string | null) {
  const owner = authorization?.match(/^Bearer fx-opt-([A-Z])-/)?.[1] ?? 'guest';
  return { product_key: 'fx-product', quote_for: owner };
}

/** First request held open (released by the test), later ones answered by their identity. */
function heldServer() {
  const first = deferred<Response>(reply(quoteFor(null)));
  const http = httpServer((request, index) => {
    if (index === 0) return first.promise;
    return reply(quoteFor(request.headers.get('Authorization')));
  });
  return { http, first };
}

async function expectNewIdentity(
  native: ReturnType<typeof optionalBridge>,
  http: ReturnType<typeof httpServer>,
  api: ReturnType<typeof appApi>,
) {
  const before = http.requests.length;
  const fresh = await settle(send(api, PRODUCT));
  expect(fresh, 'the new caller gets only B data').toEqual({
    status: 'fulfilled',
    value: quoteFor('Bearer fx-opt-B-'),
  });
  expect(http.requests.length).toBeGreaterThan(before);
  const sent = http.authorizations().slice(before);
  const bearersOfB = native.bearers('B');
  expect(bearersOfB.length, 'native was asked again after the switch').toBeGreaterThan(0);
  for (const authorization of sent) expect(bearersOfB).toContain(authorization);
}

it('[AC-F1-01qa-OPT#9] auth.changed 时带 A 令牌在途的 optional 请求：A 的响应不交回调用方；之后的请求向原生重新要令牌并带 B 的令牌', async () => {
  const native = optionalBridge(() => 'standard');
  const { http, first } = heldServer();
  const api = appApi(native, http);
  const old = settle(send(api, PRODUCT));
  await vi.waitFor(() => expect(http.requests).toHaveLength(1), WAIT);
  expect(native.bearers('A')).toContain(http.authorizations()[0]);

  native.switchTo('B');
  api.invalidateToken();
  first.resolve(reply(quoteFor(http.authorizations()[0] ?? null)));
  const outcome = await old;
  expect(outcome.status, 'the A response is not handed to the old caller').toBe('rejected');

  await expectNewIdentity(native, http, api);
  await drain();
  expect(http.authorizations().slice(1)).not.toContain(native.bearers('A')[0]);
});

it('[AC-F1-01qa-OPT#10] auth.changed 时因取不到令牌而匿名在途的 optional 请求：游客响应不交回调用方；之后的请求带 B 的令牌', async () => {
  const native = optionalBridge((call) => (call === 1 ? 'not-logged-in' : 'standard'));
  const { http, first } = heldServer();
  const api = appApi(native, http);
  const old = settle(send(api, PRODUCT));
  await vi.waitFor(() => expect(http.requests).toHaveLength(1), WAIT);
  expect(native.tokenCalls(), 'the guest request asked native first').toBe(1);
  expect(http.authorizations()).toEqual([null]);

  native.switchTo('B');
  api.invalidateToken();
  first.resolve(reply(quoteFor(null)));
  const outcome = await old;
  expect(outcome.status, 'the guest response is not handed to the old caller').toBe('rejected');

  await expectNewIdentity(native, http, api);
});

it('[AC-F1-01qa-OPT#11] auth.changed 时 A 的取令牌还没回来：晚到的 A 令牌不上线，该请求不交回结果；之后的请求带 B 的令牌', async () => {
  const pending = deferred<TokenAnswer>('standard');
  const native = optionalBridge((call) => (call === 1 ? pending.promise : 'standard'));
  const http = httpServer((request) => reply(quoteFor(request.headers.get('Authorization'))));
  const api = appApi(native, http);
  const old = settle(send(api, PRODUCT));
  await vi.waitFor(() => expect(native.tokenCalls()).toBe(1), WAIT);
  expect(http.requests).toHaveLength(0);

  native.switchTo('B');
  api.invalidateToken();
  pending.resolve('standard');
  const outcome = await old;
  await drain();
  expect(outcome.status, 'the old request hands nothing back').toBe('rejected');
  expect(native.bearers('A'), 'the late token was still A').toHaveLength(1);
  expect(http.authorizations()).not.toContain(native.bearers('A')[0]);

  await expectNewIdentity(native, http, api);
});
