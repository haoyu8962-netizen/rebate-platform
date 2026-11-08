// B2-04zzf（FU-R9-REFUND-BASELINE，D10-870）：orders 新增可空列 refunded_quantity_r9_baseline（不回填、无默认值），
// 唯一写者是 settlement 的扣回；入库、入账（R5 只定格 refunded_quantity_at_credit）与不触发扣回的同步都不写它。
// 路径：生产装配的 worker（真实同步 → 月度账单 → R5，../credit-refund-baseline/kit.ts，pdd）。
// Task-local AC labels ([AC-B2-04zzf#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  creditedWith,
  databaseFixture,
  settled,
  touched,
  withSync,
} from '../credit-refund-baseline/kit.ts';
import { baselineColumn, baselineOf } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzf#1] orders.refunded_quantity_r9_baseline 是可空 integer、无默认值；入账时已退 1 件只定格 at_credit = 1，基线仍为空，之后不触发扣回的同步也不写它',
  async () => {
    expect(await baselineColumn(p.db)).toEqual([
      { data_type: 'integer', is_nullable: 'YES', column_default: null },
    ]);
    await withSync(p.db, async (w) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 3, refunded_quantity: 1 });
      const credited = await o.row();
      expect(credited).toMatchObject({
        rebate_status: 'CREDITED',
        refunded_quantity: 1,
        refunded_quantity_at_credit: 1,
      });
      expect(await baselineOf(p.db, app.appId, credited.order_id)).toBeNull();

      const before = await read.money();
      await o.sync(settled(1000n, { ...touched(1), refunded_quantity: 1 }));
      expect(await read.money()).toEqual(before);
      expect(await o.row()).toMatchObject({ refunded_quantity: 1, refunded_quantity_at_credit: 1 });
      expect(await baselineOf(p.db, app.appId, credited.order_id)).toBeNull();
    });
  },
  TIMEOUT,
);
