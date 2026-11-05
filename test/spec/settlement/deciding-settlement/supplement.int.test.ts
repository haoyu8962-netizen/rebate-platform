// B2-04zp · 补差（bill/supplement）与账单同一口径（BR-FUND-09，D10-588 ⑤）。场景：账单日这单还没有结算
// 数据（settle_missing），结算记录账单日之后才到，finance 发起补差。批次仍由 worker 的 settle 处理器执行。
// 命令的接线见 ./scenario.ts。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BILL_AT, TIMEOUT, received, withWorker } from '../settlement-records/kit.ts';
import { BILL_MONTH, ESTIMATE_900, launch, reconDiffs, statementBetweenApi } from './scenario.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it(
  '[AC-B2-04zp#17] 补差同一口径：STATEMENT 900、之后 API 1000，按 900 比对入补充批次，settle_seq 3，R5 按 900 入账',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app, ESTIMATE_900);
      await o.sync();
      await o.sync(received());
      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toEqual([]);

      await statementBetweenApi(o);
      const order = await o.row();
      const result = await launch(db, w, app);
      expect(result).toMatchObject({ outcome: 'generated', billId: BILL_MONTH });
      expect(result.batchIds).toHaveLength(1);
      expect(await w.items(app)).toMatchObject([
        { item_type: 'order', order_id: order.order_id, settle_seq: 3, b_settle_fen: 900n },
      ]);
      expect((await reconDiffs(db, app)).map((diff) => diff.type)).toEqual(['settle_missing']);

      await w.confirmAndExecute(app);
      expect(await w.items(app)).toMatchObject([{ result: 'credited', skip_reason: null }]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 900n,
        booked_n_fen: 900n,
      });
      expect(await w.available(app)).toBe(450n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zp#18] 补差：付款时预估 1000，账单日应结未结，之后 API 950 → STATEMENT 900 → API 1000：基数已随结算推到 900，按 900 进补充批次（settle_seq 3），不登记 settle_amount_mismatch，不被 API 1000 蒙混过关；R5 按 900 入账',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      w.clock.set(BILL_AT);
      await w.bill(app);

      await statementBetweenApi(o);
      const result = await launch(db, w, app);
      expect(result).toMatchObject({
        outcome: 'generated',
        billId: BILL_MONTH,
        batchIds: [expect.any(String)],
      });
      expect(await w.items(app)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 3, b_settle_fen: 900n }),
      ]);
      const mismatches = (await reconDiffs(db, app)).filter(
        (diff) => diff.type === 'settle_amount_mismatch',
      );
      expect(mismatches).toEqual([]);
      expect((await reconDiffs(db, app)).map((diff) => diff.type)).toEqual(['settle_missing']);

      await w.confirmAndExecute(app);
      expect(await w.items(app)).toMatchObject([{ result: 'credited', skip_reason: null }]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 900n,
        booked_n_fen: 900n,
      });
      expect(await w.available(app)).toBe(450n);
    });
  },
  TIMEOUT,
);

// 受益人补记（R5a）与 R5 是同一条 seq 校验：seq 取成决定金额那条的话，补记项执行时被跳过。义务行是夹具。
it(
  '[AC-B2-04zp#19] 已入账单的受益人补记项：settle_seq 同样是整单最大 seq，不是决定金额那条的 seq',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app, ESTIMATE_900);
      await o.sync();
      await o.sync(received());
      await statementBetweenApi(o);
      w.clock.set(BILL_AT);
      await w.bill(app);
      await w.confirmAndExecute(app);
      const order = await o.row();
      expect(order).toMatchObject({ rebate_status: 'CREDITED' });

      const now = w.clock.now();
      await db
        .insertInto('beneficiary_credits')
        .values({
          beneficiary_credit_id: randomUUID(),
          app_id: app.appId,
          order_id: order.order_id,
          user_id: app.userId,
          role: 'self',
          kind: 'first_credit',
          opened_by: 'R5',
          opened_ref: 'synthetic-credit',
          split_ref: 'synthetic-attribution-v1',
          status: 'open',
          opened_at: now,
          created_at: now,
        })
        .execute();

      const result = await launch(db, w, app);
      expect(result.batchIds).toHaveLength(1);
      const items = (await w.items(app)).filter((item) => item.item_type === 'beneficiary');
      expect(items).toMatchObject([
        { order_id: order.order_id, settle_seq: 3, b_settle_fen: null },
      ]);
    });
  },
  TIMEOUT,
);
