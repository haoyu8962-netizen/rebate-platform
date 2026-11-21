// B2-18a：经生产装配（SettlementModule.forWorker → worker/assemble.ts 的 settle 处理器：真实账单任务、生产
// readSource 与 saveBillValidations）跑账单日 bill——应结未结真的落进 settle_bills.unsettled_count，
// registerDiff 端口没有以 settle_missing 被调用；防止只改了被测函数而装配没接上。其他模块的端口是合成的
// 记录器（同 ../worker/module.int.test.ts 的看法）。
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type JobPayload } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  BILL,
  BILL_DAY,
  BILL_DAY_NOW,
  BILL_DAY_START,
  BILL_MONTH,
  FAKE_CRYPTO,
  TAOBAO,
  TIMEOUT,
  fakeEventBus,
  fakePorts,
  fakeQueue,
  receivedJob,
  seedOrder,
  seedSettlement,
  settleHandler,
  settleJobsOf,
  settlementModule,
  silentRootLogger,
  withDatabase,
  workerContext,
  type PortCalls,
  type PortState,
} from '../worker/kit.ts';
import { billCounts } from './kit.ts';

/** 一次 bill 投递（经装配的 settle 处理器）。 */
type DeliverBill = (payload: JobPayload) => Promise<void>;

/** 装配的 worker 模块（库为 db、Clock 停在账单日 00:40 +08:00）；用它的 settle 处理器跑 body。 */
async function withAssembled(
  db: Kysely<DB>,
  state: PortState,
  body: (h: { handler: DeliverBill; calls: PortCalls }) => Promise<void>,
): Promise<void> {
  const { ports, calls } = fakePorts(state);
  const SettlementModule = await settlementModule();
  const queue = fakeQueue();
  const context = await workerContext(SettlementModule.forWorker(ports), {
    clock: new FixedClock(BILL_DAY_NOW),
    logger: silentRootLogger(),
    db,
    queue,
    crypto: FAKE_CRYPTO,
    events: fakeEventBus(calls),
  });
  try {
    const handler = settleHandler(queue);
    await body({ handler: (payload) => handler(receivedJob(BILL, payload)), calls });
  } finally {
    await context.close();
  }
}

async function ordersOf(db: Kysely<DB>) {
  return db
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', APP)
    .orderBy('order_id')
    .execute();
}

it.each([
  { label: 'credit.enabled 未设（缺省 off）', credit: undefined },
  { label: 'credit.enabled=on', credit: true },
])(
  '[AC-B2-18a#17] 生产装配的 bill（$label）：两单应结未结 → settle_bills.unsettled_count 2、error_count 只含 VOID 对上联盟结算的 1 单，registerDiff 只以 union_mismatch 调用一次、从不以 settle_missing 调用；订单行一字不动',
  async ({ credit }) => {
    await withDatabase(createTestDatabase, async (db) => {
      const first = await seedOrder(db, APP, TAOBAO);
      const second = await seedOrder(db, APP, TAOBAO);
      const voided = await seedOrder(db, APP, TAOBAO, { rebateStatus: 'VOID' });
      await seedSettlement(db, voided);
      // 早于账单月、仍无结算数据：不在本账单范围。
      await seedOrder(db, APP, TAOBAO, { settlePeriod: '2032-05' });
      const config = new Map<string, unknown>();
      if (credit !== undefined) config.set(`credit.enabled.${TAOBAO}`, credit);
      const before = await ordersOf(db);

      await withAssembled(db, { snapshot: 'complete', config }, async ({ handler, calls }) => {
        await handler({ app_id: APP, platform: TAOBAO, accounting_date: BILL_DAY });

        const jobs = (await settleJobsOf(db, APP)).map((row) => ({
          job: row.job,
          platform: row.platform,
          run_at: row.run_at.toISOString(),
          status: row.status,
        }));
        expect(jobs).toStrictEqual([
          { job: 'bill', platform: TAOBAO, run_at: BILL_DAY_START, status: 'done' },
        ]);
        expect(await billCounts(db, APP, BILL_MONTH)).toEqual({
          error_count: 1,
          held_count: 0,
          unsettled_count: 2,
          amount_mismatch_count: null,
        });
        const diffs = calls.diffs.map((diff) => ({
          type: diff.type,
          period: diff.period,
          refId: diff.refId,
        }));
        expect(diffs).not.toContainEqual(expect.objectContaining({ type: 'settle_missing' }));
        expect(diffs).toStrictEqual([
          { type: 'union_mismatch', period: BILL_MONTH, refId: voided.key },
        ]);
        for (const o of [first, second]) {
          expect(calls.diffs.some((diff) => diff.refId === o.key)).toBe(false);
        }
        expect(await ordersOf(db)).toEqual(before);
        expect(calls.attribution).toStrictEqual([]);
      });
    });
  },
  TIMEOUT,
);
