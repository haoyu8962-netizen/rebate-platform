// B2-04zzf（FU-R9-REFUND-BASELINE，D10-870；BR-FUND-01 R9、02 §18 同事务）：基线与 R9 扣回在同步的同一事务里写：
// 事务里能读到推进后的基线，下游失败整事务回滚时基线、已退件数、凭证、余额与 booked 一起回到同步之前；
// 重投同一次同步照常 R9 并推基线。基线按 (app_id, order_id) 写，不碰别的 app 的订单。
// 路径：B2-04s harness（真实 B2-04m 入账、真实 clawback onUpdated），新结算经 settlement 的结算记录端口写成
// 决定金额的 API 记录。金额（kit 默认）：N 1000、预留 1500 → B 850，425 / 85 / 42；600 → B 510，255 / 51 / 25。
// Task-local AC labels ([AC-B2-04zzf#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, harness } from '../clawback/kit.ts';
import { INJECTED, baselineOf, creditedApiOnly, moneyOf, syncWithRecord } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzf#10] 已退 0 → 1 且新结算 600 的同步事务里 R9 已推基线到 1，下游失败回滚后基线仍为空、钱与已退件数都不变；重投同一次同步 R9 扣回 170 / 34 / 17，基线 1',
  async () => {
    const h = await harness(p.db);
    const o = await creditedApiOnly(p.db, h, { quantity: 3, refunded: 0 });
    const before = await moneyOf(h, o);

    let inside: number | null | undefined;
    await expect(
      syncWithRecord(p.db, h, o, {
        refundedAfter: 1,
        settleFen: 600n,
        after: async (trx) => {
          inside = await baselineOf(trx, h.appId, o.orderId);
          throw new Error(INJECTED);
        },
      }),
    ).rejects.toThrow(INJECTED);

    expect(inside).toBe(1);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBeNull();
    expect(await moneyOf(h, o)).toEqual(before);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      refunded_quantity: 0,
      refunded_quantity_at_credit: 0,
    });

    const result = await syncWithRecord(p.db, h, o, { refundedAfter: 1, settleFen: 600n });

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    expect((await moneyOf(h, o)).balances).toEqual([255n, 51n, 25n]);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#10] 两个 app 各有一笔已入账订单：只同步 A 的已退 0 → 1 且新结算 600，A 走 R9、基线 1；B 的订单基线仍为空、钱与件数不变',
  async () => {
    const a = await harness(p.db);
    const b = await harness(p.db);
    const oa = await creditedApiOnly(p.db, a, { quantity: 3, refunded: 0 });
    const ob = await creditedApiOnly(p.db, b, { quantity: 3, refunded: 0 });
    const other = { money: await moneyOf(b, ob), row: await b.read(ob) };

    const result = await syncWithRecord(p.db, a, oa, { refundedAfter: 1, settleFen: 600n });

    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    expect(await baselineOf(p.db, a.appId, oa.orderId)).toBe(1);
    expect(await baselineOf(p.db, b.appId, ob.orderId)).toBeNull();
    expect({ money: await moneyOf(b, ob), row: await b.read(ob) }).toEqual(other);
  },
  TIMEOUT,
);
