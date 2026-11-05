// B2-04zp · 账单与 R5 取结算额同一口径（BR-FUND-09，D10-588 ⑤）。之前账单取截点内任意来源的最大 seq，
// R5 读列（STATEMENT 优先）：STATEMENT 900、之后 API 1000 时账单按 1000 比对，R5 按 900 入账。
// 账单与批次都由生产 worker 入口装配的 settle 处理器执行（../settlement-records/kit.ts）。
// #15、#16 是现有行为的回归，改动前后断言都成立，所以它们最后调一次 decidingSettlement：账单用的金额
// 就是它算出的那条，骨架上红在这一句的 NotImplemented。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at } from '../../orders/wiring/db-kit.ts';
import {
  BILL_AT,
  TIMEOUT,
  brief,
  received,
  settled,
  touched,
  withWorker,
} from '../settlement-records/kit.ts';
import {
  BILL_MONTH,
  ESTIMATE_900,
  decidedAt,
  reconDiffs,
  statementBetweenApi,
} from './scenario.ts';

/** BILL_AT 之后一小时：账单开始时刻看不到这时取得的记录。 */
const AFTER_CUTOFF = '2026-11-24T03:00:00.000Z';

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

function billTotals(appId: string) {
  return db
    .selectFrom('settle_bills')
    .select([
      'platform_settle_commission_totals',
      'beneficiary_total_fen',
      'platform_retained_fen',
      'error_count',
    ])
    .where('app_id', '=', appId)
    .where('bill_id', '=', BILL_MONTH)
    .executeTakeFirstOrThrow();
}

it(
  '[AC-B2-04zp#11] STATEMENT 900、之后 API 1000：账单按 900 比对入批（基数 900 相符，不出差错单），合计也是 900，R5 按 900 入账',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app, ESTIMATE_900);
      await o.sync();
      await o.sync(received());
      await statementBetweenApi(o);
      const order = await o.row();

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await reconDiffs(db, app)).toEqual([]);
      expect(await w.items(app)).toMatchObject([
        { item_type: 'order', order_id: order.order_id, b_settle_fen: 900n },
      ]);
      expect(await billTotals(app.appId)).toMatchObject({
        platform_settle_commission_totals: { pdd: '900' },
        beneficiary_total_fen: 450n,
        platform_retained_fen: 450n,
        error_count: 0,
      });

      await w.confirmAndExecute(app);
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
  '[AC-B2-04zp#12] 付款时预估 1000，API 950 → STATEMENT 900 → API 1000：结算到达和变化都推版本（BR-CALC-15，D10-578 ②），出账时基数 900，账单按 STATEMENT 900 入批（settle_seq 3），不登记 settle_amount_mismatch，不被 API 1000 蒙混过关；R5 按 900 入账',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await statementBetweenApi(o);

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 3, b_settle_fen: 900n }),
      ]);
      expect(await reconDiffs(db, app)).toEqual([]);
      expect(await billTotals(app.appId)).toMatchObject({
        platform_settle_commission_totals: { pdd: '900' },
        beneficiary_total_fen: 450n,
        platform_retained_fen: 450n,
        error_count: 0,
      });
      expect(await o.row()).toMatchObject({ rebate_status: 'WAITING', booked_n_fen: null });

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
  '[AC-B2-04zp#13] 批次 settle_seq 是整单最大 seq 而不是决定金额那条的 seq，R5 的 seq 校验通过，真的入账',
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
      expect(await w.items(app)).toMatchObject([{ settle_seq: 3, b_settle_fen: 900n }]);

      await w.confirmAndExecute(app);
      expect(await w.items(app)).toMatchObject([{ result: 'credited', skip_reason: null }]);
      expect(await w.batches(app)).toMatchObject([{ status: 'DONE' }]);
      expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED' });
    });
  },
  TIMEOUT,
);

// 与 #13 互补：决定金额的是两条 STATEMENT 里新的那条，整单最大 seq 在它之后隔了两条 API。
it(
  '[AC-B2-04zp#14] 两条 STATEMENT 之后又有两条 API：金额取 seq 2 的 900，settle_seq 取 4，入账 900',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app, ESTIMATE_900);
      await o.sync();
      await o.sync(received());
      await o.statement(1, 800n);
      await o.statement(2, 900n);
      await o.sync(settled(1000n));
      await o.sync(settled(1100n, touched(1)));
      expect(brief(await o.records())).toEqual([
        [1, 'STATEMENT', 800n],
        [2, 'STATEMENT', 900n],
        [3, 'API', 1000n],
        [4, 'API', 1100n],
      ]);

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toMatchObject([{ settle_seq: 4, b_settle_fen: 900n }]);

      await w.confirmAndExecute(app);
      expect(await w.items(app)).toMatchObject([{ result: 'credited', skip_reason: null }]);
      expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: 900n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zp#15] 回归：只有 API 行时取最大 seq：settle_seq 2、b_settle 1000、入账 1000，与之前完全一致',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(950n));
      await o.sync(settled(1000n, touched(1)));

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toMatchObject([{ settle_seq: 2, b_settle_fen: 1000n }]);
      expect(await billTotals(app.appId)).toMatchObject({
        platform_settle_commission_totals: { pdd: '1000' },
      });

      await w.confirmAndExecute(app);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
      expect(await w.available(app)).toBe(500n);
      expect(await decidedAt(o, BILL_AT)).toEqual([2, 'API', 1000n]);
    });
  },
  TIMEOUT,
);

// STATEMENT 行在账单读来源时已在库里，只是取得时间晚于账单开始时刻：截点过滤不到位就会把它当金额。
it(
  '[AC-B2-04zp#16] STATEMENT 晚于截点、API 在截点内：账单按 API；R5 见 seq 变了，settlement_changed 跳过，不报错不入账',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      await o.statement(2, 900n, at(AFTER_CUTOFF));

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toMatchObject([{ settle_seq: 1, b_settle_fen: 1000n }]);

      await w.confirmAndExecute(app);
      expect(await w.items(app)).toMatchObject([
        { result: 'skipped', skip_reason: 'settlement_changed' },
      ]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'WAITING',
        booked_base_fen: null,
        booked_n_fen: null,
      });
      expect(await w.available(app)).toBe(0n);
      expect(await decidedAt(o, BILL_AT)).toEqual([1, 'API', 1000n]);
      expect(await decidedAt(o, AFTER_CUTOFF)).toEqual([2, 'STATEMENT', 900n]);
    });
  },
  TIMEOUT,
);
