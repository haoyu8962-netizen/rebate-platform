import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createOrderBindingReader,
  createOrderSourceReader,
} from '../../../../../apps/api/src/modules/linking/index.ts';
import {
  createOrderPipeline,
  type OrderPipelineContext,
} from '../../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type { OrderPipelineDeps } from '../../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import { createOrderSourcePorts } from '../../../../../apps/api/src/modules/orders/application/source-ports.ts';
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
import { capture } from '../../attribution/kit.ts';
import { click } from '../../source-wiring/db-kit.ts';
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

type RegistrationUpdate = Partial<Pick<DB['union_pids'], 'pid' | 'pid_scene'>>;

async function prepare(
  tradeId: string,
  options: { pidScene: 'taolijin' | 'share'; withSources: boolean; initialPid?: string },
) {
  const { pidScene, withSources, initialPid = FULL_PID } = options;
  const acc = await account(db, { platform: 'taobao' });
  const registration = await pid(db, acc, { pid: initialPid, site_id: SITE, pid_scene: pidScene });
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
  await seedVersion(db, acc.app_id, version());
  const { deps: commissionDeps } = dependencies({
    owner: { userId: owner.id, level: 'L1', status: 'active', forfeitReason: null },
    direct: null,
    indirect: null,
    warnings: [],
  });
  const context: OrderPipelineContext = {
    app_id: acc.app_id,
    union_account_id: acc.id,
    platform: 'taobao',
    query_kind: 'increment',
    scene: '-',
    window_start: win.from,
    window_end: win.to,
    requestId: randomUUID(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const readers = await built(() => createUnionOrderReaders(db));
  const find = vi.fn(readers.pids.find);
  const slotCandidates = vi.fn(readers.pids.slotCandidates);
  const sources = createOrderSourcePorts({
    ...createOrderSourceReader(db),
    keyPrefix: async () => 'tb',
    configValue: async () => null,
  });
  const deps = {
    ...readers,
    pids: { ...readers.pids, find, slotCandidates },
    db,
    clock: new FixedClock(instant),
    statusMaps: (platform) => ({
      platform,
      entries: new Map([
        ['12', { event: 'PLATFORM_PAID', source: 'synthetic', verified: false, note: '' } as const],
      ]),
    }),
    bindings: createOrderBindingReader(db),
    users: { findByAttrCode: async () => null },
    events: { publish: async () => ({ eventId: randomUUID(), duplicate: false }) },
    ...(withSources ? { sources } : {}),
    snapshots: {
      create: (trx, input) => commission.createCommissionSnapshot(trx, input, commissionDeps),
    },
    logger,
  } satisfies Omit<OrderPipelineDeps, 'rebate'>;
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

  async function sync(registeredPid: string, fields: Record<string, unknown>) {
    const row = paidRow(tradeId, {
      pub_share_pre_fee: '10.00',
      pub_share_pre_fee_for_commission: '10.00',
      pub_share_pre_fee_for_sdy: '0.00',
      alimm_share_info_dto: { alimm_tech_service_pre_fee: num('0') },
      ...fields,
    });
    const page = await listPaidOrders([row], [registeredPid], {
      ...ctx,
      appId: acc.app_id,
      requestId: context.requestId,
      rowErrors: 'collect',
    });
    expect(page.items).toHaveLength(1);
    return capture(() => pipeline.process(page.items[0]!, context));
  }

  const readOrder = () =>
    db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', acc.app_id)
      .where('sub_order_id', '=', tradeId)
      .executeTakeFirstOrThrow();
  expect(await sync(initialPid, {})).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const before = await readOrder();
  expect(before).toMatchObject({
    pid: initialPid,
    user_id: null,
    source_match: null,
    platform_status: 'PAID',
    est_commission_fen: 1000n,
  });

  const readSplits = () =>
    db
      .selectFrom('commission_splits')
      .select(['rebate_mode', 'raw_n_fen'])
      .where('app_id', '=', acc.app_id)
      .where('order_id', '=', before.order_id)
      .execute();
  const readTotals = () =>
    db
      .selectFrom('commission_split_totals')
      .select(['user_share_total_fen', 'tlj_redpacket_fen'])
      .where('app_id', '=', acc.app_id)
      .where('order_id', '=', before.order_id)
      .execute();
  expect(await readSplits()).toEqual([]);

  async function updateRegistration(changes: RegistrationUpdate) {
    await db
      .updateTable('union_pids')
      .set(changes)
      .where('app_id', '=', acc.app_id)
      .where('id', '=', registration.id)
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  async function rerun(changes: RegistrationUpdate = { pid: ADZONE }) {
    if (initialPid !== FULL_PID) await updateRegistration({ pid: FULL_PID });
    find.mockClear();
    slotCandidates.mockClear();
    logger.warn.mockClear();
    slotCandidates.mockImplementationOnce(async (input) => {
      const rows = await readers.pids.slotCandidates(input);
      // 候选查询读到了原场景。返回已读候选前，模拟后台提交对同一登记行的改动。
      await updateRegistration(changes);
      return rows;
    });
    expect(
      await sync(FULL_PID, { relation_id: num(RELATION), modified_time: '2026-10-30 10:50:00' }),
    ).toMatchObject({ ok: true, value: { kind: 'updated', order_id: before.order_id } });
    expect(slotCandidates).toHaveBeenCalledExactlyOnceWith({
      appId: acc.app_id,
      platform: 'taobao',
      unionAccountId: acc.id,
      slot: ADZONE,
    });
    expect(find).not.toHaveBeenCalled();
    const order = await readOrder();
    expect(order).toMatchObject({
      pid: FULL_PID,
      user_id: owner.id,
      relation_id: RELATION,
      buy_type: before.buy_type,
    });
    return order;
  }

  function addClick(scene: 'taolijin' | 'share', later = false) {
    return click(db, acc.app_id, owner.id, {
      platform: 'taobao',
      product_key: 'tb:uVwXyZ0123456789',
      pid_scene: scene,
      scene: scene === 'taolijin' ? 'agent' : 'share',
      created_at: at(later ? '2026-10-30T01:57:00.000Z' : '2026-10-30T01:56:00.000Z'),
    });
  }

  return { addClick, logger, readSplits, readTotals, rerun };
}

it('[AC-B1-08zze#1] 淘礼金登记行在重跑命中后改写 PID，未启用来源回填时首次快照仍记 none 和零用户份额', async () => {
  const order = await prepare('4920000000000000031', { pidScene: 'taolijin', withSources: false });
  await order.rerun();

  expect(await order.readSplits()).toEqual([{ rebate_mode: 'none', raw_n_fen: 1000n }]);
  expect(await order.readTotals()).toEqual([{ user_share_total_fen: 0n, tlj_redpacket_fen: null }]);
});

it('[AC-B1-08zze#2] 淘礼金登记行改写 PID 后，来源回填与首次快照都按重跑命中的淘礼金场景处理', async () => {
  const order = await prepare('4920000000000000032', { pidScene: 'taolijin', withSources: true });
  const taolijin = await order.addClick('taolijin');
  await order.addClick('share', true);

  expect(await order.rerun()).toMatchObject({
    source_match: 'product',
    source_scene: taolijin.scene,
    link_id: taolijin.link_id,
    agent_session_id: taolijin.agent_session_id,
  });
  expect(await order.readSplits()).toEqual([{ rebate_mode: 'none', raw_n_fen: 1000n }]);
  expect(await order.readTotals()).toEqual([{ user_share_total_fen: 0n, tlj_redpacket_fen: null }]);
  expect(order.logger.warn.mock.calls.map(([fields]) => fields)).not.toContainEqual(
    expect.objectContaining({ reason: 'PID_SCENE_NOT_FOUND' }),
  );
});

it('[AC-B1-08zze#3] 重跑命中分享推广位时按分享场景回填来源，并生成普通分佣快照', async () => {
  const order = await prepare('4920000000000000033', {
    pidScene: 'share',
    withSources: true,
    initialPid: ADZONE,
  });
  const share = await order.addClick('share');
  await order.addClick('taolijin', true);

  expect(await order.rerun()).toMatchObject({
    source_match: 'product',
    source_scene: share.scene,
    link_id: share.link_id,
    agent_session_id: share.agent_session_id,
  });
  expect(await order.readSplits()).toEqual([{ rebate_mode: null, raw_n_fen: 1000n }]);
  expect(await order.readTotals()).toEqual([{ user_share_total_fen: 500n, tlj_redpacket_fen: 0n }]);
});

it('[AC-B1-08zze#4] 同一登记行改为分享场景后，来源回填与首次快照仍使用重跑命中时的淘礼金场景', async () => {
  const order = await prepare('4920000000000000034', { pidScene: 'taolijin', withSources: true });
  const taolijin = await order.addClick('taolijin');
  await order.addClick('share', true);

  const updated = await order.rerun({ pid_scene: 'share' });
  expect(updated).toMatchObject({
    source_match: 'product',
    source_scene: taolijin.scene,
    link_id: taolijin.link_id,
    agent_session_id: taolijin.agent_session_id,
  });
  expect(await order.readSplits()).toEqual([{ rebate_mode: 'none', raw_n_fen: 1000n }]);
  expect(await order.readTotals()).toEqual([{ user_share_total_fen: 0n, tlj_redpacket_fen: null }]);
});
