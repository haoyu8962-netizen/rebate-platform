import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { DataokeClient } from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import {
  unwrapDataokeResponse,
  type DataokeWarning,
} from '../../../../apps/api/src/modules/union/infra/dataoke/response.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  appKey,
  baseUrl,
  expectedSignRan,
  expectRedacted,
  instant,
  nonce,
  ok,
  path,
  randomValue,
  response,
  secret,
  setup,
  timer,
  unionFailure,
  version,
} from './kit.ts';

// 合成、非录制：外层 { time, code, msg, data } 形状、外层错误码分组（gz-13）与 data 内淘宝 TOP
// error_response 透传形状（api-27 示例：code 15、sub_code "2000"）都取自任务书摘录的大淘客公开文档。
// TODO(规划/11 §4.5): 外层键名、成功码与错误码待大淘客实测复录核对 — blocked on 大淘客录制

const signRan = expectedSignRan(appKey, timer, nonce, secret);
/** Text that must never surface in an error or a warning. */
const hidden = [secret, 'msg-marker', 'sub-msg-marker', 'request-id-marker', 'param-marker'];

it('[AC-B1-04m#25] code 0 returns the data object untouched, directly and through the client', async () => {
  const data = { synthetic_marker: ['untouched', { value: 0 }], positionIndex: 'opaque' };
  const wire = ok(data);
  expect(unwrapDataokeResponse(path, wire)).toEqual(data);
  for (const method of ['GET', 'POST'] as const) {
    const { client, transport, warn } = setup();
    transport.mockResolvedValue(wire);
    expect(await client.request(method, path, {}, { version })).toEqual(data);
    expect(warn).not.toHaveBeenCalled();
  }
});

it.each([
  '{}',
  '{"msg":"成功","data":{}}',
  '{"code":null,"data":{}}',
  '{"time":1793375742200,"code":0,"msg":"成功"}',
  '{"code":0,"data":null}',
  '{"code":0,"data":[]}',
  '{"code":0,"data":"text"}',
  '{"code":0,"data":42}',
  '{"code":0,"data":true}',
  '{"code":0,"__proto__":{"data":{}}}',
  'null',
  '[]',
  '"text"',
  '42',
  '',
  '<html>upstream failed</html>',
  '{invalid-json',
])(
  '[AC-B1-04m#26] body %j is upstream_unavailable (not JSON, not an object, no code or no data object)',
  async (body) => {
    const warn = vi.fn<(event: DataokeWarning) => void>();
    await unionFailure(
      () => unwrapDataokeResponse(path, { status: 200, headers: {}, body }, warn),
      'upstream_unavailable',
    );
    expect(warn).not.toHaveBeenCalled();
    const fixture = setup();
    fixture.transport.mockResolvedValue({ status: 200, headers: {}, body });
    await unionFailure(
      () => fixture.client.request('GET', path, {}, { version }),
      'upstream_unavailable',
    );
    expect(fixture.warn).not.toHaveBeenCalled();
  },
);

interface OuterRow {
  readonly code: number | string;
  readonly expected: UnionErrorCode;
  readonly warns: boolean;
}

function group(codes: readonly number[], expected: UnionErrorCode, warns: boolean): OuterRow[] {
  return codes.map((code) => ({ code, expected, warns }));
}

const outerRows: readonly OuterRow[] = [
  // Throttling (gz-13): error-count limit, call limits, frequency, daily / per-minute quota.
  ...group([10064, 10045, 10013, 10014, 10022, 10201, 10202, 10038], 'rate_limited', false),
  // Temporary server-side failures.
  ...group(
    [-1, 500, 503, 10008, 10012, 10019, 10023, 10025, 10053, 10054],
    'upstream_unavailable',
    false,
  ),
  // Everything else (parameters, business, 10071 order fetch failed, 10077 taobao order API error).
  ...group([10071, 10077, 99999], 'upstream_rejected', false),
].flatMap((row) => [row, { ...row, code: String(row.code) }]);

it.each(outerRows)(
  '[AC-B1-04m#27] outer code $code is $expected (warned: $warns) for both wire representations',
  async ({ code, expected, warns }) => {
    const wire = response({ time: 1793375742200, code, msg: `${secret} msg-marker ${appKey}` });
    const expectedEvents: [DataokeWarning][] = warns ? [[{ path, code: String(code) }]] : [];

    const warn = vi.fn<(event: DataokeWarning) => void>();
    const error = await unionFailure(() => unwrapDataokeResponse(path, wire, warn), expected);
    expect(error.message).toContain(path);
    expect(error.message).toContain(String(code));
    expect(warn.mock.calls).toEqual(expectedEvents);
    expectRedacted([error, warn.mock.calls], [...hidden, appKey]);

    const fixture = setup();
    fixture.transport.mockResolvedValue(wire);
    const viaClient = await unionFailure(
      () => fixture.client.request('GET', path, { q: 'param-marker' }, { version }),
      expected,
    );
    expect(viaClient.message).toContain(path);
    expect(viaClient.message).toContain(String(code));
    expect(fixture.transport).toHaveBeenCalledTimes(1);
    expect(fixture.warn.mock.calls).toEqual(expectedEvents);
    expectRedacted([viaClient, fixture.warn.mock.calls], [...hidden, appKey, signRan]);
  },
);

interface TopRow {
  readonly code: number | string;
  readonly sub_code: string;
  readonly expected: UnionErrorCode;
}

const topClassifications: readonly TopRow[] = [
  // code 15: business error (api-27 example: sub_code 2000, bad start or end time) → rejected.
  { code: 15, sub_code: '2000', expected: 'upstream_rejected' },
  // code 7, or a sub_code starting with isp.call-limited → rate limited.
  { code: 7, sub_code: 'synthetic.limit', expected: 'rate_limited' },
  { code: 99999, sub_code: 'isp.call-limited', expected: 'rate_limited' },
  { code: 99999, sub_code: 'isp.call-limited-synthetic', expected: 'rate_limited' },
  // Other codes → rejected.
  { code: 99999, sub_code: 'isv.synthetic-sub-code', expected: 'upstream_rejected' },
  { code: 99999, sub_code: 'synthetic.isp.call-limited', expected: 'upstream_rejected' },
];

const topRows: readonly TopRow[] = topClassifications.flatMap((row) => [
  row,
  { ...row, code: String(row.code) },
]);

it.each(topRows)(
  '[AC-B1-04m#28] a taobao error_response inside data with code=$code sub_code=$sub_code is $expected',
  async ({ code, sub_code, expected }) => {
    const wire = ok({
      error_response: {
        code,
        msg: `${secret} msg-marker`,
        sub_code,
        sub_msg: 'sub-msg-marker 开始时间或结束时间参数非法',
        request_id: 'request-id-marker',
      },
    });
    const expectedEvents: [DataokeWarning][] =
      String(code) === '11' ? [[{ path, code: '11', sub_code }]] : [];

    const warn = vi.fn<(event: DataokeWarning) => void>();
    const error = await unionFailure(() => unwrapDataokeResponse(path, wire, warn), expected);
    expect(error.message).toContain(path);
    expect(error.message).toContain(String(code));
    expect(error.message).toContain(sub_code);
    expect(warn.mock.calls).toEqual(expectedEvents);
    expectRedacted([error, warn.mock.calls], hidden);

    const fixture = setup();
    fixture.transport.mockResolvedValue(wire);
    const viaClient = await unionFailure(
      () => fixture.client.request('GET', path, { q: 'param-marker' }, { version }),
      expected,
    );
    expect(fixture.warn.mock.calls).toEqual(expectedEvents);
    expectRedacted([viaClient, fixture.warn.mock.calls], [...hidden, appKey, signRan]);
  },
);

it('[AC-B1-04m#29] without an injected warn callback, warned codes are still only upstream_rejected', async () => {
  const wires = [
    response({ code: 10021, msg: 'msg-marker' }),
    ok({ error_response: { code: 11, sub_code: 'isv.permission-api-package-limit' } }),
  ];
  for (const wire of wires) {
    await unionFailure(() => unwrapDataokeResponse(path, wire), 'upstream_rejected');
    const transport = vi.fn<UnionTransport>().mockResolvedValue(wire);
    await unionFailure(async () => {
      const client = new DataokeClient({
        baseUrl,
        clock: new FixedClock(instant),
        credentials: async () => ({ appKey, appSecret: secret }),
        random: () => randomValue,
        transport,
      });
      await client.request('GET', path, {}, { version });
    }, 'upstream_rejected');
    expect(transport).toHaveBeenCalledTimes(1);
  }
});

it.each<[string, unknown, UnionErrorCode, [DataokeWarning][]]>([
  [
    'a non-zero outer code over a data object',
    { code: 10013, data: { synthetic: true } },
    'rate_limited',
    [],
  ],
  [
    'a taobao error inside data over other data keys',
    { code: 0, data: { error_response: { code: 7 }, synthetic: true } },
    'rate_limited',
    [],
  ],
])('[AC-B1-04m#30] %s takes precedence', async (_label, body, expected, events) => {
  const warn = vi.fn<(event: DataokeWarning) => void>();
  await unionFailure(() => unwrapDataokeResponse(path, response(body), warn), expected);
  expect(warn.mock.calls).toEqual(events);
  const fixture = setup();
  fixture.transport.mockResolvedValue(response(body));
  await unionFailure(() => fixture.client.request('POST', path, {}, { version }), expected);
  expect(fixture.warn.mock.calls).toEqual(events);
});

it.each([500, 502, 503, 599])(
  '[AC-B1-04m#31] HTTP %s is upstream_unavailable whatever the body says, without a warning',
  async (status) => {
    for (const body of [
      ok({ synthetic: true }).body,
      response({ code: 10021, msg: 'msg-marker' }).body,
      response({ code: 10013 }).body,
      ok({ error_response: { code: 11, sub_code: 'isv.permission-api-package-limit' } }).body,
      '<html>private-upstream-page</html>',
    ]) {
      const warn = vi.fn<(event: DataokeWarning) => void>();
      const error = await unionFailure(
        () => unwrapDataokeResponse(path, { status, headers: {}, body }, warn),
        'upstream_unavailable',
      );
      expect(warn).not.toHaveBeenCalled();
      expectRedacted(error, ['private-upstream-page', 'msg-marker']);

      const fixture = setup();
      fixture.transport.mockResolvedValue({ status, headers: {}, body });
      await unionFailure(
        () => fixture.client.request('GET', path, {}, { version }),
        'upstream_unavailable',
      );
      expect(fixture.warn).not.toHaveBeenCalled();
    }
  },
);
