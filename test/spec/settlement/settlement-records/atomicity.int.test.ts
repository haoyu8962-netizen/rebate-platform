// B2-04zj · 写记录与状态迁移同事务、订单锁内取 seq、跨 App 不串（02 §18；orders / settlement AGENTS.md）。
// 故障用生产总线上的一次发布失败注入：order.updated / order.created 排在写记录之后，端口若不在调用方事务里，
// 这里就会留下一行孤儿记录。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TIMEOUT, brief, capture, received, settled, touched, withWorker } from './kit.ts';

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
  '[AC-B2-04zj#22] 更新路径后面失败：状态迁移、列、结算记录一起回滚；重投后恰好一行，seq=1',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic bus failure');
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.updated') throw failure;
        return publish(trx, event);
      });
      expect(await capture(() => o.report(settled(1000n)))).toEqual({ ok: false, error: failure });
      expect(await o.row()).toMatchObject({
        platform_status: 'RECEIVED',
        settle_commission_fen: null,
      });
      expect(await o.records()).toEqual([]);
      bus.mockRestore();

      await o.sync(settled(1000n));
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: 1000n,
      });
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#23] 首次入库（P12）后面失败：订单行与结算记录一起回滚；重投后恰好一行，seq=1',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic bus failure');
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.created') throw failure;
        return publish(trx, event);
      });
      expect(await capture(() => o.report(settled(1000n)))).toEqual({ ok: false, error: failure });
      expect(await o.rowsOf()).toEqual([]);
      bus.mockRestore();

      await o.sync(settled(1000n));
      expect(await o.row()).toMatchObject({ settle_commission_fen: 1000n });
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#24] 同一订单并发两条内容不同的结算报文：在订单锁内取 seq，两行 seq 连续不撞主键，列 = seq 最大那行的金额',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      const results = await Promise.all([
        capture(() => o.report(settled(900n, touched(1)))),
        capture(() => o.report(settled(800n, touched(2)))),
      ]);
      expect(results).toMatchObject([{ ok: true }, { ok: true }]);
      const records = await o.records();
      expect(records.map((row) => [row.seq, row.source])).toEqual([
        [1, 'API'],
        [2, 'API'],
      ]);
      expect(records.map((row) => row.settle_commission_fen).toSorted()).toEqual([800n, 900n]);
      expect(await o.row()).toMatchObject({
        settle_commission_fen: records[1]?.settle_commission_fen,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#25] 跨 App 不串：seq 按订单走，另一 App 的单从 1 起；行上是各自的 app_id 与金额',
  async () => {
    await withWorker(db, async (w) => {
      const [first, second] = [await w.app(), await w.app()];
      const a = w.order(first);
      const b = w.order(second);
      await a.sync(settled(1000n));
      await a.sync(settled(800n, touched(1)));
      await b.sync(settled(700n));
      expect(await a.records()).toMatchObject([
        { app_id: first.appId, seq: 1, settle_commission_fen: 1000n },
        { app_id: first.appId, seq: 2, settle_commission_fen: 800n },
      ]);
      expect(await b.records()).toMatchObject([
        { app_id: second.appId, seq: 1, settle_commission_fen: 700n },
      ]);
      expect(await a.row()).toMatchObject({ settle_commission_fen: 800n });
      expect(await b.row()).toMatchObject({ settle_commission_fen: 700n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#26] 子订单属于别的 App（BR-ATTR-22）：app_conflict，对方的记录与列不动，本 App 不写',
  async () => {
    await withWorker(db, async (w) => {
      const [owner, intruder] = [await w.app(), await w.app()];
      const o = w.order(owner);
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      const same = w.order(intruder, { sub_order_id: o.subOrderId });
      expect(await same.report(settled(800n, touched(1)))).toMatchObject({ kind: 'app_conflict' });
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 1000n });
      expect(await same.records()).toEqual([]);
      expect(await same.rowsOf()).toEqual([]);
    });
  },
  TIMEOUT,
);
