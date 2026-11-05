// B2-03s · 负结算 ②（FU-NEGATIVE-SETTLE-SNAPSHOT，BR-CALC-02、BR-FUND-07，D10-578）：后到的负结算走 ②，有效 N 为负，
// 版本 +1，B 夹到 0。原基数大于 0 的未入账单走现有 BASE_ZERO（R6）；作废也按新 N 写该版本金额行，B=0、金额全 0，
// R6 不记账（AC-B2-03q#41、AC-B2-03s#40）。原基数已是 0 的单不作废，新行同样夹到 0。已入账单归零走 R8，不在本单。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  moneyRows,
  received,
  settled,
  touched,
  withRule,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each(['WAITING', 'ESTIMATED'] as const)(
  '[AC-B2-03s#17][BR-FUND-07][BR-CALC-15] 负结算首次到达（%s，原基数 1000）：+1，走 BASE_ZERO 作废，不抛错，不写分录，钱包归零',
  async (state) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      if (state === 'ESTIMATED') await w.setConfig(app, 'settle.period_basis.pdd', 'settled_at');
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      expect((await o.row()).rebate_status).toBe(state);

      await o.sync(settled(-100n));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: -100n,
        commission_version: 2,
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
      });
      expect((await moneyRows(p.db, app.appId)).vouchers).toEqual([]);
      expect((await o.wallet()).estimated_total_fen).toBe(0n);
      expect(w.moves()).toEqual([false, true]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#18][BR-FUND-07][BR-CALC-15] 结算由正变负：先 800（v2）再 -100（v3），比的是最新版本的基数，BASE_ZERO 作废',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());

      await o.sync(settled(800n));
      expect(await o.amounts(2)).toEqual([[800n, 400n]]);

      await o.sync(settled(-100n, touched(1)));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: -100n,
        commission_version: 3,
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
      });
      expect((await o.wallet()).estimated_total_fen).toBe(0n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#40][BR-FUND-07][BR-CALC-15] 原基数 1000 的 WAITING 单来负结算：VOID，版本 2 的金额行照写，B=0、金额全 0，n_total 保留 -100，账本与余额不动',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      expect((await o.row()).rebate_status).toBe('WAITING');
      expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
      const moneyBefore = await moneyRows(p.db, app.appId);

      await o.sync(settled(-100n));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: -100n,
        commission_version: 2,
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
      });
      expect(await o.amounts(2)).toEqual([[0n, 0n]]);
      expect(await o.fourAmounts(2)).toEqual({
        n_total_fen: -100n,
        pre_base_deduct_fen: -100n,
        base_fen: 0n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: -100n,
      });
      expect(await moneyRows(p.db, app.appId)).toEqual(moneyBefore);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#19][BR-CALC-02][BR-CALC-27] 原基数已是 0 的单来负结算：+1，新行 B 夹到 0、份额 0，四段金额保留负的 N，订单不作废',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, { commission_fen: 0n, est_commission_fen: 0n });
      await o.sync();
      await o.sync(received());
      expect(await o.amounts(1)).toEqual([[0n, 0n]]);

      await o.sync(settled(-100n));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: -100n,
        commission_version: 2,
        rebate_status: 'WAITING',
        reason: null,
      });
      expect(await o.amounts(2)).toEqual([[0n, 0n]]);
      expect(await o.fourAmounts(2)).toEqual({
        n_total_fen: -100n,
        pre_base_deduct_fen: -100n,
        base_fen: 0n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: -100n,
      });
      expect((await o.wallet()).estimated_total_fen).toBe(0n);
    });
  },
  TIMEOUT,
);
