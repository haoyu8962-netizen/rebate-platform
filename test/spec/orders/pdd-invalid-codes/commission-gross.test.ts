// B1-04zgc · 佣金告警按毛额判（D10-1069 ⑥，spec-test r2 S2）：pdd_invalid_with_commission 看 promotion_amount > 0，
// 不看净额（promotion_amount − duo_id_service_fee）。直接调 mapPddOrder、告警出口是这页元数据上的测试 logger：
// 毛额 100、服务费 100（净额 0）与服务费缺失 / JSON null（净额 null）都照样告警，两条告警都不带金额；
// 毛额 0 不告警（服务费为正也不告警）。生产适配器上的同一边界见 adapter.test.ts。报文合成。
import { expect, it } from 'vitest';
import { mapPddOrder } from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import {
  COMMISSION_ALERT,
  FAIL_REASON,
  INVALID_STATUSES,
  UNMAPPED_ALERT,
  expectRedacted,
  pageWith,
  pddRow,
  testLogger,
  type WarnLine,
} from './kit.ts';

const SOURCES = ['increment', 'range', 'detail'] as const;

/** 本文件的合成金额：毛额 100，服务费 100 或缺失。 */
const GROSS = 100;

/** 告警的任何字段值与消息都不含金额 100（fail_reason 原值除外）。 */
function expectNoGross(line: WarnLine): void {
  const values: unknown[] = [
    ...Object.values(line.fields).filter((value) => value !== FAIL_REASON),
    line.message,
  ];
  for (const value of values) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    expect(new RegExp(`(^|\\D)${GROSS}(\\D|$)`).test(text), 'alert carries the amount').toBe(false);
  }
}

const EDGE_PATCHES = [
  ['净额为 0', { promotion_amount: GROSS, duo_id_service_fee: GROSS }, 0n],
  ['服务费缺失', { promotion_amount: GROSS, duo_id_service_fee: undefined }, null],
  ['服务费 JSON null', { promotion_amount: GROSS, duo_id_service_fee: null }, null],
] as const;

const EDGE_CASES = SOURCES.flatMap((source) =>
  INVALID_STATUSES.flatMap((status) =>
    EDGE_PATCHES.map(([name, patch, net]) => [source, status, name, patch, net] as const),
  ),
);

it.each(EDGE_CASES)(
  '[AC-B1-04zgc#14] %s 报文 order_status %s、%s（毛额 promotion_amount 100 > 0）：照样另打一条 warn（alert pdd_invalid_with_commission，platform pdd），共两条，都不带金额 / 单号 / 用户',
  (source, status, _name, patch, net) => {
    const log = testLogger();
    const dto = mapPddOrder(
      pddRow({ order_status: status, fail_reason: FAIL_REASON, ...patch }),
      source,
      pageWith(log.logger),
    );
    expect(dto).toMatchObject({
      raw_status: String(status),
      commission_fen: BigInt(GROSS),
      est_commission_fen: net,
    });
    const unmapped = log.unmapped();
    const withCommission = log.withCommission();
    expect(unmapped).toHaveLength(1);
    expect(withCommission).toHaveLength(1);
    expect(withCommission[0]!.fields).toMatchObject({ alert: COMMISSION_ALERT, platform: 'pdd' });
    expect(unmapped[0]!.fields).toMatchObject({ alert: UNMAPPED_ALERT, platform: 'pdd' });
    if (source !== 'detail') expect(Object.values(unmapped[0]!.fields)).toContain(FAIL_REASON);
    expectRedacted(withCommission[0]!);
    expectRedacted(unmapped[0]!, source === 'detail' ? null : FAIL_REASON);
    expectNoGross(withCommission[0]!);
    expectNoGross(unmapped[0]!);
    expect(log.lines()).toHaveLength(2);
  },
);

const ZERO_CASES = SOURCES.flatMap((source) =>
  INVALID_STATUSES.map((status) => [source, status] as const),
);

it.each(ZERO_CASES)(
  '[AC-B1-04zgc#15] %s 报文 order_status %s、毛额 promotion_amount 0、服务费 100（净额为负）：只打一条 order_reason_sub_unmapped，不打 pdd_invalid_with_commission',
  (source, status) => {
    const log = testLogger();
    const dto = mapPddOrder(
      pddRow({
        order_status: status,
        promotion_amount: 0,
        duo_id_service_fee: GROSS,
        fail_reason: FAIL_REASON,
      }),
      source,
      pageWith(log.logger),
    );
    expect(dto).toMatchObject({ raw_status: String(status), commission_fen: 0n });
    expect(log.unmapped()).toHaveLength(1);
    expect(log.withCommission()).toEqual([]);
    expect(log.lines()).toHaveLength(1);
  },
);
