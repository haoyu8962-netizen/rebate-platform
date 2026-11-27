import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createOrderBindingReader } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createOrderPipeline,
  type OrderPipelineContext,
} from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type { OrderPipelineDeps } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import { createOrderUpdateStep } from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { EventBus } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createUnionOrderReaders,
  type UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  commission,
  dependencies,
  seedVersion,
  version,
} from '../../commission/snapshot/fixtures.ts';
import { ctx, instant, num, win } from '../../union/taobao-orders/kit.ts';
import { capture, snapshot } from '../attribution/kit.ts';
import { account, at, BOUND, built, pid, user } from '../wiring/db-kit.ts';
import { ADZONE, FULL_PID, SITE, listPaidOrders, paidRow } from './adapter-kit.ts';

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

async function bindUser(acc: Awaited<ReturnType<typeof account>>) {
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
  return owner.id;
}

async function listOneOrder(
  raw: Record<string, unknown>,
  registeredPid: string,
  context: OrderPipelineContext,
) {
  const page = await listPaidOrders([raw], [registeredPid], {
    ...ctx,
    appId: context.app_id,
    requestId: context.requestId,
    rowErrors: 'collect',
  });
  expect(page.items).toHaveLength(1);
  return page.items[0]!;
}

async function harness(pipelineDb: Kysely<DB> = db, snapshots?: OrderPipelineDeps['snapshots']) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const publish = vi.fn<EventBus['publish']>(async () => ({
    eventId: randomUUID(),
    duplicate: false,
  }));
  const paid = { event: 'PLATFORM_PAID', source: 'synthetic', verified: false, note: '' } as const;
  const readers = await built(() => createUnionOrderReaders(db));
  const deps = {
    db: pipelineDb,
    clock: new FixedClock(instant),
    statusMaps: (platform: OrderPipelineContext['platform']) => ({
      platform,
      entries: new Map([['12', paid]]),
    }),
    ...readers,
    bindings: createOrderBindingReader(db),
    users: { findByAttrCode: async () => null },
    events: { publish },
    logger,
    ...(snapshots === undefined ? {} : { snapshots }),
  };
  const pipeline = await built(() =>
    createOrderPipeline({
      ...deps,
      rebate: { onImported: async () => undefined },
      updateStep: createOrderUpdateStep({
        ...deps,
        rebate: { onUpdated: async () => undefined, onUnmappedStatus: async () => undefined },
      }),
    }),
  );
  return {
    process: (order: UnionOrder, ctx: OrderPipelineContext) =>
      capture(() => pipeline.process(order, ctx)),
    logFields: () =>
      [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map(
        ([fields]) => fields,
      ),
    eventNames: () => publish.mock.calls.map(([, event]) => event.name),
  };
}

it('[AC-B1-08zzc#12] 只登记数字 PID 时，淘宝适配器拉到的订单入库并归属本 App 的绑定用户', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context(acc);
  await pid(db, acc, { pid: ADZONE, site_id: SITE });
  const ownerId = await bindUser(acc);
  const tradeId = '4920000000000000020';
  const incoming = await listOneOrder(
    paidRow(tradeId, { relation_id: num(RELATION) }),
    ADZONE,
    ctx,
  );
  const h = await harness();

  expect(await h.process(incoming, ctx)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const saved = await snapshot(db, acc.app_id);
  expect(saved.orders).toMatchObject([
    {
      app_id: acc.app_id,
      platform: 'taobao',
      sub_order_id: tradeId,
      pid: ADZONE,
      user_id: ownerId,
    },
  ]);
  expect(saved.keys).toMatchObject([
    {
      app_id: acc.app_id,
      platform: 'taobao',
      sub_order_id: tradeId,
      order_id: saved.orders[0]!.order_id,
    },
  ]);
  expect(saved.dropKeys).toEqual([]);
});

it('[AC-B1-08zzc#13] 淘礼金单延迟归属保留登记 PID，首次快照记 none 和零用户分佣', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context(acc);
  await pid(db, acc, { pid: FULL_PID, site_id: SITE, pid_scene: 'taolijin' });
  await seedVersion(db, acc.app_id, version());
  const ownerId = await bindUser(acc);
  const { deps } = dependencies({
    owner: { userId: ownerId, level: 'L1', status: 'active', forfeitReason: null },
    direct: null,
    indirect: null,
    warnings: [],
  });
  const h = await harness(db, {
    create: (trx, input) => commission.createCommissionSnapshot(trx, input, deps),
  });
  const readSplits = () =>
    db.selectFrom('commission_splits').selectAll().where('app_id', '=', acc.app_id).execute();
  const tradeId = '4920000000000000021';
  const first = await listOneOrder(paidRow(tradeId), FULL_PID, ctx);
  expect(await h.process(first, ctx)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const before = await snapshot(db, acc.app_id);
  expect(before.orders).toMatchObject([
    { sub_order_id: tradeId, pid: FULL_PID, platform_status: 'PAID', user_id: null },
  ]);
  expect(await readSplits()).toEqual([]);
  const orderId = before.orders[0]!.order_id;

  const linkedRow = paidRow(tradeId, { relation_id: num(RELATION) });
  const linked = await listOneOrder(linkedRow, FULL_PID, ctx);
  const updated = { ok: true, value: { kind: 'updated', order_id: orderId } };
  expect(await h.process(linked, ctx)).toMatchObject(updated);
  const after = await snapshot(db, acc.app_id);
  expect(after.orders).toMatchObject([
    { order_id: orderId, pid: FULL_PID, user_id: ownerId, relation_id: RELATION },
  ]);
  expect(after.pending).toContainEqual(
    expect.objectContaining({ order_id: orderId, reason: 'TLJ_FACE_VALUE_UNMATCHED' }),
  );
  expect(await readSplits()).toMatchObject([{ order_id: orderId, rebate_mode: 'none' }]);
  const totals = await db
    .selectFrom('commission_split_totals')
    .selectAll()
    .where('app_id', '=', acc.app_id)
    .where('order_id', '=', orderId)
    .execute();
  expect(totals).toMatchObject([{ user_share_total_fen: 0n, tlj_redpacket_fen: null }]);

  // 已归属后再同步同一推广位，用新的修改时间进入参数变化检测。
  const changedTime = await listOneOrder(
    { ...linkedRow, modified_time: '2026-10-30 10:50:00' },
    FULL_PID,
    ctx,
  );
  expect(await h.process(changedTime, ctx)).toMatchObject(updated);
  expect((await snapshot(db, acc.app_id)).orders).toMatchObject([
    { order_id: orderId, pid: FULL_PID, user_id: ownerId },
  ]);
  expect(h.logFields()).not.toContainEqual(expect.objectContaining({ outcome: 'pid_changed' }));
  expect(h.logFields()).not.toContainEqual(
    expect.objectContaining({ event: 'order_attr_param_changed' }),
  );
  expect(h.eventNames()).not.toContain('order.attr_param_changed');
});

it('[AC-B1-08zzc#14] SITE_MISMATCH 回滚时无计数和 P1，重试提交后各一次，重拉不重复', async () => {
  const acc = await account(db, { platform: 'taobao' });
  const ctx = context(acc);
  await pid(db, acc, { pid: FULL_PID, site_id: SITE });
  const tradeId = '4920000000000000022';
  const incoming = await listOneOrder(paidRow(tradeId, { site_id: num('3003') }), FULL_PID, ctx);
  const pipelineDb = db.withSchema('app');
  const transaction = pipelineDb.transaction.bind(pipelineDb);
  const fault = new Error('synthetic failure before commit');
  let failBeforeCommit = true;
  const h = await harness(pipelineDb);
  const p1 = () => h.logFields().filter((fields) => fields?.alert === 'P1');
  const alertsBeforeCommit: number[] = [];
  const spy = vi.spyOn(pipelineDb, 'transaction').mockImplementation(() => {
    const builder = transaction();
    const execute = builder.execute.bind(builder);
    return Object.assign(builder, {
      execute<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
        return execute(async (trx) => {
          const result = await work(trx);
          alertsBeforeCommit.push(p1().length);
          if (failBeforeCommit) throw fault;
          return result;
        });
      },
    });
  });

  try {
    expect(await h.process(incoming, ctx)).toEqual({ ok: false, error: fault });
    const rolledBack = await snapshot(db, acc.app_id);
    expect(rolledBack).toMatchObject({ orders: [], keys: [], dropKeys: [], drops: [] });
    expect(p1()).toEqual([]);

    failBeforeCommit = false;
    const dropped = { ok: true, value: { kind: 'dropped', reason: 'SITE_MISMATCH' } };
    expect(await h.process(incoming, ctx)).toMatchObject(dropped);
    const committed = await snapshot(db, acc.app_id);
    expect(committed).toMatchObject({
      orders: [],
      keys: [],
      dropKeys: [{ platform: 'taobao', sub_order_id: tradeId, reason: 'SITE_MISMATCH' }],
      drops: [{ platform: 'taobao', day: '2026-10-30', reason: 'SITE_MISMATCH', count: 1n }],
    });
    expect(p1()).toHaveLength(1);

    expect(await h.process(incoming, ctx)).toMatchObject(dropped);
    expect(await snapshot(db, acc.app_id)).toEqual(committed);
    expect(p1()).toHaveLength(1);
    expect(alertsBeforeCommit).toEqual([0, 0, 1]);
  } finally {
    spy.mockRestore();
  }
});
