// B2-19 · 拼多多结算佣金经订单同步落库（BR-FUND-02 细则「京东、拼多多已结算时的结算佣金」第 2、3 点；BR-FUND-09）。
// 每次报文都先过生产映射 mapPddOrder（./kit.ts mappedReport），再进真实 worker 入口装配的订单同步流水线
// （../../settlement/settlement-records/kit.ts，只读复用；结算记录由现有 recordApi 写）。测试自己不填结算佣金。
// - 状态 3（审核成功）只写预估、不写结算记录；变为 5 后 orders.settle_commission_fen 与 order_settlements 一条
//   source=API、seq=1、金额 = promotion_amount − duo_id_service_fee，settled_at 取 order_settle_time；
// - 已结算之后不锁定：状态仍 5、promotion_amount 变了 → 追加 seq=2，旧记录不改；金额与 settled_at 都不变的
//   重复同步不追加。入账后 R9 / R10 的分路由 settlement 承担，不在本单，这里不断言。
// 手算：1000 − 100 = 900；1200 − 120 = 1080。credit.enabled.pdd 不开，订单停在 WAITING。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  RECEIVED_AT,
  SETTLED_AT,
  TIMEOUT,
  brief,
  withWorker,
} from '../../settlement/settlement-records/kit.ts';
import { at } from '../wiring/db-kit.ts';
import {
  CHANGED_NET_FEN,
  CHANGED_PROMOTION_AMOUNT,
  CHANGED_SERVICE_FEE,
  NET_FEN,
  PDD_APPROVED_STATUS,
  PDD_SETTLED_STATUS,
  mappedReport,
  pddRow,
  seconds,
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

/** 报文的更新时刻（order_modify_at）：每次报文往后挪，内容哈希随之变。 */
function modifiedAt(minute: number): number {
  return seconds(at(`2026-10-21T10:${String(minute).padStart(2, '0')}:00.000Z`));
}

/** 审核成功（3）：已收货，没有结算时间。 */
function approved(minute: number) {
  return mappedReport(
    pddRow({
      order_status: PDD_APPROVED_STATUS,
      order_receive_time: seconds(RECEIVED_AT),
      order_modify_at: modifiedAt(minute),
    }),
  );
}

/** 已结算（5）：order_settle_time = SETTLED_AT；金额默认 1000 / 100。 */
function settledReport(minute: number, amounts: Record<string, unknown> = {}) {
  return mappedReport(
    pddRow({
      order_status: PDD_SETTLED_STATUS,
      order_receive_time: seconds(RECEIVED_AT),
      order_settle_time: seconds(SETTLED_AT),
      order_modify_at: modifiedAt(minute),
      ...amounts,
    }),
  );
}

const CHANGED = {
  promotion_amount: CHANGED_PROMOTION_AMOUNT,
  duo_id_service_fee: CHANGED_SERVICE_FEE,
};

it(
  '[AC-B2-19#4] 拼多多单经订单同步由状态 3 变 5：3 时不写结算佣金与结算记录；5 之后 orders.settle_commission_fen = 900，order_settlements 一条 source=API、seq=1、金额 900、settled_at = order_settle_time',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync(approved(1));
      expect(await o.row()).toMatchObject({
        platform_status: 'RECEIVED',
        est_commission_fen: NET_FEN,
        settle_commission_fen: null,
      });
      expect(await o.records()).toEqual([]);

      await o.sync(settledReport(2));
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: NET_FEN,
      });
      const records = await o.records();
      expect(brief(records)).toEqual([[1, 'API', NET_FEN]]);
      expect(records[0]?.settled_at).toEqual(SETTLED_AT);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-19#5] 已结算后再变：同一单状态仍 5、promotion_amount 变了 → 追加 seq=2（1080），seq=1 原样不改、列随之更新；金额与 settled_at 都不变的重复同步不追加',
  async () => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync(approved(1));
      await o.sync(settledReport(2));
      const first = await o.records();
      expect(brief(first)).toEqual([[1, 'API', NET_FEN]]);

      // 只挪了更新时刻：结算额与结算时间都没变，不追加。
      await o.sync(settledReport(3));
      expect(await o.records()).toEqual(first);

      await o.sync(settledReport(4, CHANGED));
      const after = await o.records();
      expect(brief(after)).toEqual([
        [1, 'API', NET_FEN],
        [2, 'API', CHANGED_NET_FEN],
      ]);
      expect(after[0]).toEqual(first[0]);
      expect(after[1]?.settled_at).toEqual(SETTLED_AT);
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        settle_commission_fen: CHANGED_NET_FEN,
      });

      await o.sync(settledReport(5, CHANGED));
      expect(await o.records()).toEqual(after);
    });
  },
  TIMEOUT,
);
