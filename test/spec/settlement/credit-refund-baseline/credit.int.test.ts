// B1-08zi（D10-814 ④，BR-FUND-05 / BR-FUND-01 R5 / R9）：refunded_quantity_at_credit 只在入账（R5 的
// casCreditOrder）定格为当时的 refunded_quantity，之后任何路径（同步、R9 扣回、再同步）都不推进它；
// 入账后同步写入的已退件数增加，同一事务里的 R9 判定就能读到（不需要另外播种 orders 列）。
// 平台 pdd（kit 说明）：已退件数的开关只挂京东，pdd 的增加照现行 R9（B2-04zi#5 同口径）。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
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
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B1-08zi#19] 入账时已退 1 件：R5 同一次写入把 refunded_quantity_at_credit 定格为 1，件数两列不变',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, beforeCredit } = await creditedWith(p.db, w, {
        quantity: 3,
        refunded_quantity: 1,
      });
      expect(beforeCredit).toMatchObject({
        quantity: 3,
        refunded_quantity: 1,
        refunded_quantity_at_credit: null,
      });
      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        quantity: 3,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 1,
      });
      expect(row.credited_at).not.toBeNull();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#20] 入账时未退：定格为 0；入账时两列为空（报文从未给）：定格为空',
  async () => {
    await withSync(p.db, async (w) => {
      const zero = await creditedWith(p.db, w, { quantity: 2, refunded_quantity: 0 });
      expect(await zero.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        refunded_quantity: 0,
        refunded_quantity_at_credit: 0,
      });
      const none = await creditedWith(p.db, w, {});
      expect(await none.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        quantity: null,
        refunded_quantity: null,
        refunded_quantity_at_credit: null,
      });
      // 对照：定格写在入账那一次，不是首次入库。
      expect(zero.beforeCredit).toMatchObject({
        refunded_quantity: 0,
        refunded_quantity_at_credit: null,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#21] 入账后已退件数 1→2、再缺失、再变小：at_credit 始终是 1，commission_version 不动',
  async () => {
    await withSync(p.db, async (w) => {
      const { o } = await creditedWith(p.db, w, { quantity: 3, refunded_quantity: 1 });
      const credited = await o.row();
      expect(credited.refunded_quantity_at_credit).toBe(1);

      await o.sync(settled(1000n, { ...touched(1), refunded_quantity: 2 }));
      expect(await o.row()).toMatchObject({
        refunded_quantity: 2,
        refunded_quantity_at_credit: 1,
        commission_version: credited.commission_version,
      });

      await o.sync(settled(1000n, { ...touched(2), refunded_quantity: null }));
      await o.sync(settled(1000n, { ...touched(3), refunded_quantity: 1 }));
      expect(await o.row()).toMatchObject({
        quantity: 3,
        refunded_quantity: 2,
        refunded_quantity_at_credit: 1,
        commission_version: credited.commission_version,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#22] 入账后同步报文带来已退件数增加与新结算 600：同一事务 R9 按 600 扣回，不走 R10；at_credit 不推进',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      await o.sync(settled(600n, { ...touched(1), refunded_quantity: 1 }));
      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
        quantity: 4,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
      });
      const lines = (await read.lines()).filter((l) => l.ledger_type === 'CLAWBACK');
      expect(lines.map((l) => `${l.subject}|${l.amount_fen}`).sort()).toEqual(
        [
          'USER_BALANCE|200',
          'COMMISSION_REVENUE|200',
          'UNION_RECEIVABLE:pdd|-200',
          'UNION_RECEIVABLE:pdd|-200',
        ].sort(),
      );
      expect([...new Set(lines.map((l) => l.uniq_key))].sort()).toEqual(
        [
          `${read.orderRef}:${row.user_id}:${MEMBER_ROLE}:CLAWBACK:C${row.commission_version}`,
          `${read.orderRef}:PLATFORM:CLAWBACK:C${row.commission_version}`,
        ].sort(),
      );
      expect((await read.lines()).filter((l) => l.ledger_type === 'SETTLE_ADJUST')).toEqual([]);
      await read.balanced();
    });
  },
  TIMEOUT,
);
