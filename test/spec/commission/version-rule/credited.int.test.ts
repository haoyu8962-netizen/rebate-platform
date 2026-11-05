// B2-03s · 已入账单（BR-CALC-23 (a)、迁移 R10 的金额行半边，FU-CREDITED-AMOUNT-ROWS，D10-578）：订单先经真实账单与批次
// 入账（booked 1000，本人 500），之后联盟结算额变化：版本 +1，新行等于 BR-CALC-23 (a) 的新应得（不是复制上一版本），
// 入账金额、分录、余额都不动。调整本身（SETTLE_ADJUST、补差候选）在 B2-04zi，这里不断言。手算：预留 0、本人 50 %，
// 结算 800 → 400，1200 → 600，1001 → 500（基数变了，份额向下取整后没变，新版本照写）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, moneyRows, settled, touched, withRule } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each([
  [800n, 400n],
  [1200n, 600n],
  [1001n, 500n],
])(
  '[AC-B2-03s#14][BR-CALC-23][BR-CALC-15] R10：已入账单结算额变成 %s：版本 +1，新行等于新应得 %s，不是复制；booked、分录、余额不动',
  async (settleFen, shareFen) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      const money = await moneyRows(p.db, app.appId);

      await o.sync(settled(settleFen, touched(1)));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: settleFen,
        commission_version: 2,
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
      expect(await o.amounts(2)).toEqual([[settleFen, shareFen]]);
      expect(await o.fourAmounts(2)).toEqual({
        n_total_fen: settleFen,
        pre_base_deduct_fen: 0n,
        base_fen: settleFen,
        user_share_total_fen: shareFen,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: settleFen - shareFen,
      });
      expect(await moneyRows(p.db, app.appId)).toEqual(money);
      expect(await w.available(app)).toBe(500n);
      expect(w.moves().at(-1)).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#15][BR-CALC-15] R10 同值重放：不再推版本，新行只写一次；再变才到 v3，行按再变后的 N',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      const money = await moneyRows(p.db, app.appId);

      await o.sync(settled(800n, touched(1)));
      expect((await o.row()).commission_version).toBe(2);
      await o.sync(settled(800n, touched(2)));
      expect((await o.row()).commission_version).toBe(2);
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });

      await o.sync(settled(700n, touched(3)));
      expect((await o.row()).commission_version).toBe(3);
      expect(await o.amounts(3)).toEqual([[700n, 350n]]);
      expect(await moneyRows(p.db, app.appId)).toEqual(money);
      expect(w.moves().slice(-3)).toEqual([true, false, true]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#16][BR-CALC-15][BR-CALC-23] 已入账单结算记录没变、只有预估变：不推版本，没有新行，est 存档，booked、分录、余额不动',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      const money = await moneyRows(p.db, app.appId);

      await o.sync(settled(null, { ...touched(1), est_commission_fen: 2000n }));

      expect(await o.row()).toMatchObject({
        est_commission_fen: 2000n,
        settle_commission_fen: 1000n,
        commission_version: 1,
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(await moneyRows(p.db, app.appId)).toEqual(money);
      expect(w.moves().at(-1)).toBe(false);
    });
  },
  TIMEOUT,
);
