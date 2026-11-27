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

const RELATION = '987654321098';

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
  registeredPid: string,
  sync: OrderPipelineContext,
  fields?: Record<string, unknown>,
) {
  const page = await listPaidOrders([paidRow(tradeId, fields)], [registeredPid], {
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
    .selectAll()
    .where('app_id', '=', appId)
    .execute();
}

it('[AC-B1-08zzd#1] 淘宝会员段带前导零时，适配器保留订单且入库保留登记 PID', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const slot = await pid(db, acc, { pid: 'mm_01001_3001_2002', site_id: SITE });
  const sync = context(acc);
  const tradeId = '4920000000000000031';
  const incoming = await listOneOrder(tradeId, slot.pid, sync);
  const pipeline = await setupPipeline();

  expect(await pipeline.process(incoming, sync)).toMatchObject({ kind: 'inserted' });
  expect(await readOrders(acc.app_id)).toMatchObject([
    { platform: 'taobao', sub_order_id: tradeId, pid: 'mm_01001_3001_2002' },
  ]);
});

it('[AC-B1-08zzd#2] 未归因期间登记改为数字 PID，补齐 relation_id 后首次快照记淘礼金零返利', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const slot = await pid(db, acc, {
    pid: FULL_PID,
    site_id: SITE,
    status: 'pending',
    pid_scene: 'taolijin',
  });
  const owner = await user(db, acc.app_id);
  await db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: acc.app_id,
      union_account_id: acc.id,
      platform: 'taobao',
      user_id: owner.id,
      relation_id: RELATION,
      status: 'active',
      bound_at: at(BOUND),
      created_at: at(BOUND),
      updated_at: at(BOUND),
    })
    .execute();
  // 普通单的规则会给用户分佣，零份额来自识别出淘礼金场景。
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
  const tradeId = '4920000000000000032';
  const firstSync = context(acc);
  const incoming = await listOneOrder(tradeId, slot.pid, firstSync);
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
  const app = db.withSchema('app');
  const readSplits = () =>
    app
      .selectFrom('commission_splits')
      .select('rebate_mode')
      .where('app_id', '=', acc.app_id)
      .where('order_id', '=', orderId)
      .execute();
  expect(await readSplits()).toEqual([]);

  const edited = await app
    .updateTable('union_pids')
    .set({ pid: ADZONE })
    .where('app_id', '=', acc.app_id)
    .where('id', '=', slot.id)
    .returning('pid')
    .executeTakeFirstOrThrow();
  const nextSync = context(acc);
  const linked = await listOneOrder(tradeId, edited.pid, nextSync, {
    relation_id: num(RELATION),
    modified_time: '2026-10-30 10:50:00',
  });
  expect(await pipeline.process(linked, nextSync)).toMatchObject({
    kind: 'updated',
    order_id: orderId,
  });
  expect(await readOrders(acc.app_id)).toMatchObject([
    { order_id: orderId, pid: ADZONE, user_id: owner.id, relation_id: RELATION },
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
