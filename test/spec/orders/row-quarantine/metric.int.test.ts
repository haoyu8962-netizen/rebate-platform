// B1-04zv：坏行经真实任务进待处理后，worker 的 /metrics 按 reason 暴露新值，CouliOrderRowInvalid 读的就是这条序列。
// 这个文件自用一个库：orders 的端口跨 app_id 计数，同库的别的用例会把数算乱。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readOrderSyncPendingOpen } from '../../../../apps/api/src/modules/orders/application/metrics-read.ts';
import { readPayoutFundMetrics } from '../../../../apps/api/src/modules/payout/application/metrics-read.ts';
import { readSettlementFundMetrics } from '../../../../apps/api/src/modules/settlement/application/metrics-read.ts';
import {
  createMetricsRegistry,
  type FundMetricsSnapshot,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { pendingGauge } from '../../platform/fund-metrics/kit.ts';
import { decimalId, REASON, withWorld } from './worker-harness.ts';

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

it('[AC-B1-04zv#16] 指标按 reason 暴露新值：open 的坏行计入 couli_order_sync_pending_open{reason="ORDER_ROW_INVALID"}，解决后减少', () =>
  withWorld(db, async (w) => {
    const [fixedLater, stays] = [decimalId(), decimalId()];
    const collectFund = async (): Promise<FundMetricsSnapshot> => ({
      orderSyncPendingOpen: await readOrderSyncPendingOpen(db),
      ...(await readSettlementFundMetrics(db, w.clock)),
      ...(await readPayoutFundMetrics(db)),
    });
    const registry = createMetricsRegistry({ entry: 'worker', collectFund });

    const broken = await w.run('increment', [
      { id: '71601', rows: [w.bad(fixedLater), w.bad(stays)] },
    ]);
    expect(broken).toMatchObject({ ok: true });
    expect(pendingGauge(await registry.render())).toEqual({ [REASON]: 2 });

    const fixed = await w.run('increment', [{ id: '71602', rows: [w.good(fixedLater)] }], {
      window: 1,
    });
    expect(fixed).toMatchObject({ ok: true });
    expect(pendingGauge(await registry.render())).toEqual({ [REASON]: 1 });
  }));
