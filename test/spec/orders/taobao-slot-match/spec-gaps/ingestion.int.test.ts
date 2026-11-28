import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createOrderBindingReader } from '../../../../../apps/api/src/modules/linking/index.ts';
import {
  createOrderPipeline,
  type OrderPipelineContext,
} from '../../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type { OrderPipelineDeps } from '../../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import { createOrderUpdateStep } from '../../../../../apps/api/src/modules/orders/application/update-step.ts';
import { FixedClock } from '../../../../../apps/api/src/modules/platform/clock/index.ts';
import { createUnionOrderReaders } from '../../../../../apps/api/src/modules/union/index.ts';
import {
  commission,
  dependencies,
  seedVersion,
  version,
} from '../../../commission/snapshot/fixtures.ts';
import { ctx, instant, num, win } from '../../../union/taobao-orders/kit.ts';
import { account, at, BOUND, built, pid, user } from '../../wiring/db-kit.ts';
import { ADZONE, FULL_PID, SITE, listPaidOrders, paidRow } from '../adapter-kit.ts';

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

function context(acc: Awaited<ReturnType<typeof account>>): OrderPipelineContext {
  return {
    app_id: acc.app_id,
    union_account_id: acc.id,
    platform: 'taobao',
    query_kind: 'increment',
    scene: '-',
    window_start: win.from,
    window_end: win.to,
    requestId: randomUUID(),
  };
}

async function listOneOrder(
  tradeId: string,
  registeredPids: readonly string[],
  sync: OrderPipelineContext,
  fields?: Record<string, unknown>,
) {
  const page = await listPaidOrders([paidRow(tradeId, fields)], registeredPids, {
    ...ctx,
    appId: sync.app_id,
    requestId: sync.requestId,
    rowErrors: 'collect',
  });
  expect(page.items).toMatchObject([
    { sub_order_id: tradeId, promotion_slot: ADZONE, site_id: SITE },
  ]);
  return page.items[0]!;
}

async function setupPipeline(snapshots?: OrderPipelineDeps['snapshots']) {
  const paid = { event: 'PLATFORM_PAID', source: 'synthetic', verified: false, note: '' } as const;
  const deps = {
    db,
    clock: new FixedClock(instant),
    statusMaps: (platform: OrderPipelineContext['platform']) => ({
      platform,
      entries: new Map([['12', paid]]),
    }),
    ...createUnionOrderReaders(db),
    bindings: createOrderBindingReader(db),
    users: { findByAttrCode: async () => null },
    events: { publish: async () => ({ eventId: randomUUID(), duplicate: false }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...(snapshots === undefined ? {} : { snapshots }),
  };
  return built(() =>
    createOrderPipeline({
      ...deps,
      rebate: { onImported: async () => undefined },
      updateStep: createOrderUpdateStep({
        ...deps,
        rebate: { onUpdated: async () => undefined, onUnmappedStatus: async () => undefined },
      }),
    }),
  );
}

function readOrders(appId: string) {
  return db
    .withSchema('app')
    .selectFrom('orders')
    .select([
      'order_id',
      'platform',
      'sub_order_id',
      'pid',
      'platform_status',
      'user_id',
      'relation_id',
    ])
    .where('app_id', '=', appId)
    .execute();
}

it('[AC-B1-08zzh#1] 淘宝登记 PID 仅站点段带前导零时，适配器保留订单且入库保留登记原值', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const registeredPid = 'mm_1001_03001_2002';
  const slot = await pid(db, acc, { pid: registeredPid, site_id: SITE });
  const sync = context(acc);
  const tradeId = '4920000000000000041';
  const incoming = await listOneOrder(tradeId, [slot.pid], sync);
  const pipeline = await setupPipeline();

  expect(await pipeline.process(incoming, sync)).toMatchObject({ kind: 'inserted' });
  expect(await readOrders(acc.app_id)).toMatchObject([
    { platform: 'taobao', sub_order_id: tradeId, pid: registeredPid },
  ]);
});

it('[AC-B1-08zzh#2] 淘宝未归因订单补齐 relation_id 时按站点与 adzone 写回登记 PID，首次快照为淘礼金零返利', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const slot = await pid(db, acc, {
    id: '00000000-0000-4000-8000-000000000002',
    pid: FULL_PID,
    site_id: SITE,
    status: 'pending',
    pid_scene: 'taolijin',
  });
  const owner = await user(db, acc.app_id);
  const relationId = '987654321098';
  const app = db.withSchema('app');
  await app
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: acc.app_id,
      union_account_id: acc.id,
      platform: 'taobao',
      user_id: owner.id,
      relation_id: relationId,
      status: 'active',
      bound_at: at(BOUND),
      created_at: at(BOUND),
      updated_at: at(BOUND),
    })
    .execute();
  await seedVersion(db, acc.app_id, version());
  const { deps } = dependencies({
    owner: { userId: owner.id, level: 'L1', status: 'active', forfeitReason: null },
    direct: null,
    indirect: null,
    warnings: [],
  });
  const pipeline = await setupPipeline({
    create: (trx, input) => commission.createCommissionSnapshot(trx, input, deps),
  });
  const tradeId = '4920000000000000042';
  const firstSync = context(acc);
  const incoming = await listOneOrder(tradeId, [slot.pid], firstSync);
  expect(await pipeline.process(incoming, firstSync)).toMatchObject({ kind: 'inserted' });
  const before = await readOrders(acc.app_id);
  expect(before).toMatchObject([
    {
      sub_order_id: tradeId,
      pid: FULL_PID,
      platform_status: 'PAID',
      user_id: null,
      relation_id: null,
    },
  ]);
  const orderId = before[0]!.order_id;
  const readSplits = () =>
    app
      .selectFrom('commission_splits')
      .select('rebate_mode')
      .where('app_id', '=', acc.app_id)
      .where('order_id', '=', orderId)
      .execute();
  expect(await readSplits()).toEqual([]);

  const editedPid = `mm_2001_${SITE}_${ADZONE}`;
  const edited = await app
    .updateTable('union_pids')
    .set({ pid: editedPid })
    .where('app_id', '=', acc.app_id)
    .where('id', '=', slot.id)
    .returning('pid')
    .executeTakeFirstOrThrow();
  // 候选按 id 排序，让同 adzone 的另一站点在重跑时排在正确登记之前。
  const otherSite = '3002';
  const otherSlot = await pid(db, acc, {
    id: '00000000-0000-4000-8000-000000000001',
    pid: `mm_1001_${otherSite}_${ADZONE}`,
    site_id: otherSite,
    pid_scene: 'share',
  });
  const nextSync = context(acc);
  const linked = await listOneOrder(tradeId, [otherSlot.pid, edited.pid], nextSync, {
    relation_id: num(relationId),
    modified_time: '2026-10-30 10:50:00',
  });
  expect(await pipeline.process(linked, nextSync)).toMatchObject({
    kind: 'updated',
    order_id: orderId,
  });
  expect(await readOrders(acc.app_id)).toMatchObject([
    { order_id: orderId, pid: editedPid, user_id: owner.id, relation_id: relationId },
  ]);
  expect(await readSplits()).toEqual([{ rebate_mode: 'none' }]);
  const totals = await app
    .selectFrom('commission_split_totals')
    .select(['commission_version', 'user_share_total_fen'])
    .where('app_id', '=', acc.app_id)
    .where('order_id', '=', orderId)
    .execute();
  expect(totals).toEqual([{ commission_version: 1, user_share_total_fen: 0n }]);
});
