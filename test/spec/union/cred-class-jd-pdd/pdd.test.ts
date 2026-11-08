import { expect, it, vi } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  unwrapPddResponse,
  type PddWarning,
} from '../../../../apps/api/src/modules/union/infra/pdd/response.ts';
import type { UnionTransportResponse } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { expectRedacted, method, response, secret, setup, unionFailure } from '../pdd-core/kit.ts';
import * as goods from '../pdd-goods/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzc#n]) name this task's acceptance points, not business rules.
// D10-1073（B 档）：拼多多 20031（无接口权限）、20004（签名）、20005（IP 未登记）→ upstream_misconfigured，
// 恰好告警一次 { error_code, type }；HTTP 5xx 照旧 upstream_unavailable；短链展开遇 20031 往上抛新码，
// 不吞成 link_unrecognized；其余分类不变。报文全部合成。

const NEW_CODES = [20031, 20004, 20005] as const;
const forms = NEW_CODES.flatMap((code) => [code, String(code)] as const);
const SUB_MESSAGE = 'cc-pdd-sub-message';
const REQUEST_ID = 'cc-pdd-request-id';
const UPSTREAM = 'cc-pdd-upstream-text';

function failure(code: number | string, subCode: number | string = 'CC_SUB_CODE') {
  return response({
    error_response: {
      error_code: code,
      sub_code: subCode,
      error_msg: `${secret} ${UPSTREAM}`,
      sub_msg: SUB_MESSAGE,
      request_id: REQUEST_ID,
    },
  });
}

/** Same code directly (with and without a warn callback) and through adapter.request. */
async function bothWays(
  wire: UnionTransportResponse,
  code: UnionErrorCode,
  events: readonly PddWarning[],
) {
  const warn = vi.fn<(event: PddWarning) => void>();
  const direct = await unionFailure(() => unwrapPddResponse(method, wire, warn), code);
  expect(warn.mock.calls).toEqual(events.map((event) => [event]));
  await unionFailure(() => unwrapPddResponse(method, wire), code);

  const h = setup();
  h.transport.mockResolvedValue(wire);
  const viaAdapter = await unionFailure(() => h.adapter.request(method, { page: 1 }), code);
  expect(h.transport).toHaveBeenCalledTimes(1);
  expect(h.warn.mock.calls).toEqual(events.map((event) => [event]));
  expectRedacted(
    [direct, viaAdapter, warn.mock.calls, h.warn.mock.calls],
    [secret, UPSTREAM, SUB_MESSAGE, REQUEST_ID],
  );
  return [direct, viaAdapter] as const;
}

it.each(forms)(
  '[AC-B1-04zzzzc#14] 拼多多 error_code=%j → upstream_misconfigured：unwrapPddResponse 直调与 adapter.request 两路一致、只发 1 次，恰好告警一次 { error_code, type }，错误不带 error_msg / sub_msg / request_id',
  async (code) => {
    const errors = await bothWays(failure(code), 'upstream_misconfigured', [
      { error_code: String(code), type: method },
    ]);
    for (const error of errors) {
      expect(error.platform).toBe('pdd');
      expect(error.message).toContain(method);
      expect(error.message).toContain(String(code));
      expect(error.message).toContain('CC_SUB_CODE');
    }
  },
);

it.each([500, 502, 503, 599])(
  '[AC-B1-04zzzzc#15] HTTP %s 带 20031 仍是 upstream_unavailable、不告警；同一报文 HTTP 200 才是 upstream_misconfigured',
  async (status) => {
    const body = failure(20031).body;
    await bothWays({ status: 200, headers: {}, body }, 'upstream_misconfigured', [
      { error_code: '20031', type: method },
    ]);
    await bothWays({ status, headers: {}, body }, 'upstream_unavailable', []);
  },
);

it('[AC-B1-04zzzzc#16] 其余分类不变：70032 / 70034 / 70035 / 70036 / 10019 / 99999 → upstream_rejected（70035 仍告警一次）；52101 / 70031 → rate_limited；52102 → upstream_unavailable；50001 / sub_code 60001 → upstream_rejected', async () => {
  await bothWays(failure(20031), 'upstream_misconfigured', [{ error_code: '20031', type: method }]);

  const unchanged: readonly (readonly [number, UnionErrorCode])[] = [
    [70032, 'upstream_rejected'],
    [70034, 'upstream_rejected'],
    [70035, 'upstream_rejected'],
    [70036, 'upstream_rejected'],
    [10019, 'upstream_rejected'],
    [99999, 'upstream_rejected'],
    [52101, 'rate_limited'],
    [70031, 'rate_limited'],
    [52102, 'upstream_unavailable'],
  ];
  for (const [code, expected] of unchanged) {
    for (const wireCode of [code, String(code)]) {
      const events = code === 70035 ? [{ error_code: '70035', type: method }] : [];
      await bothWays(failure(wireCode), expected, events);
    }
  }
  for (const [code, sub] of [
    [50001, 60001],
    ['50001', '60001'],
  ] as const) {
    await bothWays(failure(code, sub), 'upstream_rejected', []);
  }
});

const shortForms = [20031, '20031'] as const;

it.each(shortForms)(
  '[AC-B1-04zzzzc#17] resolveLink：url.short.parse 报 %j → upstream_misconfigured 往上抛，不吞成 link_unrecognized、不再搜索，告警一次 { error_code: "20031", type: url.short.parse }；短链展开被 70032 拒绝仍是 link_unrecognized',
  async (code) => {
    const refused = (errorCode: number | string) =>
      goods.setup((body) =>
        body.type === goods.shortParse
          ? { error_response: { error_code: errorCode, error_msg: UPSTREAM } }
          : goods.envelope(body.type, []),
      );

    const h = refused(code);
    const error = await unionFailure(
      () => h.adapter.resolveLink(goods.shortLink, goods.ctx),
      'upstream_misconfigured',
    );
    expect(h.requests.map((body) => body.type)).toEqual([goods.search, goods.shortParse]);
    expect(h.warn.mock.calls).toEqual([[{ error_code: '20031', type: goods.shortParse }]]);
    expectRedacted([error, h.warn.mock.calls], [UPSTREAM, 'synthetic-link']);

    const other = refused(typeof code === 'number' ? 70032 : '70032');
    await unionFailure(
      () => other.adapter.resolveLink(goods.shortLink, goods.ctx),
      'link_unrecognized',
    );
    expect(other.requests.map((body) => body.type)).toEqual([goods.search, goods.shortParse]);
    expect(other.warn).not.toHaveBeenCalled();
  },
);

it.each(forms)(
  '[AC-B1-04zzzzc#18] resolveLink：goods.search 报 %j → upstream_misconfigured，不吞成识别失败、不调转链，只发 1 次请求，告警一次 { error_code, type: goods.search }',
  async (code) => {
    const h = goods.setup(() => ({ error_response: { error_code: code, error_msg: UPSTREAM } }));
    const error = await unionFailure(
      () => h.adapter.resolveLink(goods.longLink, goods.ctx),
      'upstream_misconfigured',
    );
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.type).toBe(goods.search);
    expect(h.warn.mock.calls).toEqual([[{ error_code: String(code), type: goods.search }]]);
    expectRedacted(error, [UPSTREAM]);
  },
);
