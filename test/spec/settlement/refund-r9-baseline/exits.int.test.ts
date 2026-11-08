// B2-04zzf（FU-R9-REFUND-BASELINE，D10-870）：已退件数增加按 R9 判定、但这次不写扣回的三个出口。
// - R9 正差跳过（新结算高于 booked，D10-760 ①，只告警 settle_adjust_positive_pending）：钱不动，只推基线；
// - R9 无变化（新结算与 booked 相同，plan 无迁移）：钱不动，只推基线；
// 这两个出口之后已退件数不变的新结算负差走 R10 SETTLE_ADJUST，不再按 R9 扣回。
// - 等联盟佣金（BR-FUND-08 ③ WAIT_COMMISSION，开 CLAWBACK_NO_COMMISSION 待处理）：不推基线，等到新结算来时
//   仍按「已退件数增加」走 R9 扣回，并在那次写库推基线。
// 路径：生产装配的 worker，pdd；预留 0、会员本人 50%：1000 → 800 是 R10 各扣 100，1000 → 600 是 R9 各扣 200。
// Task-local AC labels ([AC-B2-04zzf#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { SETTLED_LATER } from '../settle-diff-sync/kit.ts';
import {
  MEMBER_ROLE,
  TIMEOUT,
  creditedWith,
  databaseFixture,
  settled,
  touched,
  withSync,
} from '../credit-refund-baseline/kit.ts';
import {
  ALERT_POSITIVE,
  ALERT_WAIT,
  baselineOf,
  clawbackKeysOf,
  clawedBackEvents,
  pendingOf,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzf#5] 已退 0 → 1 且新结算 1200（正差）：R9 跳过只告警、钱不动，但基线推到 1；随后新结算 800、已退件数不变 → R10 ADJ:3 各扣 100，没有 CLAWBACK',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      const orderId = (await o.row()).order_id;
      const before = await read.money();

      await o.sync(settled(1200n, { ...touched(1), refunded_quantity: 1 }));

      expect(logs).toContainEqual(
        expect.objectContaining({
          level: 40,
          alert: ALERT_POSITIVE,
          app_id: app.appId,
          order_id: orderId,
          seq: 2,
        }),
      );
      expect(await read.money()).toEqual(before);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_n_fen: 1000n,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
      });
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);

      await o.sync(settled(800n, { ...touched(2), refunded_quantity: 1 }));

      await read.adjustment(3, 100n, 100n);
      expect(clawbackKeysOf(await read.lines())).toEqual([]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
      });
      expect((await read.history()).map((r) => r.event)).toEqual(['SETTLE_NEGATIVE_DIFF']);
      expect(await clawedBackEvents(p.db, app.appId)).toEqual([]);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#6] 已退 0 → 1 且同额新结算记录（1000、结算时间变）：R9 无变化、钱不动，但基线推到 1；随后新结算 800、已退件数不变 → R10 ADJ:3 各扣 100，没有 CLAWBACK',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      const orderId = (await o.row()).order_id;
      const before = await read.money();

      await o.sync(
        settled(1000n, { ...touched(1), refunded_quantity: 1, settled_at: SETTLED_LATER }),
      );

      expect((await o.records()).map((r) => r.seq)).toEqual([1, 2]);
      expect(await read.money()).toEqual(before);
      expect(await o.row()).toMatchObject({ refunded_quantity: 1, refunded_quantity_at_credit: 0 });
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);

      await o.sync(
        settled(800n, { ...touched(2), refunded_quantity: 1, settled_at: SETTLED_LATER }),
      );

      await read.adjustment(3, 100n, 100n);
      expect(clawbackKeysOf(await read.lines())).toEqual([]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
      });
      expect((await read.history()).map((r) => r.event)).toEqual(['SETTLE_NEGATIVE_DIFF']);
      expect(await clawedBackEvents(p.db, app.appId)).toEqual([]);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#7] 已退 0 → 1 而没有新结算记录：等联盟佣金（CLAWBACK_NO_COMMISSION 待处理、告警），基线不推仍为空；随后新结算 600 → 仍按已退件数增加走 R9 各扣 200，此时基线推到 1、待处理关闭',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      const orderId = (await o.row()).order_id;
      const before = await read.money();

      await o.sync(settled(1000n, { ...touched(1), refunded_quantity: 1 }));

      expect((await o.records()).map((r) => r.seq)).toEqual([1]);
      expect(await read.money()).toEqual(before);
      expect(
        (await pendingOf(p.db, app.appId, o.subOrderId)).filter(
          (r) => r.reason === 'CLAWBACK_NO_COMMISSION',
        ),
      ).toEqual([{ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }]);
      expect(logs).toContainEqual(
        expect.objectContaining({ level: 40, alert: ALERT_WAIT, app_id: app.appId }),
      );
      expect(await baselineOf(p.db, app.appId, orderId)).toBeNull();

      await o.sync(settled(600n, { ...touched(2), refunded_quantity: 1 }));

      const row = await o.row();
      const lines = await read.lines();
      expect(clawbackKeysOf(lines)).toEqual(
        [
          `${read.orderRef}:${app.userId}:${MEMBER_ROLE}:CLAWBACK:C${String(row.commission_version)}`,
          `${read.orderRef}:PLATFORM:CLAWBACK:C${String(row.commission_version)}`,
        ].sort(),
      );
      expect(
        lines
          .filter((l) => l.ledger_type === 'CLAWBACK' && l.subject === 'USER_BALANCE')
          .map((l) => l.amount_fen),
      ).toEqual([200n]);
      expect(lines.filter((l) => l.ledger_type === 'SETTLE_ADJUST')).toEqual([]);
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
      });
      expect(
        (await pendingOf(p.db, app.appId, o.subOrderId)).filter(
          (r) => r.reason === 'CLAWBACK_NO_COMMISSION' && r.status === 'open',
        ),
      ).toEqual([]);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);
      await read.balanced();
    });
  },
  TIMEOUT,
);
