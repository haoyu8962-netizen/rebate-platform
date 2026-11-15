// @vitest-environment jsdom
// D10-1745 ③ through the real shell: the product quote fetched as A (with A's h5_token) is gone
// after auth.changed, and fetching it again carries B's token and yields B's quote only.
import { expect, it } from 'vitest';
import {
  mountShell,
  reply,
  switchBridge,
  switchServer,
} from '../h5-account-switch/switch-helpers.ts';
import { send, PRODUCT } from './optional-kit.ts';

/** The member quote a server gives for the identity the request was sent as. */
function quoteFor(authorization: string | null) {
  const owner = authorization?.match(/^Bearer h5-test-([A-Z])$/)?.[1] ?? 'guest';
  return { product_key: 'fx-product', quote_for: owner };
}

function authorizations(requests: readonly Request[]): (string | null)[] {
  return requests.map((request) => request.headers.get('Authorization'));
}

it('[AC-F1-01qa-OPT#12] 壳层 auth.changed 后 A 身份取到的商品报价不残留：缓存清掉，再取带 B 的令牌、只拿到 B 的报价', async () => {
  const native = switchBridge();
  const http = switchServer((request) => reply(quoteFor(request.headers.get('Authorization'))));
  const { api, client } = await mountShell();
  const queryKey = ['optional-auth-product', 'fx-product'];
  const read = () => client.fetchQuery({ queryKey, queryFn: () => send(api, PRODUCT) });

  const asA = await read();
  expect(asA, 'A gets the quote fetched with A token').toEqual(quoteFor('Bearer h5-test-A'));
  expect(authorizations(http.requests)).toEqual(['Bearer h5-test-A']);

  await native.change();
  expect(client.getQueryData(queryKey), 'no A quote left in the cache').toBeUndefined();

  const asB = await read();
  expect(asB, 'B never gets the A quote').toEqual(quoteFor('Bearer h5-test-B'));
  expect(authorizations(http.requests)).toEqual(['Bearer h5-test-A', 'Bearer h5-test-B']);
  expect(native.tokenCalls()).toBe(2);
});
