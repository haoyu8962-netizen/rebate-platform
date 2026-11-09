// B1-04zgc · 拼多多订单映射对 order_status 4 / 10 的告警（D10-1069 ⑥；平台差异止于适配器）。
// 直接调 mapPddOrder，告警出口是这页元数据上的测试 logger（PddOrderPage.logger）。状态 4 / 10 的订单：
// 一条 warn alert order_reason_sub_unmapped，带 platform pdd 与 fail_reason 原值（空 / 缺失也打）；
// 有佣金（promotion_amount > 0）的另打一条 warn alert pdd_invalid_with_commission。两条都不带订单号、
// 单号、金额、用户；DTO 照常给出原码，失效由状态表处理。其他状态两条都不打。报文合成。
import { expect, it } from 'vitest';
import { mapPddOrder } from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import {
  COMMISSION_ALERT,
  FAIL_REASON,
  INVALID_STATUSES,
  PROMOTION_AMOUNT,
  SERVICE_FEE,
  UNMAPPED_ALERT,
  expectRedacted,
  pageWith,
  pddRow,
  testLogger,
} from './kit.ts';

/** 列表接口（increment / range）都读 fail_reason；详情接口的字段表没有它。 */
const LIST_SOURCES = ['increment', 'range'] as const;

const FAIL_REASONS = [
  ['原文', { fail_reason: FAIL_REASON }, FAIL_REASON],
  ['空串', { fail_reason: '' }, ''],
  ['JSON null', { fail_reason: null }, null],
  ['缺失', {}, null],
] as const;

const LIST_CASES = LIST_SOURCES.flatMap((source) =>
  INVALID_STATUSES.flatMap((status) =>
    FAIL_REASONS.map(([name, patch, raw]) => [source, status, name, patch, raw] as const),
  ),
);

it.each(LIST_CASES)(
  '[AC-B1-04zgc#5] %s 报文 order_status %s、fail_reason %s、无佣金：恰一条 warn（alert order_reason_sub_unmapped，platform pdd，带原值），不打 pdd_invalid_with_commission，不带单号 / 金额 / 用户；DTO 原码不变',
  (source, status, _name, patch, raw) => {
    const log = testLogger();
    const row = pddRow({ order_status: status, ...patch });
    const dto = mapPddOrder(row, source, pageWith(log.logger));
    expect(dto).toMatchObject({ raw_status: String(status), commission_fen: 0n });
    const alerts = log.unmapped();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.fields).toMatchObject({ alert: UNMAPPED_ALERT, platform: 'pdd' });
    if (raw !== null) expect(Object.values(alerts[0]!.fields)).toContain(raw);
    expectRedacted(alerts[0]!, raw);
    expect(log.withCommission()).toEqual([]);
    expect(log.lines()).toHaveLength(1);
  },
);

it.each(INVALID_STATUSES)(
  '[AC-B1-04zgc#6] 详情报文 order_status %s（字段表不含 fail_reason，按缺失计）：恰一条 warn（alert order_reason_sub_unmapped，platform pdd），不带单号 / 金额 / 用户',
  (status) => {
    const log = testLogger();
    const dto = mapPddOrder(
      pddRow({ order_status: status, fail_reason: FAIL_REASON }),
      'detail',
      pageWith(log.logger),
    );
    expect(dto).toMatchObject({ raw_status: String(status) });
    const alerts = log.unmapped();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.fields).toMatchObject({ alert: UNMAPPED_ALERT, platform: 'pdd' });
    expectRedacted(alerts[0]!);
    expect(log.withCommission()).toEqual([]);
  },
);

const COMMISSION_CASES = [...LIST_SOURCES, 'detail' as const].flatMap((source) =>
  INVALID_STATUSES.map((status) => [source, status] as const),
);

it.each(COMMISSION_CASES)(
  '[AC-B1-04zgc#7] %s 报文 order_status %s 却有佣金（promotion_amount > 0）：照样给原码按失效，另打一条 warn（alert pdd_invalid_with_commission，platform pdd），两条告警都不带单号 / 金额 / 用户',
  (source, status) => {
    const log = testLogger();
    const dto = mapPddOrder(
      pddRow({
        order_status: status,
        promotion_amount: PROMOTION_AMOUNT,
        duo_id_service_fee: SERVICE_FEE,
        fail_reason: FAIL_REASON,
      }),
      source,
      pageWith(log.logger),
    );
    expect(dto).toMatchObject({
      raw_status: String(status),
      commission_fen: BigInt(PROMOTION_AMOUNT),
    });
    const unmapped = log.unmapped();
    const withCommission = log.withCommission();
    expect(unmapped).toHaveLength(1);
    expect(withCommission).toHaveLength(1);
    expect(withCommission[0]!.fields).toMatchObject({ alert: COMMISSION_ALERT, platform: 'pdd' });
    if (source !== 'detail') expect(Object.values(unmapped[0]!.fields)).toContain(FAIL_REASON);
    expectRedacted(withCommission[0]!);
    expectRedacted(unmapped[0]!, source === 'detail' ? null : FAIL_REASON);
    expect(log.lines()).toHaveLength(2);
  },
);

/** 状态表内外的其他码（含缺失的 order_status）。 */
const OTHER_STATUSES = [0, 1, 2, 3, 5, 6, 9, 11, 99, null] as const;

it.each(OTHER_STATUSES)(
  '[AC-B1-04zgc#8] 其他 order_status %s（有佣金、有 fail_reason）不打这两条告警：同一 logger 上只有状态 4 那单的一条 order_reason_sub_unmapped',
  (status) => {
    const log = testLogger();
    const page = pageWith(log.logger);
    const other = mapPddOrder(
      pddRow({
        order_status: status,
        promotion_amount: PROMOTION_AMOUNT,
        duo_id_service_fee: SERVICE_FEE,
        fail_reason: FAIL_REASON,
      }),
      'increment',
      page,
    );
    expect(other.raw_status).toBe(status === null ? null : String(status));
    mapPddOrder(pddRow({ order_status: 4, order_sn: 'SYN-PDD-INV-other' }), 'increment', page);
    expect(log.withCommission()).toEqual([]);
    expect(log.unmapped()).toHaveLength(1);
    expect(log.lines()).toHaveLength(1);
  },
);
