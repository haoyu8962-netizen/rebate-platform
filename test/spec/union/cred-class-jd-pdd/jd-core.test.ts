import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { JdUnionAdapter } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import {
  unwrapJdResponse,
  type JdInnerCodeMap,
  type JdWarning,
} from '../../../../apps/api/src/modules/union/infra/jd/response.ts';
import type {
  UnionTransport,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  appKey,
  endpoint,
  expectRedacted,
  innerOk,
  instant,
  keys,
  method,
  requestMarker,
  response,
  secret,
  setup,
  unionFailure,
  wrapped,
} from '../jd-core/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzc#n]) name this task's acceptance points, not business rules.
// D10-1072 / D10-1073（FU-UNION-CRED-CLASS-JD-PDD）：京东内层 403（无接口权限）收紧为 upstream_misconfigured，
// 告警恰好一次 { method, code }；网关 403、外层 code 403 仍是 upstream_rejected。报文与凭据全部合成。

const markers = [
  secret,
  appKey,
  'cc-msg-marker',
  'cc-request-id-marker',
  'cc-inner-data-marker',
  requestMarker,
];
const noise = {
  message: `${secret} ${appKey} cc-msg-marker`,
  requestId: 'cc-request-id-marker',
  data: { rows: ['cc-inner-data-marker'] },
};
const permission: JdWarning = { method, code: '403' };

/** Fails the same way directly and through adapter.request; one transport call; nothing leaks. */
async function bothWays(
  wire: UnionTransportResponse,
  code: UnionErrorCode,
  events: readonly JdWarning[],
  innerCodes?: JdInnerCodeMap,
): Promise<readonly UnionError[]> {
  const warn = vi.fn<(event: JdWarning) => void>();
  const direct = await unionFailure(
    () => unwrapJdResponse(method, keys, wire, warn, innerCodes),
    code,
  );
  expect(warn.mock.calls).toEqual(events.map((event) => [event]));

  const fixture = setup();
  fixture.transport.mockResolvedValue(wire);
  const viaAdapter = await unionFailure(
    () =>
      fixture.adapter.request(
        method,
        { q: requestMarker },
        { ...keys, ...(innerCodes === undefined ? {} : { innerCodes }) },
      ),
    code,
  );
  expect(fixture.transport).toHaveBeenCalledTimes(1);
  expect(fixture.warn.mock.calls).toEqual(events.map((event) => [event]));
  expectRedacted([direct, viaAdapter, warn.mock.calls, fixture.warn.mock.calls], markers);
  return [direct, viaAdapter];
}

/** The inner result with this code, carrying upstream text, a request id and inner data. */
function inner(code: unknown): UnionTransportResponse {
  return wrapped(JSON.stringify({ code, ...noise }));
}

it.each([403, '403'])(
  '[AC-B1-04zzzzc#1] 外层 "0" 下内层 code %j → upstream_misconfigured：unwrapJdResponse 直调与 adapter.request 两路一致、只发 1 次，恰好告警一次 { method, code: "403" }，错误与告警不带 message / requestId / 内层数据 / appKey / secret',
  async (code) => {
    for (const error of await bothWays(inner(code), 'upstream_misconfigured', [permission])) {
      expect(error.platform).toBe('jd');
      expect(error.message).toContain(method);
      expect(error.message).toContain('403');
    }
  },
);

it.each([403, '403'])(
  '[AC-B1-04zzzzc#2] 不注入 warn 回调时内层 %j 仍是 upstream_misconfigured，transport 只调 1 次；网关 28 不注入回调仍是 upstream_rejected',
  async (code) => {
    const cases: readonly (readonly [UnionTransportResponse, UnionErrorCode])[] = [
      [inner(code), 'upstream_misconfigured'],
      [response({ error_response: { code: 28 } }), 'upstream_rejected'],
    ];
    for (const [wire, expected] of cases) {
      await unionFailure(() => unwrapJdResponse(method, keys, wire), expected);
      const transport = vi.fn<UnionTransport>().mockResolvedValue(wire);
      const adapter = new JdUnionAdapter({
        clock: new FixedClock(instant),
        credentials: async () => ({ appKey, appSecret: secret }),
        transport,
        endpoint,
      });
      await unionFailure(() => adapter.request(method, {}, keys), expected);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  },
);

it.each([403, '403'])(
  '[AC-B1-04zzzzc#3] 只有内层 %j 换码：网关 error_response 403、外层 code 403（内层是 200 或 403）仍是 upstream_rejected 不告警，HTTP 503 带内层 403 仍是 upstream_unavailable 不告警',
  async (code) => {
    await bothWays(inner(code), 'upstream_misconfigured', [permission]);

    const gateway = await bothWays(
      response({ error_response: { code, ...noise } }),
      'upstream_rejected',
      [],
    );
    for (const error of gateway) expect(error.message).toContain('403');
    await bothWays(wrapped(innerOk, code), 'upstream_rejected', []);
    await bothWays(wrapped(JSON.stringify({ code, ...noise }), code), 'upstream_rejected', []);
    await bothWays({ ...inner(code), status: 503 }, 'upstream_unavailable', []);
  },
);

/** A per-method table like the goods / convert ones: none of them registers 403. */
const table: JdInnerCodeMap = Object.freeze({
  '2001707': 'item_unavailable',
  '2001701': 'link_unrecognized',
  '201': 'item_unavailable',
  '429': 'item_unavailable',
});

it('[AC-B1-04zzzzc#4] 限流先判：内层 429 仍是 rate_limited 不告警；接口细分表里没有 403，带表时内层 403 照样 upstream_misconfigured 并告警一次，表里的码照表', async () => {
  for (const code of [403, '403'] as const) {
    await bothWays(inner(code), 'upstream_misconfigured', [permission], table);
  }
  for (const code of [429, '429'] as const) {
    await bothWays(inner(code), 'rate_limited', []);
    await bothWays(inner(code), 'rate_limited', [], table);
  }
  await bothWays(inner(2001707), 'item_unavailable', [], table);
  await bothWays(inner('201'), 'item_unavailable', [], table);
  await bothWays(inner(2001702), 'upstream_rejected', [], table);
});

/** Codes whose new meaning is per method (convert / orders); the bare decoder is not asked here. */
const PER_METHOD = new Set([2001403, 2001602, 2002403, 200]);

it('[AC-B1-04zzzzc#5] 性质：外层 "0" 下任一非 200 内层 code、数字或字符串写法：403 → upstream_misconfigured 且恰好告警一次，429 → rate_limited，其余 upstream_rejected 不告警', () => {
  // One collector for every run (no vi.fn per run); emptied at the start of each run.
  const events: JdWarning[] = [];
  const warn = (event: JdWarning): void => {
    events.push(event);
  };
  const run = (value: number, asText: boolean): void => {
    events.length = 0;
    const text = JSON.stringify({ code: asText ? String(value) : value, data: [] });
    let caught: unknown;
    try {
      unwrapJdResponse(method, keys, wrapped(text), warn);
    } catch (error) {
      caught = error;
    }
    let expected: UnionErrorCode = 'upstream_rejected';
    if (value === 429) expected = 'rate_limited';
    if (value === 403) expected = 'upstream_misconfigured';
    expect(caught).toBeInstanceOf(UnionError);
    expect(caught).toMatchObject({ code: expected, platform: 'jd' });
    expect(events).toEqual(value === 403 ? [permission] : []);
  };
  run(403, false);
  run(403, true);
  let checked = 0;
  fc.assert(
    fc.property(
      fc
        .oneof(
          fc.constantFrom(0, 2, 28, 201, 403, 429, 500, 2001707, 2001701),
          fc.integer({ min: -1000, max: 9_999_999 }),
        )
        .filter((value) => !PER_METHOD.has(value)),
      fc.boolean(),
      (value, asText) => {
        run(value, asText);
        checked += 1;
        return true;
      },
    ),
    { numRuns: Math.max(50, Math.floor(propRuns() / 100)), seed: propSeed() },
  );
  expect(checked).toBeGreaterThan(0);
});
