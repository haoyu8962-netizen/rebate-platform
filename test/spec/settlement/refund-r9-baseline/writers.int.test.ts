// B2-04zzf（FU-R9-REFUND-BASELINE，D10-870）：扣回写订单的每一次写库（R8 / R9 / R10）都在同一语句里把基线推到锁内
// 读到的 refunded_quantity；之后已退件数不变的同步不再按 R9 判定。
// - 8a R8：已退 0 → 2 且新结算 0 → 整单扣回 CLAWED_BACK，基线 2；
// - 8b R10 回应待佣金维权（D10-474 ②，B2-04zza）：同一次同步已退 0 → 1 且新结算 600 → R10，基线 1；之后一次
//   没有新内容的同步不再按 R9 等联盟佣金（不重开 CLAWBACK_NO_COMMISSION 待处理、维权记录保持 SUCCEEDED）；
// - 8c 普通 R10（已退件数等于入账定格）：基线推到当时的已退件数 1；再退一件（1 → 2）才走 R9，基线 2。
// 路径：8a / 8c 为生产装配的 worker（pdd，预留 0、会员本人 50%）；8b 为 B2-04zza 的 harness（真实维权命令、真实
// 入账、真实 clawback；默认 N 1000、预留 1500 → B 850，600 → B 510）。
// Task-local AC labels ([AC-B2-04zzf#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  MEMBER_ROLE,
  TIMEOUT,
  creditedWith,
  databaseFixture,
  settled,
  touched,
  withSync,
} from '../credit-refund-baseline/kit.ts';
import { LATER, harness as rightsWaitHarness } from '../rights-wait-adj-obligation/kit.ts';
import { baselineOf, clawbackKeysOf, clawedBackEvents } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzf#8a] 已退 0 → 2（全退）且新结算 0：R8 整单扣回（CLAWED_BACK，本人与平台各扣 500），同一次写库基线推到 2，at_credit 仍为 0',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 2, refunded_quantity: 0 });

      await o.sync(settled(0n, { ...touched(1), refunded_quantity: 2 }));

      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        reason: 'COMMISSION_ZERO',
        booked_base_fen: 0n,
        booked_n_fen: 0n,
        refunded_quantity: 2,
        refunded_quantity_at_credit: 0,
      });
      const lines = await read.lines();
      expect(clawbackKeysOf(lines)).toEqual(
        [
          `${read.orderRef}:${app.userId}:${MEMBER_ROLE}:CLAWBACK:C${String(row.commission_version)}`,
          `${read.orderRef}:PLATFORM:CLAWBACK:C${String(row.commission_version)}`,
        ].sort(),
      );
      expect(await w.available(app)).toBe(0n);
      expect(await clawedBackEvents(p.db, app.appId)).toHaveLength(1);
      expect(await baselineOf(p.db, app.appId, row.order_id)).toBe(2);
      await read.balanced();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#8b] 等佣金的维权 + 同一次同步已退 0 → 1 且新结算 600：R10 回应维权（不扣 CLAWBACK），基线推到 1；之后一次没有新内容的同步：不按 R9 再等联盟佣金，不开待处理、钱不动',
  async () => {
    const h = await rightsWaitHarness(p.db);
    const { o, waitingId } = await h.waiting({ patch: { quantity: 3 } });
    expect(await h.read(o)).toMatchObject({ refunded_quantity: 0, refunded_quantity_at_credit: 0 });

    h.clock.set(LATER);
    const { result } = await h.arrive(o, {
      settleAfter: 600n,
      newSeq: 3,
      refundedQuantityAfter: 1,
    });

    expect(result).toMatchObject({
      outcome: 'settle_adjusted',
      transition: 'R10',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    await h.expectAnswered(o, waitingId);
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(1);

    const keys = await h.orderVoucherKeys(o);
    const columns = await h.rebateColumns(o);
    const { result: again } = await h.sync(o, { event: 'PLATFORM_SETTLED' });

    expect(again).toMatchObject({ outcome: 'skipped' });
    expect(await h.orderVoucherKeys(o)).toEqual(keys);
    expect(await h.rebateColumns(o)).toEqual(columns);
    expect((await h.pendingRows(o)).filter((r) => r.status === 'open')).toEqual([]);
    expect(await h.onlyRights(o)).toMatchObject({ id: waitingId, status: 'SUCCEEDED' });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      refunded_quantity: 1,
      refunded_quantity_at_credit: 0,
    });
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#8c] 入账时已退 1（at_credit 1）、新结算 800 且已退件数不变：R10 ADJ:2 各扣 100，基线推到 1；再退一件（1 → 2）且新结算 600 → R9 各扣 100，基线推到 2',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 3, refunded_quantity: 1 });
      const orderId = (await o.row()).order_id;

      await o.sync(settled(800n, { ...touched(1), refunded_quantity: 1 }));

      await read.adjustment(2, 100n, 100n);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 1,
      });
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);

      await o.sync(settled(600n, { ...touched(2), refunded_quantity: 2 }));

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
          .filter((l) => l.ledger_type === 'CLAWBACK')
          .map((l) => `${l.subject}|${String(l.amount_fen)}`)
          .sort(),
      ).toEqual(
        [
          'USER_BALANCE|100',
          'COMMISSION_REVENUE|100',
          'UNION_RECEIVABLE:pdd|-100',
          'UNION_RECEIVABLE:pdd|-100',
        ].sort(),
      );
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
        refunded_quantity: 2,
        refunded_quantity_at_credit: 1,
      });
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(2);
      await read.balanced();
    });
  },
  TIMEOUT,
);
