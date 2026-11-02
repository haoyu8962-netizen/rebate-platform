// B2-04zj · 已有 STATEMENT 时 API 不覆盖（BR-FUND-09：orders.settle_commission_fen = 最新 STATEMENT 记录的
// 金额，无 STATEMENT 时取最新 API 记录）。STATEMENT 行是夹具：写入归 FU-SETTLE-STATEMENT-IMPORT，本任务只读。
// 记录与列都按序列比对，API 与明细不一致的差错单不在本任务。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at } from '../../orders/wiring/db-kit.ts';
import { TIMEOUT, brief, received, settled, touched, withWorker } from './kit.ts';

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
  '[AC-B2-04zj#19] 已有 STATEMENT 行：API 记录照写（seq+1、source=API），列 = STATEMENT 金额，不被 API 覆盖',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      await o.statement(2, 900n);
      await o.sync(settled(800n, touched(1)));
      expect(brief(await o.records())).toEqual([
        [1, 'API', 1000n],
        [2, 'STATEMENT', 900n],
        [3, 'API', 800n],
      ]);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 900n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#20] STATEMENT 先于任何 API 记录：首条 API 接在它后面（seq=2），列从空写成 STATEMENT 金额，不写报文金额',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.statement(1, 900n);
      await o.sync(settled(800n));
      expect(brief(await o.records())).toEqual([
        [1, 'STATEMENT', 900n],
        [2, 'API', 800n],
      ]);
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: 900n,
      });
    });
  },
  TIMEOUT,
);

// 内容只与最新的 API 记录比，STATEMENT 行不参与。和 seq 最大的任意来源行比，这里就会多出 [3 API 1000]：
// 内容没变，新的 created_at 却把结算之后才收到的应扣记成已答，R5 少扣；按 seq 2 校验过的批次也被跳过。
it(
  '[AC-B2-04zj#32] 已有 STATEMENT 时同内容 API 重放：与最新 API 记录比，不加行；列 = STATEMENT 金额；未被回传的应扣保持未答',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      await o.statement(2, 900n);
      const open = await o.rights('SUCCEEDED', 100n);
      const before = await o.records();

      expect(await o.report(settled(1000n, touched(1)))).toMatchObject({ kind: 'updated' });
      expect(await o.records()).toEqual(before);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 900n });
      expect(await o.rightsRow(open)).toEqual({ status: 'SUCCEEDED', answered_at: null });
    });
  },
  TIMEOUT,
);

// 三行的金额与时间都错开：取最大金额、最小金额、最新 created_at 都得不到 700，只有 seq 最大能得到。
it(
  '[AC-B2-04zj#21] 最新 STATEMENT 取 seq 最大，不看金额大小与 created_at 先后',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.statement(1, 650n, at('2026-10-21T12:00:00.000Z'));
      await o.statement(2, 900n, at('2026-10-21T14:00:00.000Z'));
      await o.statement(3, 700n, at('2026-10-21T13:00:00.000Z'));
      await o.sync(settled(800n));
      expect(brief(await o.records())).toEqual([
        [1, 'STATEMENT', 650n],
        [2, 'STATEMENT', 900n],
        [3, 'STATEMENT', 700n],
        [4, 'API', 800n],
      ]);
      expect(await o.row()).toMatchObject({ settle_commission_fen: 700n });
    });
  },
  TIMEOUT,
);
