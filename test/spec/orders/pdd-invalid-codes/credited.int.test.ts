// B1-04zgc · 已入账拼多多订单收到 4 / 10（D10-1069）：照现有失效口径 R8 整单扣回，sub_type FULL，不再整条拒收，
// 不写子原因。同步、出账单与入账都走真实 worker 入口（../../settlement/settlement-records/kit.ts，只读复用：
// 拼多多付款 → 确认收货 → 结算 5 → 月账单 → R5），扣回走同一 worker 的订单流水线，读真实 pdd.csv。
// 手算：佣金 1000、服务费 0 → N = 1000，预留 0、本人 50 %，入账与全额扣回都是 500。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_AT,
  TIMEOUT,
  capture,
  received,
  settled,
  touched,
  withWorker,
} from '../../settlement/settlement-records/kit.ts';
import { INVALID_CODES } from './kit.ts';

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

// 平台状态期望照 P7（08/06_FUND:169，SETTLED 后失效平台状态不变），D10-1115 / D10-1118 修正原先误抄京东 P6 的 INVALID；
// P7 另要求的 order_rights(INVALID_AFTER_SETTLE) 全仓未实现，见 FU-P7-ORDER-RIGHTS-ROW，不在本单断言。
it.each(INVALID_CODES)(
  '[AC-B1-04zgc#4] CREDITED 订单收到拼多多 %s：R8 整单扣回（CLAWED_BACK，reason=REFUND，reason_sub 为空，sub_type FULL），不进待处理、不整条拒收',
  async (code) => {
    await withWorker(db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      w.clock.set(BILL_AT);
      await w.bill(app);
      await w.confirmAndExecute(app);
      expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: 1000n });
      expect(await w.available(app)).toBe(500n);

      // 确认收货时刻照旧带着（同京东先例：报文只换状态码与修改时间）。
      const report = received({ raw_status: code, ...touched(1) });
      expect(await capture(() => o.report(report))).toMatchObject({ ok: true });

      const pending = await db
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('app_id', '=', app.appId)
        .execute();
      expect(pending).toEqual([]);
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        rebate_status: 'CLAWED_BACK',
        reason: 'REFUND',
        reason_sub: null,
        booked_base_fen: 0n,
        booked_n_fen: 0n,
        hold: false,
      });
      const clawbacks = await db
        .selectFrom('ledger_entries')
        .select(['sub_type'])
        .where('app_id', '=', app.appId)
        .where('ledger_type', '=', 'CLAWBACK')
        .execute();
      expect(clawbacks.length).toBeGreaterThan(0);
      expect(new Set(clawbacks.map((entry) => entry.sub_type))).toEqual(new Set(['FULL']));
      expect(await w.available(app)).toBe(0n);
    });
  },
  TIMEOUT,
);
