// B2-04zzf（FU-R9-REFUND-BASELINE；BR-FUND-01「R9 与 R9b 的判定」、BR-FUND-08、BR-FUND-09）：「同一次同步中
// refunded_quantity 增加」比的是 COALESCE(r9 基线, refunded_quantity_at_credit, 0)。R9 扣回与写基线同一次写库，
// 之后已退件数没再增加的同步不再按 R9：新结算负差走 R10 SETTLE_ADJUST（不是 CLAWBACK / PART_REFUND、不发
// order.clawed_back），只有内容变化时什么都不做（不开 CLAWBACK_NO_COMMISSION 待处理、不告警）；再退一件才再走 R9。
// 路径：生产装配的 worker（真实同步 → 账单 → R5 → 同步里的 clawback onUpdated），pdd。
// 金额（kit：预留 0，会员本人 50%）：N 1000 → 本人 500 / 平台 500；600 → 300 / 300（各扣 200）；
// 500 → 250 / 250（R10 各扣 50）；400 → 200 / 200（R9 各扣 100）。
// Task-local AC labels ([AC-B2-04zzf#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createInviteRewardOrderFacts } from '../../../../apps/api/src/modules/orders/index.ts';
import { inviteRewardOrderClawedBack } from '../../../../apps/api/src/modules/growth/application/invite-reward.ts';
import {
  MEMBER_ROLE,
  TIMEOUT,
  creditedWith,
  databaseFixture,
  settled,
  touched,
  withSync,
} from '../credit-refund-baseline/kit.ts';
import { ALERT_WAIT, baselineOf, clawbackKeysOf, clawedBackEvents, pendingOf } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The CLAWBACK keys of the member and the platform for rights_event_id C{version}. */
function r9Keys(orderRef: string, userId: string, version: number): string[] {
  return [
    `${orderRef}:${userId}:${MEMBER_ROLE}:CLAWBACK:C${String(version)}`,
    `${orderRef}:PLATFORM:CLAWBACK:C${String(version)}`,
  ].sort();
}

/** The four lines of one R9 (member and platform each debited `amount`). */
function r9Lines(amount: bigint): string[] {
  return [
    `USER_BALANCE|${String(amount)}`,
    `COMMISSION_REVENUE|${String(amount)}`,
    `UNION_RECEIVABLE:pdd|${String(-amount)}`,
    `UNION_RECEIVABLE:pdd|${String(-amount)}`,
  ].sort();
}

it(
  '[AC-B2-04zzf#2] 已退 0 → 1 且新结算 600：R9 按 600 扣回 200 / 200，同一次写库把基线推到 1，at_credit 仍为 0；邀请奖励仍比 at_credit（已退 1 > 0 → 作废）',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      await o.sync(settled(600n, { ...touched(1), refunded_quantity: 1 }));

      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
        diff_reason_code: 'PART_REFUND',
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
      });
      const lines = await read.lines();
      expect(clawbackKeysOf(lines)).toEqual(
        r9Keys(read.orderRef, app.userId, row.commission_version),
      );
      expect(
        lines
          .filter((l) => l.ledger_type === 'CLAWBACK')
          .map((l) => `${l.subject}|${String(l.amount_fen)}`)
          .sort(),
      ).toEqual(r9Lines(200n));
      expect(await baselineOf(p.db, app.appId, row.order_id)).toBe(1);

      // growth（BR-INV-24）不随基线变：仍是 refunded_quantity 对 refunded_quantity_at_credit。
      const fact = await p.db
        .transaction()
        .execute((trx) =>
          createInviteRewardOrderFacts().read(trx, { app_id: app.appId, order_id: row.order_id }),
        );
      expect(fact).toMatchObject({ refunded_quantity: 1, refunded_quantity_at_credit: 0 });
      if (fact === null) throw new Error('the invite reward fact of the order');
      expect(inviteRewardOrderClawedBack({ ...fact, platform: row.platform }, false)).toBe(true);
      await read.balanced();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#3] R9（已退 1、600）之后新结算 500、已退件数不变：走 R10 SETTLE_ADJUST（ADJ:3 各扣 50），不再记 CLAWBACK / PART_REFUND，order.clawed_back 仍只有 R9 那一条，基线仍为 1',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      await o.sync(settled(600n, { ...touched(1), refunded_quantity: 1 }));
      const orderId = (await o.row()).order_id;
      const clawbacks = clawbackKeysOf(await read.lines());
      expect(clawbacks).toHaveLength(2);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);

      await o.sync(settled(500n, { ...touched(2), refunded_quantity: 1 }));

      await read.adjustment(3, 50n, 50n);
      expect(clawbackKeysOf(await read.lines())).toEqual(clawbacks);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 500n,
        booked_n_fen: 500n,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
      });
      expect((await read.history()).map((r) => r.event)).toEqual([
        'PARTIAL_REFUND',
        'SETTLE_NEGATIVE_DIFF',
      ]);
      expect(await clawedBackEvents(p.db, app.appId)).toHaveLength(1);
      expect(await w.available(app)).toBe(250n);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#3b] R9（已退 1、600）之后两次只有内容变化的同步（无新结算记录、已退件数不变）：不扣、不等联盟佣金，不开 CLAWBACK_NO_COMMISSION 待处理、不告警，钱与历史都不变',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      await o.sync(settled(600n, { ...touched(1), refunded_quantity: 1 }));
      const orderId = (await o.row()).order_id;
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);
      const before = await read.money();
      const pendingBefore = await pendingOf(p.db, app.appId, o.subOrderId);

      await o.sync(settled(600n, { ...touched(2), refunded_quantity: 1 }));
      await o.sync(settled(600n, { ...touched(3), refunded_quantity: 1 }));

      expect((await o.records()).map((r) => r.seq)).toEqual([1, 2]);
      expect(await read.money()).toEqual(before);
      const pending = await pendingOf(p.db, app.appId, o.subOrderId);
      expect(pending.filter((r) => r.reason === 'CLAWBACK_NO_COMMISSION')).toEqual([]);
      expect(pending).toEqual(pendingBefore);
      expect(logs.filter((l) => l['alert'] === ALERT_WAIT && l['app_id'] === app.appId)).toEqual(
        [],
      );
      expect(await clawedBackEvents(p.db, app.appId)).toHaveLength(1);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#4] R9（已退 1、600）之后再退一件（1 → 2）且新结算 400：比基线 1 仍是增加 → 再走 R9 按 400 各扣 100（新的 C{版本} 键），基线推到 2，at_credit 仍为 0',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      await o.sync(settled(600n, { ...touched(1), refunded_quantity: 1 }));
      const first = await o.row();
      const firstKeys = r9Keys(read.orderRef, app.userId, first.commission_version);
      expect(clawbackKeysOf(await read.lines())).toEqual(firstKeys);
      expect(await baselineOf(p.db, app.appId, first.order_id)).toBe(1);

      await o.sync(settled(400n, { ...touched(2), refunded_quantity: 2 }));

      const row = await o.row();
      const secondKeys = r9Keys(read.orderRef, app.userId, row.commission_version);
      const lines = await read.lines();
      expect(clawbackKeysOf(lines)).toEqual([...firstKeys, ...secondKeys].sort());
      expect(
        lines
          .filter((l) => secondKeys.includes(l.uniq_key))
          .map((l) => `${l.subject}|${String(l.amount_fen)}`)
          .sort(),
      ).toEqual(r9Lines(100n));
      expect(lines.filter((l) => l.ledger_type === 'SETTLE_ADJUST')).toEqual([]);
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 400n,
        booked_n_fen: 400n,
        refunded_quantity: 2,
        refunded_quantity_at_credit: 0,
      });
      expect(await clawedBackEvents(p.db, app.appId)).toHaveLength(2);
      expect(await baselineOf(p.db, app.appId, row.order_id)).toBe(2);
      await read.balanced();
    });
  },
  TIMEOUT,
);
