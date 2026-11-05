// B2-03s · 拼多多缺服务费（B1-08zh，D10-574；BR-CALC-03）：适配器缺费时不给 est（报文 est 为空）。新规则下有效 N 不变，
// 版本不前进，commission_moved 为 false，B1-08zh 的口径不被破坏；费回来之后 est 真变了才 +1。这里从归一后的
// UnionOrder 进流水线（settlement-records 夹具的口径）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, received, settled, touched, withRule } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** 缺服务费的报文：联盟佣金变了，净额算不出来，est 为空。 */
const NO_FEE = { est_commission_fen: null, service_fee_fen: null, commission_fen: 1200n };

it(
  '[AC-B2-03s#22][BR-CALC-03][BR-CALC-15] 未结算的单缺服务费：est 不覆盖、版本不前进、没有新行；费回来且 est 变了才 +1',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();

      await o.sync({ ...touched(1), ...NO_FEE });
      expect(await o.row()).toMatchObject({ est_commission_fen: 1000n, commission_version: 1 });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });

      await o.sync({ ...touched(2), est_commission_fen: 1200n, service_fee_fen: 0n });
      expect(await o.row()).toMatchObject({ est_commission_fen: 1200n, commission_version: 2 });
      expect(await o.amounts(2)).toEqual([[1200n, 600n]]);
      expect(w.moves()).toEqual([false, true]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#23][BR-CALC-03][BR-CALC-15] 已结算的单缺服务费：结算额不动，版本不前进，金额行不变',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));

      await o.sync(settled(null, { ...touched(1), ...NO_FEE }));

      expect(await o.row()).toMatchObject({
        est_commission_fen: 1000n,
        settle_commission_fen: 1000n,
        commission_version: 1,
      });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(w.moves()).toEqual([false, false, false]);
    });
  },
  TIMEOUT,
);
