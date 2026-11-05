// B2-03s · 账单比对（BR-FUND-04、BR-CALC-14，D10-578）：账单拿结算换算的 b_settle 与当前版本的 base 比。结算到达推版本后两者
// 相等，单子是候选，不产生差错，批次按结算额入账；不推版本时 v1 的 base 是预估，结算额不等于预估的单都会进差错。
// 账单与批次都由 worker 入口装配的 settle 处理器执行。手算：预留 0、本人 50 %，800 → 400，700 → 350。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { BILL_AT, TIMEOUT, databaseFixture, received, settled, touched, withRule } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03s#24][BR-FUND-04][BR-CALC-15] 结算到达推版本后：b_settle 800 等于当前 base 800，无差错，批次入账 booked 800、本人 400',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(800n));
      const order = await o.row();
      expect(order).toMatchObject({ settle_commission_fen: 800n, commission_version: 2 });
      expect(await o.fourAmounts(2)).toMatchObject({ base_fen: 800n });

      w.clock.set(BILL_AT);
      await w.bill(app);

      expect(await w.items(app)).toMatchObject([
        { item_type: 'order', order_id: order.order_id, settle_seq: 1, b_settle_fen: 800n },
      ]);
      expect(await w.diffs(app)).toEqual([]);

      await w.confirmAndExecute(app);

      expect(await w.items(app)).toMatchObject([{ result: 'credited', skip_reason: null }]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
        commission_version: 2,
      });
      expect(await w.available(app)).toBe(400n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#25][BR-FUND-04][BR-CALC-15] 账单前结算变过两次：比的是最新版本与最新记录，seq 2、b_settle 700，无差错，入账 350',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(800n));
      await o.sync(settled(700n, touched(1)));
      expect((await o.row()).commission_version).toBe(3);

      w.clock.set(BILL_AT);
      await w.bill(app);

      expect(await w.items(app)).toMatchObject([
        { item_type: 'order', settle_seq: 2, b_settle_fen: 700n },
      ]);
      expect(await w.diffs(app)).toEqual([]);

      await w.confirmAndExecute(app);

      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 700n,
        booked_n_fen: 700n,
      });
      expect(await w.available(app)).toBe(350n);
    });
  },
  TIMEOUT,
);
