// B2-04zj · 同步路径写结算记录（BR-FUND-01 P4 / P5 / P12、BR-FUND-02、BR-FUND-09；D10-583 S1）。
// 全部走生产 worker 入口的流水线、真实 PostgreSQL，端口不自注入（kit.ts）。
// 每条测试都先要一条记录再看「不写」的情形：现状一条记录都不写，只测「不写」永远是绿的，证明不了什么。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  PDD_UNMAPPED,
  SETTLED_AT,
  SETTLED_LATER,
  RECEIVED_AT,
  TIMEOUT,
  brief,
  received,
  settled,
  touched,
  unattributed,
  withWorker,
} from './kit.ts';

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
  '[AC-B2-04zj#3] P4：SETTLED 报文写一条 source=API、seq=1 的记录，金额与 settled_at 取报文，created_at 取 Clock；列 = 报文金额',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      expect(await o.row()).toMatchObject({
        platform_status: 'RECEIVED',
        rebate_status: 'WAITING',
      });
      await o.sync(settled(1000n));
      const order = await o.row();
      expect(order).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: 1000n,
        settled_at: SETTLED_AT,
      });
      expect(await o.records()).toMatchObject([
        {
          app_id: app.appId,
          order_id: order.order_id,
          seq: 1,
          source: 'API',
          settle_commission_fen: 1000n,
          settled_at: SETTLED_AT,
          content_hash: expect.stringMatching(/./u),
          created_at: w.clock.now(),
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#4] 报文缺 settled_at：沿用订单已有的结算时间（orders.settled_at 不被空值覆盖的现有规则）',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      await o.sync(settled(800n, { settled_at: null, ...touched(1) }));
      expect(await o.records()).toMatchObject([
        { seq: 1, settle_commission_fen: 1000n, settled_at: SETTLED_AT },
        { seq: 2, settle_commission_fen: 800n, settled_at: SETTLED_AT },
      ]);
      expect(await o.row()).toMatchObject({ settled_at: SETTLED_AT });
    });
  },
  TIMEOUT,
);

// order_settlements.settled_at 是 NOT NULL：报文与订单都没有时不能让整单同步回滚，也不能列有值而无记录。
// 08 没写取什么值，取值按编排口径由 #34 钉（报文 → 订单 → Clock）。
it(
  '[AC-B2-04zj#5] P4 报文与订单都没有结算时间：订单照常到 SETTLED、列 = 报文金额，记录照写一条且 settled_at 非空',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n, { settled_at: null }));
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: 1000n,
      });
      const records = await o.records();
      expect(brief(records)).toEqual([[1, 'API', 1000n]]);
      expect(records[0]?.settled_at).toBeInstanceOf(Date);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#6] 同内容重放不加行：报文全同短路；只有修改时间变（走到更新步）也不加行，列不变',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      const first = await o.records();

      expect(await o.report(settled(1000n))).toMatchObject({ kind: 'unchanged' });
      expect(await o.report(settled(1000n, touched(1)))).toMatchObject({ kind: 'updated' });
      expect(await o.records()).toEqual(first);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 1000n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#7] 内容变了 seq+1：金额变、列随之更新；金额不变而结算时间变同样算新记录',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      await o.sync(settled(800n, touched(1)));
      expect(brief(await o.records())).toEqual([
        [1, 'API', 1000n],
        [2, 'API', 800n],
      ]);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 800n });

      await o.sync(settled(800n, { settled_at: SETTLED_LATER, ...touched(2) }));
      expect(await o.records()).toMatchObject([
        { seq: 1, settled_at: SETTLED_AT },
        { seq: 2, settled_at: SETTLED_AT },
        { seq: 3, settle_commission_fen: 800n, settled_at: SETTLED_LATER },
      ]);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 800n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#8] 金额回到旧值也算新记录（A→B→A，F-SET-05）：三行，首尾 content_hash 相同、与中间不同，列回到 A',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      await o.sync(settled(800n, touched(1)));
      await o.sync(settled(1000n, touched(2)));
      const records = await o.records();
      expect(brief(records)).toEqual([
        [1, 'API', 1000n],
        [2, 'API', 800n],
        [3, 'API', 1000n],
      ]);
      expect(records[2]?.content_hash).toBe(records[0]?.content_hash);
      expect(records[1]?.content_hash).not.toBe(records[0]?.content_hash);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 1000n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#9] content_hash 是稳定算法（金额 + 结算时间）：别的订单同金额同时间得同一个值，时间或金额不同则不同',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const one = w.order(app);
      const same = w.order(app);
      const later = w.order(app);
      const less = w.order(app);
      await one.sync(settled(1000n));
      await same.sync(settled(1000n));
      await later.sync(settled(1000n, { settled_at: SETTLED_LATER }));
      await less.sync(settled(999n));
      const hashes = await Promise.all(
        [one, same, later, less].map(async (o) => {
          const records = await o.records();
          expect(records).toHaveLength(1);
          return records[0]?.content_hash;
        }),
      );
      expect(hashes[1]).toBe(hashes[0]);
      expect(hashes[2]).not.toBe(hashes[0]);
      expect(hashes[3]).not.toBe(hashes[0]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#10] P5：PAID 直接到 SETTLED 写记录与列，received_at 取结算时间，同事务补到 WAITING',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(settled(1000n, { received_at: null }));
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        rebate_status: 'WAITING',
        received_at: SETTLED_AT,
        settle_commission_fen: 1000n,
      });
      expect(await o.records()).toMatchObject([
        {
          seq: 1,
          source: 'API',
          settle_commission_fen: 1000n,
          settled_at: SETTLED_AT,
          created_at: w.clock.now(),
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#11] P12：首次入库即已结算写记录与列；收货时间缺时同 P5 取结算时间',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const withReceipt = w.order(app);
      await withReceipt.sync(settled(1000n));
      expect(await withReceipt.row()).toMatchObject({
        platform_status: 'SETTLED',
        rebate_status: 'WAITING',
        received_at: RECEIVED_AT,
        settle_commission_fen: 1000n,
        settled_at: SETTLED_AT,
      });
      expect(await withReceipt.records()).toMatchObject([
        {
          seq: 1,
          source: 'API',
          settle_commission_fen: 1000n,
          settled_at: SETTLED_AT,
          created_at: w.clock.now(),
        },
      ]);

      const withoutReceipt = w.order(app);
      await withoutReceipt.sync(settled(900n, { received_at: null }));
      expect(await withoutReceipt.row()).toMatchObject({
        received_at: SETTLED_AT,
        settle_commission_fen: 900n,
      });
      expect(brief(await withoutReceipt.records())).toEqual([[1, 'API', 900n]]);
    });
  },
  TIMEOUT,
);

// BR-CALC-02「结算收入一旦非空只取结算收入」，planCommissionSnapshot 的入参是写库后的列：P12 写了列，
// 快照就要按它估值，否则同一单列是结算额、基数是预估额，账单比不上。这不是版本推进（B2-03s），是首个版本。
it(
  '[AC-B2-04zj#12] P12 且结算额与预估不同：快照 v1 的基数按结算额（BR-CALC-02），不按预估',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync(settled(800n));
      expect(await o.row()).toMatchObject({
        est_commission_fen: 1000n,
        settle_commission_fen: 800n,
        commission_version: 1,
      });
      expect(await o.totals()).toMatchObject([{ commission_version: 1, base_fen: 800n }]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#13] P12 未归因的单同样写记录与列：结算记录是联盟事实，与用户归属无关',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app(), unattributed());
      await o.sync(settled(1000n));
      expect(await o.row()).toMatchObject({
        user_id: null,
        rebate_status: 'UNATTRIBUTED',
        platform_status: 'SETTLED',
        settle_commission_fen: 1000n,
      });
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#14] 报文无结算额不写记录：已有记录的单不加行、列不动；首次入库即已结算而无结算额的单一条都没有、列为空',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      await o.sync(settled(null, touched(1)));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 1000n });

      const fresh = w.order(app);
      await fresh.sync(settled(null));
      expect(await fresh.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: null,
      });
      expect(await fresh.records()).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#15] 不是 SETTLED 不写：RECEIVED 报文带结算额不写记录也不写列，真到 SETTLED 才写，seq 从 1 起',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received({ settle_commission_fen: 700n }));
      expect(await o.row()).toMatchObject({
        platform_status: 'RECEIVED',
        settle_commission_fen: null,
      });
      expect(await o.records()).toEqual([]);
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
    });
  },
  TIMEOUT,
);

// 判定看迁移之后的状态，不看报文的码：平台说已结算而时间全缺，P5 / P12 都不越过 PAID（BR-FUND-02 R4 守卫）。
it(
  '[AC-B2-04zj#16] 结算报文缺全部时间、迁移后停在 PAID（更新与首次入库两路）：不写记录、不写列；时间到了才写',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const noTime = { received_at: null, settled_at: null };
      const existing = w.order(app);
      await existing.sync();
      await existing.sync(settled(1000n, noTime));
      expect(await existing.row()).toMatchObject({
        platform_status: 'PAID',
        settle_commission_fen: null,
      });
      expect(await existing.records()).toEqual([]);
      await existing.sync(settled(1000n));
      expect(brief(await existing.records())).toEqual([[1, 'API', 1000n]]);

      const fresh = w.order(app);
      await fresh.sync(settled(1000n, noTime));
      expect(await fresh.row()).toMatchObject({
        platform_status: 'PAID',
        settle_commission_fen: null,
      });
      expect(await fresh.records()).toEqual([]);
      await fresh.sync(settled(1000n));
      expect(brief(await fresh.records())).toEqual([[1, 'API', 1000n]]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#17] 整条拒收的报文不落结算记录：SETTLED 后回传 RECEIVED（P10 倒退）带新金额，待处理、不加行、列不动',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      expect(
        await o.report(received({ settle_commission_fen: 800n, ...touched(1) })),
      ).toMatchObject({ kind: 'pending', reason: 'ILLEGAL_TRANSITION' });
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: 1000n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#18] 结算额 0 与负数都是联盟给的已知值，照写记录与列，不当成「报文无结算额」',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const zero = w.order(app);
      await zero.sync();
      await zero.sync(received());
      await zero.sync(settled(0n));
      expect(brief(await zero.records())).toEqual([[1, 'API', 0n]]);
      expect(await zero.row()).toMatchObject({ settle_commission_fen: 0n });

      const negative = w.order(app);
      await negative.sync();
      await negative.sync(received());
      await negative.sync(settled(-50n));
      expect(brief(await negative.records())).toEqual([[1, 'API', -50n]]);
      expect(await negative.row()).toMatchObject({ settle_commission_fen: -50n });
    });
  },
  TIMEOUT,
);

// 编排口径：content_hash 只取报文给的金额和 settled_at 原值（可为空），settled_at 列取报文，再取订单，再取 Clock。
// 回退值进了内容，缺结算时间的单每次只动 mtime 的同步都会 seq+1。
it(
  '[AC-B2-04zj#34] 报文与订单都没有结算时间：记录的 settled_at 取 Clock；同内容重放不加行',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n, { settled_at: null }));
      const stamped = w.clock.now();
      const first = await o.records();
      expect(first).toMatchObject([
        { seq: 1, source: 'API', settle_commission_fen: 1000n, settled_at: stamped },
      ]);

      expect(await o.report(settled(1000n, { settled_at: null, ...touched(1) }))).toMatchObject({
        kind: 'updated',
      });
      expect(await o.records()).toEqual(first);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 1000n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#35] 报文缺 settled_at 而订单有：记录沿用订单的结算时间，同内容重放不加行',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      await o.sync(settled(800n, { settled_at: null, ...touched(1) }));
      const first = await o.records();
      expect(first).toMatchObject([
        { seq: 1, settle_commission_fen: 1000n, settled_at: SETTLED_AT },
        { seq: 2, settle_commission_fen: 800n, settled_at: SETTLED_AT },
      ]);

      expect(await o.report(settled(800n, { settled_at: null, ...touched(2) }))).toMatchObject({
        kind: 'updated',
      });
      expect(await o.records()).toEqual(first);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#36] P12 有收货时间、报文与订单都没有结算时间：不因 NOT NULL 回滚，记录的 settled_at 取 Clock；同内容重放不加行',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync(settled(1000n, { settled_at: null }));
      const stamped = w.clock.now();
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        received_at: RECEIVED_AT,
        settle_commission_fen: 1000n,
      });
      const first = await o.records();
      expect(first).toMatchObject([
        {
          seq: 1,
          source: 'API',
          settle_commission_fen: 1000n,
          settled_at: stamped,
          created_at: stamped,
        },
      ]);

      expect(await o.report(settled(1000n, { settled_at: null, ...touched(1) }))).toMatchObject({
        kind: 'updated',
      });
      expect(await o.records()).toEqual(first);
    });
  },
  TIMEOUT,
);

// 回退到订单的单也能过 #35 的重放，所以这里直接比 hash：a 回退 Clock，b 回退订单，内容都是（1000，空）。
it(
  '[AC-B2-04zj#37] content_hash 不含回退值：报文缺 settled_at 的同金额记录 hash 相同，与带结算时间的记录不同',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const fromClock = w.order(app);
      await fromClock.sync();
      await fromClock.sync(received());
      await fromClock.sync(settled(1000n, { settled_at: null }));

      const fromOrder = w.order(app);
      await fromOrder.sync();
      await fromOrder.sync(received());
      await fromOrder.sync(settled(900n));
      await fromOrder.sync(settled(1000n, { settled_at: null, ...touched(1) }));

      const stated = w.order(app);
      await stated.sync();
      await stated.sync(received());
      await stated.sync(settled(1000n));

      const [clockRecords, orderRecords, statedRecords] = [
        await fromClock.records(),
        await fromOrder.records(),
        await stated.records(),
      ];
      expect(brief(clockRecords)).toEqual([[1, 'API', 1000n]]);
      expect(brief(orderRecords)).toEqual([
        [1, 'API', 900n],
        [2, 'API', 1000n],
      ]);
      expect(brief(statedRecords)).toEqual([[1, 'API', 1000n]]);
      expect(orderRecords[1]?.content_hash).toBe(clockRecords[0]?.content_hash);
      expect(statedRecords[0]?.content_hash).not.toBe(clockRecords[0]?.content_hash);
    });
  },
  TIMEOUT,
);

// 编排口径：记录写入条件看 planOrderSyncColumns 写了列没有，不看事件名。只看 PLATFORM_SETTLED 事件，
// 这里列是 800、最新 API 记录还是 1000，与 BR-FUND-09 不符。整条拒收的情形见 #17。
it(
  '[AC-B2-04zj#38] SETTLED 单收到表外码且带结算额：列照写，记录也写，列 = 最新 API 记录',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);

      expect(
        await o.report(settled(800n, { raw_status: PDD_UNMAPPED, ...touched(1) })),
      ).toMatchObject({ kind: 'updated' });
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: 800n,
      });
      expect(brief(await o.records())).toEqual([
        [1, 'API', 1000n],
        [2, 'API', 800n],
      ]);
    });
  },
  TIMEOUT,
);
