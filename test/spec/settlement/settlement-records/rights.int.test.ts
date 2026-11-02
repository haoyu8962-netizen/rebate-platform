// B2-04zj · closeAnsweredRights 读到本次记录（BR-FUND-06、BR-FUND-08 ①；D10-474 ①、D10-483）。
// 写记录排在 rebate.onUpdated 之前：rebate 关闭维权时读的「最新结算记录」就是本次写的那行。排反了，
// 首条结算记录读不到（before 为空直接返回），在结算前收到的维权就被 R5 再扣一遍。
// order_rights 行是夹具，形状同维权命令写下的（B2-04l）；结算到达走生产流水线。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  '[AC-B2-04zj#27] 结算前收到的维权被首条结算记录吸收：已成功的应扣记 answered_at = Clock；等佣金的关闭，rights_pending 复位',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      const deducted = await o.rights('SUCCEEDED', 200n);
      const waiting = await o.rights('WAIT_COMMISSION', null);
      await o.markRightsPending();

      await o.sync(settled(800n));
      expect(brief(await o.records())).toEqual([[1, 'API', 800n]]);
      expect(await o.rightsRow(deducted)).toEqual({
        status: 'SUCCEEDED',
        answered_at: w.clock.now(),
      });
      expect(await o.rightsRow(waiting)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await o.row()).toMatchObject({ rights_pending: false, rebate_status: 'WAITING' });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#28] 结算之后才收到的维权：同内容重放不新增记录，不被旧记录吸收；联盟下一条内容不同的记录才吸收',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);

      const late = await o.rights('SUCCEEDED', 100n);
      await o.sync(settled(1000n, touched(1)));
      expect(brief(await o.records())).toEqual([[1, 'API', 1000n]]);
      expect(await o.rightsRow(late)).toEqual({ status: 'SUCCEEDED', answered_at: null });

      await o.sync(settled(900n, touched(2)));
      expect(brief(await o.records())).toEqual([
        [1, 'API', 1000n],
        [2, 'API', 900n],
      ]);
      expect(await o.rightsRow(late)).toEqual({
        status: 'SUCCEEDED',
        answered_at: w.clock.now(),
      });
    });
  },
  TIMEOUT,
);
