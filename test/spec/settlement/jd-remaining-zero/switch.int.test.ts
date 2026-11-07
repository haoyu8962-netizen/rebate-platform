// B2-04zzg（D10-864 ②：同一个开关 orders.jd.refunded_quantity_r9_enabled 管「京东已退件数驱动的一切资金处置」）：
// 开关关（未配置，或任何不是 JSON true 的值，与 B1-08zi 的 jdRefundR9Enabled 同口径）时，未入账京东单剩余数量归 0
// 不迁移、不动钱、不入队 order.invalidated，只写一条 warn（alert jd_remaining_zero_r6_disabled，带 app_id、
// order_id、platform、quantity、refunded_quantity），其余判定照常；开关是每次同步实时读的：之后打开再同步一次
// （数量不变）即作废。主干上没有这条告警、打开后也不作废：每条都红。
// Task-local AC labels ([AC-B2-04zzg#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { SWITCH, TIMEOUT, counts, databaseFixture, precredit, touched, withWorker } from './kit.ts';

const p = databaseFixture(createTestDatabase);

const OFF: readonly (readonly [string, 'ESTIMATED' | 'WAITING', unknown])[] = [
  ['未配置', 'ESTIMATED', undefined],
  ['false', 'WAITING', false],
  ['字符串 "true"', 'ESTIMATED', 'true'],
  ['数字 1', 'WAITING', 1],
];

it.each(OFF)(
  '[AC-B2-04zzg#8] 开关%s：%s 京东单 2 件退 2 → 状态与原因不变、无分录、无 order.invalidated，恰一条 warn 告警；之后开关置 true、同样数量再同步一次 → R6 → VOID',
  async (_name, status, value) => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', status);
      if (value !== undefined) await w.setConfig(app, SWITCH, value);
      const before = await o.row();
      const ledger = await w.ledgerOf(app);
      const totals = await o.totals();

      await o.sync(touched(5, counts(2, 2)));

      const kept = await o.row();
      expect(kept).toMatchObject({
        rebate_status: status,
        reason: null,
        quantity: 2,
        refunded_quantity: 2,
        commission_version: before.commission_version,
        est_commission_fen: before.est_commission_fen,
      });
      expect(await o.voids()).toEqual([]);
      expect(await o.invalidated()).toEqual([]);
      expect(await w.ledgerOf(app)).toEqual(ledger);
      expect(await o.totals()).toEqual(totals);
      const alerts = await o.alerts(logs);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        app_id: app.appId,
        order_id: kept.order_id,
        platform: 'jd',
        quantity: 2,
        refunded_quantity: 2,
      });

      await w.setConfig(app, SWITCH, true);
      await o.sync(touched(6, counts(2, 2)));

      expect(await o.row()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
      expect(await o.voids()).toEqual([
        { from_status: status, event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
      ]);
      expect((await o.invalidated()).map((e) => e.payload['reason'])).toEqual(['REFUND']);
      expect(await w.ledgerOf(app)).toEqual(ledger);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#9] 开关关：同一报文确认收货且退完 → 其余判定照常（R4 到 WAITING），只多一条告警，不作废',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'ESTIMATED');

      await o.sync(o.receipt(5, counts(2, 2)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'WAITING',
        reason: null,
        platform_status: 'RECEIVED',
        refunded_quantity: 2,
      });
      expect(await o.voids()).toEqual([]);
      expect(await o.invalidated()).toEqual([]);
      expect(await o.alerts(logs)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#10] 开关关：剩余数量 > 0（3 件退 2）不告警；退到 3 件才告警一次',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'WAITING', 3);

      await o.sync(touched(5, counts(3, 2)));
      expect(await o.alerts(logs)).toEqual([]);

      await o.sync(touched(6, counts(3, 3)));
      expect(await o.alerts(logs)).toHaveLength(1);
      expect(await o.row()).toMatchObject({ rebate_status: 'WAITING', refunded_quantity: 3 });
      expect(await o.invalidated()).toEqual([]);
    });
  },
  TIMEOUT,
);
