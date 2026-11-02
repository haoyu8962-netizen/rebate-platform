// B2-04zj · orders.union_settled_at 的写入（BR-FUND-04 ① 返回结算时间时写，⑪ 预计结算月份）。全仓原来没有写者，
// 所有读方都走确认收货月 + 偏移。写入与 orders.settled_at 同处，取报文 settled_at，空值不覆盖。
// 手算：收货在 2026-10，默认偏移 1，推算月份 = 2026-11；联盟结算时间所在月份另算（+08:00）。
// 不写：账单优先 STATEMENT、明细差错单（FU-SETTLE-STATEMENT-IMPORT）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at } from '../../orders/wiring/db-kit.ts';
import {
  SETTLED_AT,
  SETTLED_LATER,
  TIMEOUT,
  brief,
  received,
  settled,
  touched,
  withWorker,
} from './kit.ts';

/** 确认收货月 2026-10 + 默认偏移 1。 */
const FROM_RECEIPT = '2026-11';
/** SETTLED_AT 所在月。 */
const SETTLED_AT_MONTH = '2026-10';
/** 与收货月、推算月份、Clock 所在月都不同的联盟结算时间。 */
const UNION_SETTLED = at('2026-12-02T02:00:00.000Z');
const UNION_MONTH = '2026-12';
const AFTER_UNION_SETTLED = '2026-12-03T02:00:00.000Z';

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
  '[AC-B2-04zj#39] P4：同步到结算写 union_settled_at = 报文结算时间，预计结算月份由推算改为联盟结算时间所在月',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      expect(await o.creditPeriod()).toBe(FROM_RECEIPT);

      w.clock.set(AFTER_UNION_SETTLED);
      await o.sync(settled(1000n, { settled_at: UNION_SETTLED }));
      expect(await o.row()).toMatchObject({
        rebate_status: 'WAITING',
        settled_at: UNION_SETTLED,
        union_settled_at: UNION_SETTLED,
      });
      expect(await o.creditPeriod()).toBe(UNION_MONTH);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#40] P12：首次入库即已结算同样写 union_settled_at，预计结算月份取联盟结算时间所在月',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      w.clock.set(AFTER_UNION_SETTLED);
      await o.sync(settled(1000n, { settled_at: UNION_SETTLED }));
      expect(await o.row()).toMatchObject({
        rebate_status: 'WAITING',
        union_settled_at: UNION_SETTLED,
      });
      expect(await o.creditPeriod()).toBe(UNION_MONTH);
    });
  },
  TIMEOUT,
);

// 记录的 settled_at 会回退到 Clock，这个回退值不能进 union_settled_at：它不是联盟给的结算时间。
it(
  '[AC-B2-04zj#41] 报文没给 settled_at（更新与首次入库两路）：有记录，union_settled_at 不写，走确认收货月 + 偏移',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const existing = w.order(app);
      await existing.sync();
      await existing.sync(received());
      await existing.sync(settled(1000n, { settled_at: null }));
      expect(brief(await existing.records())).toEqual([[1, 'API', 1000n]]);
      expect(await existing.row()).toMatchObject({ union_settled_at: null });
      expect(await existing.creditPeriod()).toBe(FROM_RECEIPT);

      const fresh = w.order(app);
      await fresh.sync(settled(1000n, { settled_at: null }));
      expect(brief(await fresh.records())).toEqual([[1, 'API', 1000n]]);
      expect(await fresh.row()).toMatchObject({ union_settled_at: null });
      expect(await fresh.creditPeriod()).toBe(FROM_RECEIPT);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zj#42] 同 settled_at 的取值规则：后来的报文缺结算时间不清空 union_settled_at，给了新时间才更新',
  async () => {
    await withWorker(db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(await o.row()).toMatchObject({ union_settled_at: SETTLED_AT });

      await o.sync(settled(800n, { settled_at: null, ...touched(1) }));
      expect(await o.row()).toMatchObject({ union_settled_at: SETTLED_AT });

      await o.sync(settled(800n, { settled_at: SETTLED_LATER, ...touched(2) }));
      expect(await o.row()).toMatchObject({ union_settled_at: SETTLED_LATER });
    });
  },
  TIMEOUT,
);

// BR-FUND-04 ①：结算额与结算时间各自有值就写，彼此不是条件。
it(
  '[AC-B2-04zj#43] 报文有结算时间而无结算额：不写记录，union_settled_at 照写，预计结算月份取联盟结算时间所在月',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(null));
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: null,
        union_settled_at: SETTLED_AT,
      });
      expect(await o.records()).toEqual([]);
      expect(await o.creditPeriod()).toBe(SETTLED_AT_MONTH);
    });
  },
  TIMEOUT,
);
