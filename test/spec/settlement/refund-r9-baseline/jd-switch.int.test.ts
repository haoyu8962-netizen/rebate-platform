// B2-04zzf（FU-R9-REFUND-BASELINE，D10-870；B1-08zi D10-814 ⑥）：京东开关 orders.jd.refunded_quantity_r9_enabled
// 关（未配置或 false）时，已退件数增加不触发 R9、只告警（alert_only），基线照样推到当时的已退件数；之后开关打开，
// 已经告警过的那次增加不再按 R9 补扣（不等联盟佣金、不开待处理、不再告警）。
// 路径：B2-04s harness（真实 B2-04m 入账、真实 clawback onUpdated；同步写 orders 列后在同一事务调 onUpdated，
// 新结算经 settlement 的结算记录端口写成决定金额的 API 记录）。
// 金额（kit 默认）：N 1000、预留 1500 → B 850，本人 / 直推 / 间推 425 / 85 / 42；600 → 255 / 51 / 25。
// Task-local AC labels ([AC-B2-04zzf#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, harness } from '../clawback/kit.ts';
import {
  ALERT_JD_OFF,
  ALERT_WAIT,
  JD_SWITCH,
  alertsFor,
  baselineOf,
  creditedApiOnly,
  moneyOf,
  setSwitch,
  syncWithRecord,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each([
  ['未配置', undefined],
  ['false', false],
] as const)(
  '[AC-B2-04zzf#9] 京东 CREDITED（入账已退 1）、开关%s、同步已退 1 → 2：只告警不扣，基线推到 2；开关打开后再同步（已退件数不变）不按 R9 补扣、不等联盟佣金、不开待处理',
  async (_name, value) => {
    const h = await harness(p.db);
    const o = await h.credited({ platform: 'jd', patch: { quantity: 3, refunded_quantity: 1 } });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      refunded_quantity: 1,
      refunded_quantity_at_credit: 1,
    });
    setSwitch(h, value);
    const before = await moneyOf(h, o);

    const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', refundedQuantityAfter: 2 });

    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(h.configGet).toHaveBeenCalledWith(h.appId, JD_SWITCH);
    expect(alertsFor(h, o, ALERT_JD_OFF)).toHaveLength(1);
    expect(await moneyOf(h, o)).toEqual(before);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(2);

    setSwitch(h, true);
    const { result: later } = await h.sync(o, { event: 'PLATFORM_SETTLED' });

    expect(later).toMatchObject({ outcome: 'skipped' });
    expect(h.openPending).not.toHaveBeenCalled();
    expect(await moneyOf(h, o)).toEqual(before);
    expect(alertsFor(h, o, ALERT_WAIT)).toEqual([]);
    expect(alertsFor(h, o, ALERT_JD_OFF)).toHaveLength(1);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      refunded_quantity: 2,
      refunded_quantity_at_credit: 1,
    });
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#9] 京东 CREDITED（入账已退 1）、开关 false、同一次同步已退 1 → 2 且新结算 600：已退件数不触发 R9，照常 R10 SETTLE_ADJUST，基线推到 2；开关打开后再同步（已退件数不变）不按 R9 补扣',
  async () => {
    const h = await harness(p.db);
    const o = await creditedApiOnly(p.db, h, { platform: 'jd', quantity: 3, refunded: 1 });
    setSwitch(h, false);

    const result = await syncWithRecord(p.db, h, o, { refundedAfter: 2, settleFen: 600n });

    expect(result).toMatchObject({
      outcome: 'settle_adjusted',
      transition: 'R10',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(alertsFor(h, o, ALERT_JD_OFF)).toHaveLength(1);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(2);
    const adjusted = await moneyOf(h, o);
    expect(adjusted.balances).toEqual([255n, 51n, 25n]);

    setSwitch(h, true);
    const { result: later } = await h.sync(o, { event: 'PLATFORM_SETTLED' });

    expect(later).toMatchObject({ outcome: 'skipped' });
    expect(h.openPending).not.toHaveBeenCalled();
    expect(await moneyOf(h, o)).toEqual(adjusted);
    expect(alertsFor(h, o, ALERT_WAIT)).toEqual([]);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      refunded_quantity: 2,
      refunded_quantity_at_credit: 1,
    });
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(2);
  },
  TIMEOUT,
);
