// B2-04zj · 本缺口的主路径（D10-583 S1）：同步到 SETTLED → 月结账单出候选 → 批次 R5 入账。之前生产一条
// order_settlements 都没有，账单没有候选、R5 按 settlement_changed 跳过，生产入不了账。
// 账单与批次都由 worker 入口装配的 settle 处理器执行，端口全是生产的；手工只有财务确认这一步（kit.ts）。
// 手算：N = 1000，reserve 0，B = 1000，本人 50 % = 500（规则版本见 kit.ts）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BILL_AT, TIMEOUT, brief, received, settled, touched, withWorker } from './kit.ts';

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
  '[AC-B2-04zj#29] 付款 → 收货 → 结算同步后，账单有候选（settle_seq=1，b_settle=1000），批次执行 R5 入账成功：CREDITED、booked 1000、本人到账 500',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      const order = await o.row();
      expect(order).toMatchObject({
        platform_status: 'SETTLED',
        rebate_status: 'WAITING',
        settle_period: '2026-10',
        settle_commission_fen: 1000n,
      });

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.batches(app)).toMatchObject([{ status: 'DRAFT' }]);
      expect(await w.items(app)).toMatchObject([
        { item_type: 'order', order_id: order.order_id, settle_seq: 1, b_settle_fen: 1000n },
      ]);

      await w.confirmAndExecute(app);
      expect(await w.items(app)).toMatchObject([{ result: 'credited', skip_reason: null }]);
      expect(await w.batches(app)).toMatchObject([{ status: 'DONE' }]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
      expect(await w.available(app)).toBe(500n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#30] 首次入库即已结算（P12）的单同样走到入账',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync(settled(1000n));

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toMatchObject([{ settle_seq: 1, b_settle_fen: 1000n }]);
      await w.confirmAndExecute(app);
      expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: 1000n });
      expect(await w.available(app)).toBe(500n);
    });
  },
  TIMEOUT,
);

// 不写就是列为 800 而最新 API 记录仍是 1000（BR-FUND-09），维权回传读不到新记录，B2-04zi 也没有 ADJ:{seq} 的 seq。
// 金额怎么调是 B2-04zi 的，这里不断言凭证与余额。
it(
  '[AC-B2-04zj#33] 已入账（CREDITED）的单联盟再回传内容不同的结算额：照写记录 seq+1，列随之更新',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toMatchObject([{ settle_seq: 1 }]);
      await w.confirmAndExecute(app);
      expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED' });

      await o.sync(settled(800n, touched(1)));
      expect(brief(await o.records())).toEqual([
        [1, 'API', 1000n],
        [2, 'API', 800n],
      ]);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 800n });
    });
  },
  TIMEOUT,
);

// BR-FUND-04 ⑦：批次按校验时的 seq 入账。记录写对了 R5 才拦得住账单之后到的新结算额。
it(
  '[AC-B2-04zj#31] 账单之后联盟结算额又变（seq 2）：批次明细 settlement_changed 跳过，订单留在 WAITING，不入账',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));

      w.clock.set(BILL_AT);
      await w.bill(app);
      expect(await w.items(app)).toMatchObject([{ settle_seq: 1 }]);

      await o.sync(settled(800n, touched(1)));
      expect(brief(await o.records())).toEqual([
        [1, 'API', 1000n],
        [2, 'API', 800n],
      ]);
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
    });
  },
  TIMEOUT,
);
