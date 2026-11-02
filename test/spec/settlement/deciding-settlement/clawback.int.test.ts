// B2-04zp · 入账后等佣金的维权：只有决定金额的那条记录才算回应（BR-FUND-06「等联盟回传新佣金」、BR-FUND-09；
// D10-474 ②）。clawback 现在读 seq 最大的任意来源：STATEMENT 之后收到维权，再来一条 API，维权被当成已回应，
// 而订单金额仍是早于维权的 STATEMENT，联盟的新佣金并没有来。入账前的同一判断（rebate.ts closeAnsweredRights、
// records.ts latestDecidingRecordAt）已是这个口径，这里跟上。
// 金额都是 900，补差为 0：只断言维权是否被回应，结算调整的金额不在本任务。order_rights 行是夹具。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_AT,
  TIMEOUT,
  brief,
  received,
  settled,
  touched,
  withWorker,
} from '../settlement-records/kit.ts';
import { ESTIMATE_900 } from './scenario.ts';

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
  '[AC-B2-04zp#22] 已入账单：STATEMENT 之后收到的等佣金维权不被更晚的 API 回应，保持等待；STATEMENT 之前收到的照常被回应',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const afterStatement = w.order(app, ESTIMATE_900);
      const beforeStatement = w.order(app, ESTIMATE_900);
      for (const o of [afterStatement, beforeStatement]) {
        await o.sync();
        await o.sync(received());
        await o.sync(settled(900n));
      }
      await afterStatement.statement(2, 900n);

      w.clock.set(BILL_AT);
      await w.bill(app);
      await w.confirmAndExecute(app);
      for (const o of [afterStatement, beforeStatement]) {
        expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: 900n });
      }

      const unanswered = await afterStatement.rights('WAIT_COMMISSION', null);
      await afterStatement.markRightsPending();
      const answered = await beforeStatement.rights('WAIT_COMMISSION', null);
      await beforeStatement.markRightsPending();
      w.clock.advanceMs(60_000);
      await beforeStatement.statement(2, 900n);

      await afterStatement.sync(settled(800n, touched(1)));
      await beforeStatement.sync(settled(800n, touched(2)));
      for (const o of [afterStatement, beforeStatement]) {
        expect(brief(await o.records())).toEqual([
          [1, 'API', 900n],
          [2, 'STATEMENT', 900n],
          [3, 'API', 800n],
        ]);
      }

      expect(await afterStatement.rightsRow(unanswered)).toMatchObject({
        status: 'WAIT_COMMISSION',
      });
      expect(await afterStatement.row()).toMatchObject({
        rebate_status: 'CREDITED',
        rights_pending: true,
        settle_commission_fen: 900n,
      });
      expect(await beforeStatement.rightsRow(answered)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await beforeStatement.row()).toMatchObject({
        rebate_status: 'CREDITED',
        rights_pending: false,
        settle_commission_fen: 900n,
      });
    });
  },
  TIMEOUT,
);
