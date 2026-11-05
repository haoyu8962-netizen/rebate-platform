// B2-03s · STATEMENT 与版本（BR-FUND-09，B2-04zj，D10-578）：列 = 最新 STATEMENT，否则最新 API。STATEMENT 已经在列上之后，
// API 记录照写、列不变，有效 N 不变，不 +1；把列改掉的那次同步才 +1，金额行按列上的值，不按报文。STATEMENT 行是
// 夹具（写入归 FU-SETTLE-STATEMENT-IMPORT）。手算：预留 0、本人 50 %，N 900 → B 900 → 450。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, brief, databaseFixture, received, settled, touched, withRule } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03s#20][BR-FUND-09][BR-CALC-15] 同步把列改成 STATEMENT 金额：+1，行按 900；之后的 API 更新只加记录，列不变、版本不变',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      await o.statement(2, 900n);

      await o.sync(settled(800n, touched(1)));
      expect(await o.row()).toMatchObject({
        settle_commission_fen: 900n,
        commission_version: 2,
      });
      expect(await o.amounts(2)).toEqual([[900n, 450n]]);

      await o.sync(settled(700n, touched(2)));
      expect(brief(await o.records())).toEqual([
        [1, 'API', 1000n],
        [2, 'STATEMENT', 900n],
        [3, 'API', 800n],
        [4, 'API', 700n],
      ]);
      expect(await o.row()).toMatchObject({
        settle_commission_fen: 900n,
        commission_version: 2,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect((await o.wallet()).estimated_total_fen).toBe(450n);
      expect(w.moves().slice(-2)).toEqual([true, false]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#21][BR-FUND-09][BR-CALC-15] STATEMENT 先于任何 API 记录：首次到达 +1，行按 STATEMENT 900 不按报文 800；API 同值重放不 +1',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.statement(1, 900n);

      await o.sync(settled(800n));
      expect(await o.row()).toMatchObject({
        settle_commission_fen: 900n,
        commission_version: 2,
      });
      expect(await o.amounts(2)).toEqual([[900n, 450n]]);

      await o.sync(settled(800n, touched(1)));
      expect((await o.row()).commission_version).toBe(2);
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(w.moves().slice(-2)).toEqual([true, false]);
    });
  },
  TIMEOUT,
);
