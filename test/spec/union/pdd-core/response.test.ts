import { expect, it, vi } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { unwrapPddResponse } from '../../../../apps/api/src/modules/union/infra/pdd/response.ts';
import { expectRedacted, method, response, secret, setup, unionFailure } from './kit.ts';

const envelopes = [
  ['pdd.ddk.order.list.increment.get', 'order_list_get_response'],
  ['pdd.ddk.order.list.range.get', 'order_list_get_response'],
  ['pdd.ddk.order.detail.get', 'order_detail_response'],
  ['pdd.ddk.member.authority.query', 'authority_query_response'],
  ['pdd.ddk.goods.zs.unit.url.gen', 'goods_zs_unit_generate_response'],
  ['pdd.ddk.rp.prom.url.generate', 'rp_promotion_url_generate_response'],
  ['pdd.ddk.goods.pid.generate', 'p_id_generate_response'],
  ['pdd.ddk.pid.mediaid.bind', 'p_id_bind_response'],
] as const;

it.each(envelopes)(
  '[AC-B1-04g-RESPONSE#1] %s unwraps its explicitly registered %s',
  async (api, key) => {
    const opaque = { synthetic_marker: ['untouched', { value: 0 }] };
    const wire = response({ [key]: opaque, unrelated_response: { wrong: true } });
    expect(unwrapPddResponse(api, wire)).toEqual(opaque);
    const { adapter, transport } = setup();
    transport.mockResolvedValue(wire);
    expect(await adapter.request(api, {})).toEqual(opaque);
  },
);

// test-change 2026-10-15 (pdd-lane): the goods / convert envelopes are registered by B1-04u / B1-04h
// (probe-confirmed keys); names that are never registered stay here.
it.each(['pdd.unknown', 'toString', '__proto__'])(
  '[AC-B1-04g-RESPONSE#2] never infers an envelope for unregistered %s',
  async (api) => {
    await unionFailure(
      () =>
        unwrapPddResponse(
          api,
          response({ goods_search_response: {}, order_list_get_response: {} }),
        ),
      'adapter_unimplemented',
    );
  },
);

it.each([
  '{}',
  'null',
  '[]',
  '"text"',
  '42',
  '<html>upstream failed</html>',
  '{invalid-json',
  '{"order_list_increment_get_response":{}}',
  '{"order_detail_response":{}}',
])(
  '[AC-B1-04g-RESPONSE#3] missing registered envelope or non-JSON %s is unavailable',
  async (body) => {
    await unionFailure(
      () => unwrapPddResponse(method, { status: 200, headers: {}, body }),
      'upstream_unavailable',
    );
  },
);

const classifications: readonly (readonly [number, UnionErrorCode])[] = [
  [70036, 'upstream_rejected'],
  [10019, 'upstream_rejected'],
  [70032, 'upstream_rejected'],
  [70034, 'upstream_rejected'],
  [70035, 'upstream_rejected'],
  [52101, 'rate_limited'],
  [70031, 'rate_limited'],
  [52102, 'upstream_unavailable'],
  [52103, 'upstream_unavailable'],
  [70033, 'upstream_unavailable'],
  [50000, 'upstream_unavailable'],
  [50001, 'upstream_unavailable'],
  [50002, 'upstream_unavailable'],
  [52001, 'upstream_unavailable'],
  [52002, 'upstream_unavailable'],
  [99999, 'upstream_rejected'],
];

it.each(
  classifications.flatMap(([code, expected]) => [
    { code, expected },
    { code: String(code), expected },
  ]),
)(
  '[AC-B1-04g-ERROR#1] error_code=$code maps to $expected for both wire representations',
  async ({ code, expected }) => {
    const warn = vi.fn();
    const error = await unionFailure(
      () =>
        unwrapPddResponse(
          method,
          response({
            error_response: {
              error_code: code,
              sub_code: 'EXAMPLE_SUB_CODE',
              error_msg: secret,
              sub_msg: 'private-sub-message',
              request_id: 'private-request-id',
            },
          }),
          warn,
        ),
      expected,
    );
    expect(error.message).toContain(method);
    expect(error.message).toContain(String(code));
    expect(error.message).toContain('EXAMPLE_SUB_CODE');
    const expectedEvents = [20004, 20005, 70035].includes(Number(code))
      ? [[{ error_code: String(code), type: method }]]
      : [];
    expect(warn.mock.calls).toEqual(expectedEvents);
    expectRedacted([error, warn.mock.calls], [secret, 'private-sub-message', 'private-request-id']);
  },
);

it('[AC-B1-04g-ERROR#2] an unknown textual code defaults to rejected without leaking upstream messages', async () => {
  const error = await unionFailure(
    () =>
      unwrapPddResponse(
        method,
        response({
          error_response: {
            error_code: 'UNKNOWN_VENDOR_CODE',
            error_msg: 'sensitive-request-body',
          },
        }),
      ),
    'upstream_rejected',
  );
  expect(error.message).toContain('UNKNOWN_VENDOR_CODE');
  expectRedacted(error, ['sensitive-request-body']);
});

it('[AC-B1-04g-ERROR#3] error_response takes precedence over a simultaneous success envelope', async () => {
  await unionFailure(
    () =>
      unwrapPddResponse(
        method,
        response({
          error_response: { error_code: 52101 },
          order_list_get_response: {},
        }),
      ),
    'rate_limited',
  );
});

it.each([500, 502, 503, 599])(
  '[AC-B1-04g-ERROR#4] HTTP %s is unavailable regardless of response body',
  async (status) => {
    for (const body of [
      response({ order_list_get_response: {} }, status).body,
      response({ error_response: { error_code: 20031 } }, status).body,
      response({ error_response: { error_code: 52101 } }, status).body,
      '<html>private-upstream-page</html>',
    ]) {
      const error = await unionFailure(
        () => unwrapPddResponse(method, { status, headers: {}, body }),
        'upstream_unavailable',
      );
      expectRedacted(error, ['private-upstream-page']);
    }
  },
);
