import { expect, vi } from 'vitest';
import {
  UnionIdentity,
  type CallCtx,
  type ConvertReq,
  type IdentityClaims,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { JdAdapterOptions } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import type {
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { formFields, response, sent, setup } from '../jd-core/kit.ts';
import { jsonText, num } from '../jd-orders/kit.ts';

// Task-local AC labels ([AC-B1-04zd#n]) identify this task's acceptance points, not business rules.
// 字段名与错误码来自任务书（D10-500 ①、CAP-JD-06），值全部合成，不是任何京东接口的录制；
// sub_union_id 用短串，传输全在内存中。
export const method = 'jd.union.open.promotion.common.get';
/** Spelled `_responce` on the wire; the misspelling is the gateway's own. */
export const keys = {
  envelope: 'jd_union_open_promotion_common_get_responce',
  resultKey: 'getResult',
};
export const ctx: CallCtx = {
  appId: 'app-synthetic',
  requestId: 'req-convert-synthetic',
  purpose: 'online',
};
/** 联盟 itemId 形如 A段_B段。 */
export const itemId = 'synthAseg_Bseg';
export const materialId = `https://jingfen.jd.com/detail/${itemId}.html`;
export const skuId = '100012345678';
export const siteId = '4000123';
export const slot = '1234567';
export const subUnionId = 'n_abcd1234';
export const clickUrl = 'https://union-click.jd.com/synth01';
export const userId = 'internal-user-marker';
export const upstreamText = 'upstream-text-marker';
export const req: ConvertReq = {
  item: { platform: 'jd', item_id: itemId },
  idempotencyKey: 'synthetic-idempotency',
};

/**
 * 走底座细分表的内层 code（限流在先）；warned 是同时告警一次的。其余 code 按底座 upstream_rejected，
 * 201、410 是 goods.query 自己的细分，这里不算数。
 */
export const innerCodes: readonly (readonly [string, UnionErrorCode])[] = [
  ['429', 'rate_limited'],
  ['2001104', 'item_unavailable'],
  ['2001101', 'link_unrecognized'],
  ['2001102', 'link_unrecognized'],
  ['2001703', 'link_unrecognized'],
  ['2001706', 'link_unrecognized'],
  ['2001707', 'link_unrecognized'],
  ['2001208', 'upstream_rejected'],
  ['2001609', 'upstream_unavailable'],
  ['2001999', 'upstream_rejected'],
  ['201', 'upstream_rejected'],
  ['410', 'upstream_rejected'],
];
export const warned: readonly string[] = ['2001701', '2001603'];

/** Structural stand-in for linking's server-built subclass; no linking import in union. */
export class JdIdentity extends UnionIdentity {
  constructor(
    attributes: Readonly<Record<string, unknown>> = { subUnionId },
    claims: Readonly<Record<string, unknown>> = {},
  ) {
    super({
      appId: ctx.appId,
      userId,
      platform: 'jd',
      promotionSlot: slot,
      relationId: null,
      ...claims,
    } as IdentityClaims);
    Object.assign(this, attributes);
    Object.freeze(this);
  }
}

export const identity = new JdIdentity();
/** no_rebate：linking 不给 subUnionId 属性。 */
export const noRebate = new JdIdentity({});

export function reply(innerText: string): UnionTransportResponse {
  return response({ [keys.envelope]: { code: '0', [keys.resultKey]: innerText } });
}

export function success(data: unknown = { clickURL: clickUrl }): string {
  return jsonText({ code: num('200'), message: 'success', requestId: 'req-upstream', data });
}

export function failure(code: unknown, message = upstreamText): string {
  return jsonText({ code, message, requestId: 'req-upstream' });
}

/** The business object of one request: promotionCodeReq is its only key. */
export function promotionReq(request: UnionTransportRequest): Record<string, unknown> {
  const payload = formFields(request)['360buy_param_json'];
  expect(payload).toBeTypeOf('string');
  const parameters = JSON.parse(payload!) as Record<string, Record<string, unknown>>;
  expect(Object.keys(parameters)).toEqual(['promotionCodeReq']);
  return parameters['promotionCodeReq']!;
}

/** The jd-core adapter with a site id, answering `answer`. */
export function wire(
  answer: UnionTransportResponse = reply(success()),
  overrides: Partial<JdAdapterOptions> = {},
) {
  const core = setup({ siteId, ...overrides });
  core.transport.mockResolvedValue(answer);
  return core;
}

type Harness = ReturnType<typeof setup>;

/** The first request's promotionCodeReq. */
export function firstBody(h: Harness): Record<string, unknown> {
  return promotionReq(sent(h.transport));
}

export function expectNothingSent(h: Harness): void {
  expect(h.credentials).not.toHaveBeenCalled();
  expect(h.transport).not.toHaveBeenCalled();
}

/** The product key mode port, answering `productKeyMode` on every read. */
export function modePort(productKeyMode: JdProductKeyMode) {
  return { read: vi.fn(async (): Promise<JdProductKeyMode> => productKeyMode) };
}
