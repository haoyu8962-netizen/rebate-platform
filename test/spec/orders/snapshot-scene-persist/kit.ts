import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { createOrderBindingReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type { OrderPipelineDeps } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import { createOrderUpdateStep } from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import type { StatusMapEntry } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createUnionOrderReaders } from '../../../../apps/api/src/modules/union/index.ts';
import {
  commission,
  dependencies,
  seedVersion,
  version,
} from '../../commission/snapshot/fixtures.ts';
import { ctx, instant, num, win } from '../../union/taobao-orders/kit.ts';
import { FULL_PID, SITE, listPaidOrders, paidRow } from '../taobao-slot-match/adapter-kit.ts';
import { account, at, BOUND, built, pid, user } from '../wiring/db-kit.ts';

export const RELATION = '987654321098';
const DEPOSIT_STATUS = 'deposit';

export async function prepareOrder(
  db: Kysely<DB>,
  tradeId: string,
  options: {
    appId?: string;
    attributed?: boolean;
    deposit?: boolean;
    initialReport?: Record<string, unknown>;
    clockStart?: string;
  } = {},
) {
  const acc = await account(db, {
    platform: 'taobao',
    ...(options.appId === undefined ? {} : { app_id: options.appId }),
  });
  const registration = await pid(db, acc, { pid: FULL_PID, site_id: SITE, pid_scene: 'taolijin' });
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

  const { deps: commissionDeps } = dependencies({
    owner: { userId: owner.id, level: 'L1', status: 'active', forfeitReason: null },
    direct: null,
    indirect: null,
    warnings: [],
  });
  const readers = await built(() => createUnionOrderReaders(db));
  const slotCandidates = vi.fn(readers.pids.slotCandidates);
  const publish = vi
    .fn<NonNullable<OrderPipelineDeps['events']>['publish']>()
    .mockResolvedValue({ eventId: randomUUID(), duplicate: false });
  const clock = new FixedClock(options.clockStart ?? instant);
  const deps = {
    ...readers,
    pids: { ...readers.pids, slotCandidates },
    db,
    clock,
    statusMaps: (platform) => ({
      platform,
      entries: new Map<string, StatusMapEntry>([
        ['12', { event: 'PLATFORM_PAID', source: 'synthetic', verified: false, note: '' }],
        [
          DEPOSIT_STATUS,
          { event: 'PLATFORM_DEPOSIT_PAID', source: 'synthetic', verified: false, note: '' },
        ],
      ]),
    }),
    bindings: createOrderBindingReader(db),
    users: { findByAttrCode: async () => null },
    events: { publish },
    snapshots: {
      create: (trx, input) => commission.createCommissionSnapshot(trx, input, commissionDeps),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  const context = {
    app_id: acc.app_id,
    union_account_id: acc.id,
    platform: 'taobao',
    query_kind: 'increment',
    scene: '-',
    window_start: win.from,
    window_end: win.to,
    requestId: randomUUID(),
  } as const;

  async function sync(fields: Record<string, unknown>, registeredPid = FULL_PID, deposit = false) {
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
    const order = page.items[0]!;
    clock.advanceMs(1_000);
    // 定金场景从归一报文入口注入合成状态码，匹配仍走真实淘宝推广位读口。
    return pipeline.process(deposit ? { ...order, raw_status: DEPOSIT_STATUS } : order, context);
  }

  const readOrder = () =>
    db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', acc.app_id)
      .where('sub_order_id', '=', tradeId)
      .executeTakeFirstOrThrow();

  const presale = options.deposit
    ? {
        tk_paid_time: '--',
        tb_paid_time: '--',
        tk_deposit_time: '2026-10-29 20:00:00',
        tb_deposit_time: '2026-10-29 20:00:00',
      }
    : {};
  const relation = { relation_id: num(RELATION) };
  const initialReport = {
    ...options.initialReport,
    ...presale,
    ...(options.attributed ? relation : {}),
  };
  expect(await sync(initialReport, FULL_PID, options.deposit)).toMatchObject({ kind: 'inserted' });
  const initial = await readOrder();
  const orderId = initial.order_id;

  async function updateRegistration(scene: 'taolijin' | 'share') {
    await db
      .updateTable('union_pids')
      .set({ pid_scene: scene })
      .where('app_id', '=', acc.app_id)
      .where('id', '=', registration.id)
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  return {
    ownerId: owner.id,
    initial,
    clock,
    publish,
    readOrder,
    updateRegistration,
    addSlot: (registeredPid: string) =>
      pid(db, acc, { pid: registeredPid, site_id: SITE, pid_scene: 'share' }),
    changeRegistrationAfterMatch() {
      slotCandidates.mockClear();
      slotCandidates.mockImplementationOnce(async (input) => {
        const rows = await readers.pids.slotCandidates(input);
        expect(rows).toMatchObject([{ pid: FULL_PID, pid_scene: 'share' }]);
        await updateRegistration('taolijin');
        return rows;
      });
      return slotCandidates;
    },
    async update(fields: Record<string, unknown>, registeredPid = FULL_PID) {
      expect(await sync({ ...relation, ...fields }, registeredPid)).toMatchObject({
        kind: 'updated',
        order_id: orderId,
      });
    },
    publishRules: () => seedVersion(db, acc.app_id, version()),
    async readScene() {
      const { rows } = await sql<{ attr_pid_scene: string | null }>`
        SELECT attr_pid_scene FROM app.orders
        WHERE app_id = ${acc.app_id} AND order_id = ${orderId}
      `.execute(db);
      expect(rows).toHaveLength(1);
      return rows[0]!.attr_pid_scene;
    },
    async clearScene() {
      const { rows } = await sql<{ attr_pid_scene: null }>`
        UPDATE app.orders SET attr_pid_scene = NULL
        WHERE app_id = ${acc.app_id} AND order_id = ${orderId}
        RETURNING attr_pid_scene
      `.execute(db);
      expect(rows).toEqual([{ attr_pid_scene: null }]);
    },
    async readSnapshot() {
      const [splits, totals] = await Promise.all([
        db
          .selectFrom('commission_splits')
          .select(['rebate_mode', 'raw_n_fen'])
          .where('app_id', '=', acc.app_id)
          .where('order_id', '=', orderId)
          .execute(),
        db
          .selectFrom('commission_split_totals')
          .select('user_share_total_fen')
          .where('app_id', '=', acc.app_id)
          .where('order_id', '=', orderId)
          .execute(),
      ]);
      return { splits, totals };
    },
    readRulePending: () =>
      db
        .selectFrom('order_sync_pending')
        .select(['id', 'detail', 'status', 'resolved_at'])
        .where('app_id', '=', acc.app_id)
        .where('order_id', '=', orderId)
        .where('reason', '=', 'RULE_VERSION_PLATFORM_MISSING')
        .execute(),
  };
}
