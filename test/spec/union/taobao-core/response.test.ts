import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  unwrapTaobaoResponse,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/response.ts';
import { TaobaoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  appKey,
  endpoint,
  envelope,
  expectRedacted,
  instant,
  method,
  response,
  secret,
  setup,
  unionFailure,
} from './kit.ts';

// 合成、非录制：外层键与方法名都是合成值；error_response 的字段形状与 code 11 / 15 / 7 的含义
// 取自任务书（编排探测实测），sub_code 中只有 isv.permission-api-package-limit、50001、26 是实测值。

it('[AC-B1-04j#23] returns the inner object of the caller-given envelope, directly and through the adapter', async () => {
  const inner = { synthetic_marker: ['untouched', { value: 0 }] };
  const wire = response({ [envelope]: inner });
  expect(unwrapTaobaoResponse(method, envelope, wire)).toEqual(inner);
  const { adapter, transport } = setup();
  transport.mockResolvedValue(wire);
  expect(await adapter.request(method, {}, { envelope })).toEqual(inner);
});

it('[AC-B1-04j#24] the envelope key comes from the caller, never from the method name', async () => {
  const other = 'other_synthetic_response';
  const inner = { synthetic_marker: 'other' };
  expect(unwrapTaobaoResponse(method, other, response({ [other]: inner }))).toEqual(inner);
  // A key that looks derived from the method name is not accepted in place of the given one.
  await unionFailure(
    () => unwrapTaobaoResponse(method, other, response({ [envelope]: inner })),
    'upstream_unavailable',
  );
  const { adapter, transport } = setup();
  transport.mockResolvedValue(response({ [envelope]: inner }));
  await unionFailure(
    () => adapter.request(method, {}, { envelope: other }),
    'upstream_unavailable',
  );
});

it.each<[string, string]>([
  [envelope, '{}'],
  [envelope, '{"other_synthetic_response":{}}'],
  [envelope, `{"${envelope}":null}`],
  [envelope, `{"${envelope}":[]}`],
  [envelope, `{"${envelope}":"text"}`],
  [envelope, `{"${envelope}":42}`],
  [envelope, `{"${envelope}":true}`],
  [envelope, 'null'],
  [envelope, '[]'],
  [envelope, '"text"'],
  [envelope, '42'],
  [envelope, ''],
  [envelope, '<html>upstream failed</html>'],
  [envelope, '{invalid-json'],
  ['toString', '{}'],
  ['constructor', '{}'],
  ['__proto__', '{}'],
  ['hasOwnProperty', '{}'],
])(
  '[AC-B1-04j#25] envelope %s with body %s is upstream_unavailable (missing, not an object or not JSON)',
  async (key, body) => {
    await unionFailure(
      () => unwrapTaobaoResponse(method, key, { status: 200, headers: {}, body }),
      'upstream_unavailable',
    );
    const { adapter, transport } = setup();
    transport.mockResolvedValue({ status: 200, headers: {}, body });
    await unionFailure(
      () => adapter.request(method, {}, { envelope: key }),
      'upstream_unavailable',
    );
  },
);

interface Classification {
  readonly code: number | string;
  readonly sub_code: string;
  readonly expected: UnionErrorCode;
}

const classifications: readonly Classification[] = [
  // code 15: business error (probe: 50001 no result, 26 link not recognised) → rejected for now.
  { code: 15, sub_code: '50001', expected: 'upstream_rejected' },
  { code: 15, sub_code: '26', expected: 'upstream_rejected' },
  // code 7, or a sub_code starting with isp.call-limited → rate limited.
  { code: 7, sub_code: 'synthetic.limit', expected: 'rate_limited' },
  { code: 99999, sub_code: 'isp.call-limited', expected: 'rate_limited' },
  { code: 99999, sub_code: 'isp.call-limited-synthetic', expected: 'rate_limited' },
  // Codes outside the table → rejected.
  { code: 99999, sub_code: 'isv.synthetic-sub-code', expected: 'upstream_rejected' },
  { code: 99999, sub_code: 'synthetic.isp.call-limited', expected: 'upstream_rejected' },
];

const rows: readonly Classification[] = [
  ...classifications.flatMap((row) => [row, { ...row, code: String(row.code) }]),
  { code: 'SYNTHETIC_CODE', sub_code: 'isv.synthetic-sub-code', expected: 'upstream_rejected' },
];

it.each(rows)(
  '[AC-B1-04j#26] code=$code sub_code=$sub_code maps to $expected for both wire representations',
  async ({ code, sub_code, expected }) => {
    const wire = response({
      error_response: {
        code,
        msg: `${secret} msg-marker`,
        sub_code,
        sub_msg: 'sub-msg-marker 1001,1002',
        request_id: 'request-id-marker',
      },
    });
    const expectedEvents: [TaobaoWarning][] =
      String(code) === '11' ? [[{ method, code: '11', sub_code }]] : [];

    const warn = vi.fn<(event: TaobaoWarning) => void>();
    const error = await unionFailure(
      () => unwrapTaobaoResponse(method, envelope, wire, warn),
      expected,
    );
    expect(error.message).toContain(method);
    expect(error.message).toContain(String(code));
    expect(error.message).toContain(sub_code);
    expect(warn.mock.calls).toEqual(expectedEvents);
    expectRedacted(
      [error, warn.mock.calls],
      [secret, 'msg-marker', 'sub-msg-marker', 'request-id-marker'],
    );

    const fixture = setup();
    fixture.transport.mockResolvedValue(wire);
    const viaAdapter = await unionFailure(
      () => fixture.adapter.request(method, {}, { envelope }),
      expected,
    );
    expect(fixture.warn.mock.calls).toEqual(expectedEvents);
    expectRedacted(
      [viaAdapter, fixture.warn.mock.calls],
      [secret, 'msg-marker', 'sub-msg-marker', 'request-id-marker'],
    );
  },
);

it('[AC-B1-04j#27] code 11 without an injected warn callback is still only upstream_rejected', async () => {
  await unionFailure(
    () =>
      unwrapTaobaoResponse(
        method,
        envelope,
        response({ error_response: { code: 11, sub_code: 'isv.permission-api-package-limit' } }),
      ),
    'upstream_misconfigured',
  );
  const transport = vi
    .fn<UnionTransport>()
    .mockResolvedValue(
      response({ error_response: { code: '11', sub_code: 'isv.permission-api-package-limit' } }),
    );
  await unionFailure(async () => {
    const adapter = new TaobaoUnionAdapter({
      clock: new FixedClock(instant),
      credentials: async () => ({ appKey, appSecret: secret }),
      transport,
      endpoint,
    });
    await adapter.request(method, {}, { envelope });
  }, 'upstream_misconfigured');
  expect(transport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04j#28] error_response takes precedence over a simultaneous success envelope', async () => {
  const wire = response({ error_response: { code: 7 }, [envelope]: { synthetic: true } });
  await unionFailure(() => unwrapTaobaoResponse(method, envelope, wire), 'rate_limited');
  const { adapter, transport } = setup();
  transport.mockResolvedValue(wire);
  await unionFailure(() => adapter.request(method, {}, { envelope }), 'rate_limited');
});

it.each([500, 502, 503, 599])(
  '[AC-B1-04j#29] HTTP %s is upstream_unavailable whatever the body says, without a warning',
  async (status) => {
    for (const body of [
      response({ [envelope]: {} }).body,
      response({ error_response: { code: 15, sub_code: '50001' } }).body,
      response({ error_response: { code: 7 } }).body,
      response({ error_response: { code: 11, sub_code: 'isv.permission-api-package-limit' } }).body,
      '<html>private-upstream-page</html>',
    ]) {
      const warn = vi.fn<(event: TaobaoWarning) => void>();
      const error = await unionFailure(
        () => unwrapTaobaoResponse(method, envelope, { status, headers: {}, body }, warn),
        'upstream_unavailable',
      );
      expect(warn).not.toHaveBeenCalled();
      expectRedacted(error, ['private-upstream-page']);

      const fixture = setup();
      fixture.transport.mockResolvedValue({ status, headers: {}, body });
      await unionFailure(
        () => fixture.adapter.request(method, {}, { envelope }),
        'upstream_unavailable',
      );
      expect(fixture.warn).not.toHaveBeenCalled();
    }
  },
);
