import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { PddCredentials } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import {
  bodyOf,
  endpoint,
  expectRedacted,
  md5,
  method,
  response,
  secret,
  setup,
  unionFailure,
} from './kit.ts';

it('[AC-B1-04g-REQUEST#1] sends flat JSON POST to the injected gateway with the injected signal', async () => {
  const clock = new FixedClock('2016-11-29T08:38:45.999Z');
  const { adapter, transport, credentials, warn } = setup({ clock });
  const signal = new AbortController().signal;
  const parameters = Object.freeze({ page: 1, page_size: 10 });
  const payload = { synthetic_marker: 'opaque-envelope-body' };
  transport.mockResolvedValue(response({ order_list_get_response: payload }));
  expect(await adapter.request(method, parameters, signal)).toEqual(payload);
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = transport.mock.calls[0]![0];
  expect(request).toMatchObject({ platform: 'pdd', url: endpoint.baseUrl, method: 'POST', signal });
  expect(request.signal).toBe(signal);
  expect(new Headers(request.headers).get('content-type')).toMatch(
    /^application\/json(?:;\s*charset=utf-8)?$/i,
  );
  const body = bodyOf(request);
  expect(Object.keys(body).sort()).toEqual([
    'client_id',
    'data_type',
    'page',
    'page_size',
    'sign',
    'timestamp',
    'type',
  ]);
  expect(body).toMatchObject({
    client_id: '1',
    data_type: 'JSON',
    type: method,
    page: 1,
    page_size: 10,
  });
  expect(String(body.timestamp)).toBe('1480408725');
  expect(body.sign).toBe(
    md5(
      `testSecretclient_id1data_typeJSONpage1page_size10timestamp1480408725type${method}testSecret`,
    ),
  );
  expectRedacted(request, [secret]);
  expect(warn).not.toHaveBeenCalled();
  expect(parameters).toEqual({ page: 1, page_size: 10 });
});

it('[AC-B1-04g-REQUEST#2] fetches credentials and seconds anew for each call', async () => {
  const credentials = vi
    .fn<() => Promise<PddCredentials>>()
    .mockResolvedValueOnce({ clientId: 'first-example', clientSecret: secret })
    .mockResolvedValueOnce({ clientId: 'second-example', clientSecret: 'testSecret2' });
  const clock = new FixedClock('2016-11-29T08:38:45.999Z');
  const { adapter, transport } = setup({ clock, credentials });
  await adapter.request(method, {});
  clock.advanceMs(2);
  await adapter.request(method, {});
  expect(credentials).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledTimes(2);
  const first = bodyOf(transport.mock.calls[0]![0]);
  const second = bodyOf(transport.mock.calls[1]![0]);
  expect(String(first.timestamp)).toBe('1480408725');
  expect(String(second.timestamp)).toBe('1480408726');
  expect(first.client_id).toBe('first-example');
  expect(second.client_id).toBe('second-example');
  expect(first.sign).toBe(
    md5(`testSecretclient_idfirst-exampledata_typeJSONtimestamp1480408725type${method}testSecret`),
  );
  expect(second.sign).toBe(
    md5(
      `testSecret2client_idsecond-exampledata_typeJSONtimestamp1480408726type${method}testSecret2`,
    ),
  );
  expectRedacted(transport.mock.calls, [secret, 'testSecret2']);
});

it('[AC-B1-04g-REQUEST#3] awaits the asynchronous provider before sending', async () => {
  const pending = Promise.withResolvers<PddCredentials>();
  const credentials = vi.fn(() => pending.promise);
  const { adapter, transport } = setup({ credentials });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  const result = adapter.request(method, {});
  await Promise.resolve();
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
  pending.resolve({ clientId: '1', clientSecret: secret });
  await expect(result).resolves.toEqual({});
  expect(transport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04g-REQUEST#4] submits structured business parameters as the same compact strings it signs', async () => {
  const { adapter, transport } = setup();
  const parameters = Object.freeze({
    goods_sign_list: Object.freeze(['例子', 'a&b']),
    range_list: Object.freeze({ min: 0, max: 10 }),
  });
  await adapter.request(method, parameters);
  const body = bodyOf(transport.mock.calls[0]![0]);
  expect(body.goods_sign_list).toBe('["例子","a&b"]');
  expect(body.range_list).toBe('{"min":0,"max":10}');
  expect(body.sign).toBe(
    md5(
      `testSecretclient_id1data_typeJSONgoods_sign_list["例子","a&b"]range_list{"min":0,"max":10}timestamp1480408725type${method}testSecret`,
    ),
  );
  expect(parameters).toEqual({ goods_sign_list: ['例子', 'a&b'], range_list: { min: 0, max: 10 } });
});

// test-change 2026-10-15 (pdd-lane): goods.search / detail / recommend.get / promotion.url.generate were
// unregistered only until B1-04u / B1-04h register their probe-confirmed envelopes.
it.each(['pdd.unknown'])(
  '[AC-B1-04g-REQUEST#5] unregistered method %s fails before credentials or transport',
  async (unregistered) => {
    const { adapter, credentials, transport } = setup();
    await unionFailure(() => adapter.request(unregistered, {}), 'adapter_unimplemented');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04g-REQUEST#6] gateway errors use the shared classifier and restricted warning callback', async () => {
  const { adapter, transport, warn } = setup();
  transport.mockResolvedValue(
    response({
      error_response: {
        error_code: 20004,
        sub_code: 'SIGN_INVALID',
        error_msg: secret,
        sub_msg: 'request-body-marker',
        request_id: 'upstream-request-marker',
      },
    }),
  );
  const error = await unionFailure(
    () => adapter.request(method, { page: 1 }),
    'upstream_misconfigured',
  );
  expect(error.message).toContain(method);
  expect(error.message).toContain('20004');
  expect(warn.mock.calls).toEqual([[{ error_code: '20004', type: method }]]);
  expectRedacted(
    [error, warn.mock.calls],
    [secret, 'request-body-marker', 'upstream-request-marker'],
  );
});
