// B2-03s · 跨 App 不串（规划/02 §19）：同一个 worker 上两个 App 各一单，结算变化只推自己那单的版本，行与钱包各读各的。
// order_keys 的主键是 (platform, sub_order_id)，子订单号跨 App 也不重复，所以两单用不同的号。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, received, settled, touched, withRule } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03s#26][BR-CALC-15] 跨 App 不串：A 的结算变成 800 推到 v2，B 同额的单停在 v1，两边的金额行与钱包互不影响',
  async () => {
    await withRule(p.db, async (w) => {
      const [first, second] = [await w.app(), await w.app()];
      const a = w.order(first);
      const b = w.order(second);
      for (const o of [a, b]) {
        await o.sync();
        await o.sync(received());
        await o.sync(settled(1000n));
      }

      await a.sync(settled(800n, touched(1)));

      expect(await a.row()).toMatchObject({
        app_id: first.appId,
        settle_commission_fen: 800n,
        commission_version: 2,
      });
      expect(await b.row()).toMatchObject({
        app_id: second.appId,
        settle_commission_fen: 1000n,
        commission_version: 1,
      });
      expect(await a.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await b.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(await a.amounts(2)).toEqual([[800n, 400n]]);
      expect((await a.wallet()).estimated_total_fen).toBe(400n);
      expect((await b.wallet()).estimated_total_fen).toBe(500n);
    });
  },
  TIMEOUT,
);
