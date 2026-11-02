// B2-03r · commission 估值端口 refresh 的第三参 { commissionFen }（编排方案 C）：给了就按它写当前版本的行，
// 不给时行为不变（仍按订单列）；refresh 不自己读未关闭应扣：同步路径上 refresh 先于 closeAnsweredRights，读了就重复扣。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, amountsAt, databaseFixture, harness, totalsAt } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03r#22] refresh 带 { commissionFen: 600 } 按 600 写当前版本（510 → 255 / 51 / 25）；不带时同样推过版本的单按列 1000 写（850）；带 open 记录也不自己减：不带第三参的单有 SUCCEEDED 400 时仍是 850；同一版本重投不改已写的行',
  async () => {
    const h = await harness(p.db);
    const given = await h.estimated();
    const columns = await h.estimated();
    await h.rightsRow(columns, { deductionFen: 400n });
    await h.db
      .updateTable('orders')
      .set({ commission_version: 2 })
      .where('app_id', '=', h.appId)
      .where('order_id', 'in', [given.orderId, columns.orderId])
      .execute();

    await h.db.transaction().execute(async (trx) => {
      await h.real.refresh(trx, h.ref(given), { commissionFen: 600n });
      await h.real.refresh(trx, h.ref(columns));
    });

    expect(await amountsAt(p.db, given, 2)).toEqual([
      ['self', 510n, 255n],
      ['direct', 510n, 51n],
      ['indirect', 510n, 25n],
    ]);
    expect(await totalsAt(p.db, given, 2)).toMatchObject({ n_total_fen: 600n, base_fen: 510n });
    expect(await amountsAt(p.db, columns, 2)).toEqual([
      ['self', 850n, 425n],
      ['direct', 850n, 85n],
      ['indirect', 850n, 42n],
    ]);

    await h.db.transaction().execute(async (trx) => {
      await h.real.refresh(trx, h.ref(given), { commissionFen: 500n });
    });

    expect(await totalsAt(p.db, given, 2)).toMatchObject({ n_total_fen: 600n, base_fen: 510n });
  },
  TIMEOUT,
);
