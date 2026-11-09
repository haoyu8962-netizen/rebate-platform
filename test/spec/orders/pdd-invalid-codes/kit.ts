// B1-04zgc 规则测试夹具（claude-independent，D10-1069，FU-PDD-INVALID-CODES-MAP）。
// 负责人 2026-11-08「这种单子出现时，只要联盟返回没有佣金 全部算失效」：拼多多 order_status 4（审核失败，
// 不可提现）、10（已处罚）进 specs/order-status-map/pdd.csv，映 PLATFORM_INVALID（source doc、verified false），
// 照京东先例 B1-04zga 走现有失效口径，不写子原因。出处：rebate-private/docs-mirror/pdd/api/
// pdd.ddk.order.list.increment.get.md（order_status 4-审核失败（不可提现）、10-已处罚；fail_reason
// 「订单审核失败/惩罚原因」，无枚举）。报文全部合成，不是录制。
// 本文件不导入 @couli/db/testing：要真库的测试把库传进来。
import { expect, vi } from 'vitest';
import type {
  PddOrderLogger,
  PddOrderPage,
} from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';

/** D10-1069 补进 pdd.csv 的两个码（字符串，同 UnionOrder.raw_status）。 */
export const INVALID_CODES = ['4', '10'] as const;
/** 同上，报文里的 order_status 是整数。 */
export const INVALID_STATUSES = [4, 10] as const;
/** specs/order-status-map/pdd.csv 的确认收货码。 */
export const PDD_RECEIVED = '2';
/** D10-1069 ⑥：fail_reason 对不上子原因表时的告警（与 B2-04zze 同名）。 */
export const UNMAPPED_ALERT = 'order_reason_sub_unmapped';
/** D10-1069 ⑥：状态 4 / 10 却带佣金时的另一条告警。 */
export const COMMISSION_ALERT = 'pdd_invalid_with_commission';

/** 合成报文里会被查「不许出现在告警里」的值。 */
export const ORDER_SN = 'SYN-PDD-INV-7d1c0e';
export const PLATFORM_ORDER_ID = 'SYN-PO-INV-3e9a51';
export const SLOT = 'syn-slot-inv-b4';
export const MEMBER_UID = 'synuid42q';
export const CUSTOM_PARAMETERS = JSON.stringify({ app: 'n', uid: MEMBER_UID });
export const ORDER_AMOUNT = 73519;
export const PROMOTION_AMOUNT = 4817;
export const SERVICE_FEE = 481;
/** PROMOTION_AMOUNT − SERVICE_FEE：映射算出的净额也不许进告警。 */
export const NET_AMOUNT = 4336;

/** 合成的 fail_reason 原文（文档无枚举）。 */
export const FAIL_REASON = '合成审核失败原因-甲';

/** 这页报文的元数据，带测试 logger。 */
export function pageWith(logger: PddOrderLogger): PddOrderPage {
  return { rawPayloadId: null, like: new Date('2026-11-08T02:00:00.000Z'), logger };
}

/**
 * 一条拼多多订单报文（字段名按 pdd.ddk.order.list.increment.get 文档；合成值）。
 * 默认没有佣金（promotion_amount 0）；fail_reason 只在 patch 里给。
 */
export function pddRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_sn: ORDER_SN,
    order_id: PLATFORM_ORDER_ID,
    p_id: SLOT,
    pid: SLOT,
    goods_id: 8123456789012,
    goods_sign: 'syn-goods-inv',
    mall_id: 7001,
    custom_parameters: CUSTOM_PARAMETERS,
    goods_price: ORDER_AMOUNT,
    order_amount: ORDER_AMOUNT,
    promotion_amount: 0,
    duo_id_service_fee: 0,
    order_status: 4,
    order_status_desc: '审核失败',
    order_pay_time: 1792000000,
    order_modify_at: 1792000060,
    ...patch,
  };
}

/** 一条 warn：平铺字段与消息。 */
export interface WarnLine {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: unknown;
}

/** 测试 logger：只记 warn。 */
export function testLogger() {
  const warn = vi.fn<PddOrderLogger['warn']>();
  const logger: PddOrderLogger = { warn };
  function lines(): WarnLine[] {
    return warn.mock.calls.map(([fields, message]) => ({ fields, message }));
  }
  return {
    logger,
    lines,
    unmapped: () => lines().filter((line) => line.fields['alert'] === UNMAPPED_ALERT),
    withCommission: () => lines().filter((line) => line.fields['alert'] === COMMISSION_ALERT),
  };
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'bigint' ? inner.toString() : inner,
  );
}

/**
 * 告警只带平台与原值（D10-1069 ⑥「不带订单号、单号、金额、用户」）：任何字段值、整条（字段 + 消息）
 * 都不含订单号、平台单号、推广位、归因参数与用户码；除 fail_reason 原值外的字段不含金额；
 * 字段名也不是单号 / 用户 / 金额一类。
 */
export function expectRedacted(line: WarnLine, raw: string | null = null): void {
  const whole = text({ fields: line.fields, message: line.message });
  for (const secret of [ORDER_SN, PLATFORM_ORDER_ID, SLOT, MEMBER_UID, CUSTOM_PARAMETERS]) {
    expect(whole.includes(secret), 'alert carries an order, slot or user identifier').toBe(false);
  }
  const amounts = [ORDER_AMOUNT, PROMOTION_AMOUNT, SERVICE_FEE, NET_AMOUNT].map(String);
  const values: [string, unknown][] = [...Object.entries(line.fields), ['(message)', line.message]];
  for (const [key, value] of values) {
    if (raw !== null && value === raw) continue;
    for (const amount of amounts) {
      expect(
        new RegExp(`(^|\\D)${amount}(\\D|$)`).test(text(value)),
        `alert field ${key} carries an amount`,
      ).toBe(false);
    }
  }
  expect(
    Object.keys(line.fields).filter((key) =>
      /order_sn|order_id|sub_order|order_no|p_id|^pid$|custom|uid|user|fen|amount|price|fee/i.test(
        key,
      ),
    ),
  ).toEqual([]);
}
