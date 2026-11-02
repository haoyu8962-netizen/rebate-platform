// B1-08k 源码旁单元测试：第 ⑥ 步的执行（结果映射、待处理与告警、抛错不吞）、首次入库与更新步骤的接入点
// （paid_at_source 随写库、端口在 history / 待处理之后与 settlement 之前、snapshot 字段），以及本模块按结构声明的
// 端口类型与 commission 公开类型一致。不连库：脚本化驱动只回预设结果，记录编译后的语句。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
  type Selectable,
  type Transaction,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import type {
  CreateCommissionSnapshotInput,
  CreateCommissionSnapshotResult,
} from '../../commission/index.ts';
import { orderSnapshotPort } from '../../../app.module.ts';
import { FixedClock, createRootLogger } from '../../platform/index.ts';
import type { UnionOrder } from '../../union/index.ts';
import type { CommissionSnapshotCallInput } from '../domain/commission-snapshot.ts';
import type { PlatformStatusEvent, StatusMap } from '../domain/status-map.ts';
import {
  runCommissionSnapshot,
  type CommissionSnapshotPort,
  type SnapshotStepContext,
} from './commission-snapshot-step.ts';
import { createOrderPipeline } from './pipeline-port.ts';
import type { OrderPipelineContext, OrderPipelineDeps } from './pipeline-types.ts';
import { createOrderUpdateStep, type OrderUpdateDeps } from './update-step.ts';

const NOW = '2026-10-17T17:30:00.000Z';
const at = (iso: string) => new FixedClock(iso).now();
const OWNER = '019a0000-0000-7000-8000-000000000042';
const ATTR_AT = at('2026-10-15T16:00:01.000Z');

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** 记录语句与端口调用的同一时间线；order_status_history 的读回 history()。 */
function scriptedDb(history: () => { at: Date }[] = () => [], versionUpdated = 1n) {
  const log: Statement[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: Statement): Promise<QueryResult<R>> {
          log.push({ sql: compiled.sql, parameters: compiled.parameters });
          if (compiled.sql.startsWith('update "app"."orders"')) {
            const matched = compiled.sql.includes('"commission_version" = $') ? versionUpdated : 1n;
            return Promise.resolve({ rows: [], numAffectedRows: matched });
          }
          if (compiled.sql.startsWith('select "attr_at" from "app"."order_keys"')) {
            return Promise.resolve({ rows: [{ attr_at: ATTR_AT }] as R[] });
          }
          if (compiled.sql.startsWith('select') && compiled.sql.includes('order_status_history')) {
            return Promise.resolve({ rows: history() as R[] });
          }
          if (compiled.sql.startsWith('insert into "app"."order_sync_pending"')) {
            return Promise.resolve({ rows: [{ id: 5n }] as R[] });
          }
          return Promise.resolve({ rows: [] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const mark = (sql: string) => log.push({ sql, parameters: [] });
  return { db, log, mark };
}

function fakePort(
  mark: (sql: string) => void,
  result: Awaited<ReturnType<CommissionSnapshotPort['create']>> = { kind: 'created' },
) {
  return {
    create: vi.fn<CommissionSnapshotPort['create']>(() => {
      mark('snapshot.create');
      return Promise.resolve(result);
    }),
  };
}

const callInput: CommissionSnapshotCallInput = {
  appId: 'unit-app',
  orderId: '019a0000-0000-7000-8000-000000000001',
  platform: 'pdd',
  paidAt: at('2026-10-15T16:00:00.000Z'),
  paidAtSource: 'platform',
  orderType: 'self',
  activityType: null,
  rebateMode: null,
  nBaseFen: 480n,
  subsidyCommissionFen: 0n,
  tljDeductFen: 0n,
  tljRedpacketFen: 0n,
  ownerUserId: OWNER,
};

const stepCtx: SnapshotStepContext = {
  app_id: 'unit-app',
  platform: 'pdd',
  sub_order_id: 'unit-child',
  order_id: callInput.orderId,
  raw_status: 'paid',
  raw_payload_id: 2n,
  now: at(NOW),
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const pendingRows = (log: Statement[]) =>
  log.filter((s) => s.sql.startsWith('insert into "app"."order_sync_pending"'));

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

it('[AC-B1-08k#U7] 按结构声明的端口入参与 commission 公开入参同构，真实端口可直接装配', () => {
  const sameInput: Same<CommissionSnapshotCallInput, CreateCommissionSnapshotInput> = true;
  type Real = (
    trx: Transaction<DB>,
    input: CreateCommissionSnapshotInput,
  ) => Promise<CreateCommissionSnapshotResult>;
  const wires: Real extends CommissionSnapshotPort['create'] ? true : false = true;
  expect([sameInput, wires]).toEqual([true, true]);
});

function refreshingPort(mark: (sql: string) => void, kind: 'created' | 'existing' = 'created') {
  return {
    ...fakePort(mark, { kind }),
    refresh: vi.fn<NonNullable<CommissionSnapshotPort['refresh']>>(() => {
      mark('snapshot.refresh');
      return Promise.resolve();
    }),
  };
}

const versionWrites = (log: Statement[]) =>
  log.filter((s) => s.sql.startsWith('update "app"."orders"'));

it('[AC-B2-03q] created、版本 0：置 1 带乐观锁与 attr_at，row_version 不动，不调 refresh', async () => {
  const { db, log, mark } = scriptedDb();
  const port = refreshingPort(mark);
  await db
    .transaction()
    .execute((trx) =>
      runCommissionSnapshot(trx, port, { kind: 'call', input: callInput }, stepCtx, undefined),
    );
  const [write] = versionWrites(log);
  expect(versionWrites(log)).toHaveLength(1);
  expect(write?.sql).toMatch(/"commission_version" = \$\d+$/);
  expect(write?.sql).toContain('"attr_at" = $');
  expect(write?.sql).not.toContain('row_version');
  expect(port.refresh).not.toHaveBeenCalled();
});

it('[AC-B2-03q] created、版本已 ≥ 1：UPDATE 零行，经 refresh 写当前版本', async () => {
  const { db, mark } = scriptedDb(() => [], 0n);
  const port = refreshingPort(mark);
  await db.transaction().execute(async (trx) => {
    await runCommissionSnapshot(trx, port, { kind: 'call', input: callInput }, stepCtx, undefined);
    expect(port.refresh).toHaveBeenCalledExactlyOnceWith(trx, {
      appId: stepCtx.app_id,
      orderId: stepCtx.order_id,
      attrAt: ATTR_AT,
    });
  });
});

it('[AC-B2-03q] existing 与只有 create 的端口：版本不动，不读 attr_at，也不调 refresh', async () => {
  const { db, log, mark } = scriptedDb();
  const existing = refreshingPort(mark, 'existing');
  await db.transaction().execute(async (trx) => {
    const call = { kind: 'call', input: callInput } as const;
    await runCommissionSnapshot(trx, existing, call, stepCtx, undefined);
    await runCommissionSnapshot(trx, fakePort(mark), call, stepCtx, undefined);
  });
  expect(existing.refresh).not.toHaveBeenCalled();
  expect(versionWrites(log)).toEqual([]);
  expect(log.some((s) => s.sql.includes('order_keys'))).toBe(false);
});

it('[AC-B2-03q] 生产组合根的快照端口带 refresh：漏装配时版本停 0 或缺行而不报错', () => {
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    { write: () => undefined },
  );
  const port = orderSnapshotPort(scriptedDb().db, new FixedClock(NOW), logger);
  expect(port.refresh).toEqual(expect.any(Function));
  expect(port.create).toEqual(expect.any(Function));
});

it('[AC-B1-08k#U8] skip 不调端口；created / existing 原样返回且不写待处理', async () => {
  const { db, log, mark } = scriptedDb();
  const skipPort = fakePort(mark);
  await db.transaction().execute(async (trx) => {
    expect(await runCommissionSnapshot(trx, skipPort, { kind: 'skip' }, stepCtx, undefined)).toBe(
      'none',
    );
    for (const kind of ['created', 'existing'] as const) {
      const port = fakePort(mark, { kind });
      const plan = { kind: 'call', input: callInput } as const;
      expect(await runCommissionSnapshot(trx, port, plan, stepCtx, undefined)).toBe(kind);
      expect(port.create).toHaveBeenCalledWith(trx, callInput);
    }
  });
  expect(skipPort.create).not.toHaveBeenCalled();
  expect(pendingRows(log)).toEqual([]);
});

it('[AC-B1-08k#U9] 计划 pending 与端口 pending 都写待处理（原因、说明）并平铺告警；端口抛错原样传出', async () => {
  const { db, log, mark } = scriptedDb();
  const log1 = logger();
  const plan = { kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' } as const;
  const portPending = fakePort(mark, { kind: 'pending', reason: 'no published rule version' });
  const error = new Error('unit snapshot failure');
  const failing = { create: vi.fn<CommissionSnapshotPort['create']>().mockRejectedValue(error) };
  await db.transaction().execute(async (trx) => {
    expect(await runCommissionSnapshot(trx, portPending, plan, stepCtx, log1)).toBe('pending');
    expect(portPending.create).not.toHaveBeenCalled();
    const call = { kind: 'call', input: callInput } as const;
    expect(await runCommissionSnapshot(trx, portPending, call, stepCtx, log1)).toBe('pending');
    await expect(runCommissionSnapshot(trx, failing, call, stepCtx, log1)).rejects.toBe(error);
  });
  const rows = pendingRows(log).map((s) => s.parameters);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(expect.arrayContaining(['SERVICE_FEE_RATE_MISSING']));
  expect(rows[1]).toEqual(
    expect.arrayContaining([
      'RULE_VERSION_PLATFORM_MISSING',
      'commission_snapshot no published rule version',
      callInput.orderId,
    ]),
  );
  expect(log1.warn.mock.calls.map(([fields]) => fields)).toEqual([
    {
      platform: 'pdd',
      app_id: 'unit-app',
      reason: 'SERVICE_FEE_RATE_MISSING',
      outcome: 'snapshot_pending',
    },
    {
      platform: 'pdd',
      app_id: 'unit-app',
      reason: 'RULE_VERSION_PLATFORM_MISSING',
      outcome: 'snapshot_pending',
    },
  ]);
});

it('[AC-B1-08k#U10] 淘礼金面额未匹配照常调端口，另写 TLJ_FACE_VALUE_UNMATCHED 待处理并告警', async () => {
  const { db, log, mark } = scriptedDb();
  const log1 = logger();
  const port = fakePort(mark);
  const input = { ...callInput, rebateMode: 'none', tljRedpacketFen: null } as const;
  const outcome = await db
    .transaction()
    .execute((trx) => runCommissionSnapshot(trx, port, { kind: 'call', input }, stepCtx, log1));
  expect(outcome).toBe('created');
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(pendingRows(log).map((s) => s.parameters)).toEqual([
    expect.arrayContaining(['TLJ_FACE_VALUE_UNMATCHED']),
  ]);
  expect(log1.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'TLJ_FACE_VALUE_UNMATCHED', app_id: 'unit-app' }),
    expect.any(String),
  );
});

const map: StatusMap = {
  platform: 'pdd',
  entries: new Map(
    (
      [
        ['deposit', 'PLATFORM_DEPOSIT_PAID'],
        ['paid', 'PLATFORM_PAID'],
      ] as [string, PlatformStatusEvent][]
    ).map(([code, event]) => [code, { event, source: 'unit', verified: false, note: '' }]),
  ),
};

function union(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: null,
    promotion_slot: 'slot-ours',
    attr_params: { relation_id: null, sub_union_id: null, custom_parameters: null },
    raw_status: 'paid',
    goods_id: 'unit-item',
    paid_fen: 100n,
    commission_fen: 500n,
    est_commission_fen: 500n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at('2026-10-15T16:00:00.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: at('2026-10-16T01:00:00.000Z'),
    service_fee_fen: 20n,
    raw_payload_id: '2',
    ...patch,
  };
}

const ctx: OrderPipelineContext = {
  app_id: 'unit-app',
  platform: 'pdd',
  union_account_id: 'unit-account',
  query_kind: 'increment',
  scene: '-',
  window_start: '2026-10-01T00:00:00.000Z',
  window_end: NOW,
  requestId: 'unit-request',
};

it('[AC-B1-08k#U11] 首次入库：paid_at_source 随 INSERT，端口在 history 后、settlement 前；未注入时不带 snapshot 字段且不写来源', async () => {
  for (const injected of [true, false]) {
    const { db, log, mark } = scriptedDb();
    const port = fakePort(mark);
    const onImported = vi.fn<OrderPipelineDeps['rebate']['onImported']>(() => {
      mark('rebate.onImported');
      return Promise.resolve();
    });
    const deps: OrderPipelineDeps = {
      db,
      clock: new FixedClock(NOW),
      statusMaps: () => map,
      pids: {
        find: () => Promise.resolve([{ pid_scene: 'share', status: 'active', site_id: null }]),
      },
      accounts: { syncStartAt: () => Promise.resolve(at('2026-10-01T00:00:00.000Z')) },
      users: { findByAttrCode: () => Promise.resolve(OWNER) },
      bindings: { findByRelation: () => Promise.resolve([]) },
      rebate: { onImported },
      ...(injected ? { snapshots: port } : {}),
    };
    // 拼多多 uid 参数让 ② 命中（用户端口回 OWNER）。
    const order = union({
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: '{"app":"n","uid":"abcd1234"}',
      },
    });
    expect(await createOrderPipeline(deps).process(order, ctx)).toMatchObject({ kind: 'inserted' });
    const sqls = log.map((s) => s.sql);
    const insert = log.find((s) => s.sql.startsWith('insert into "app"."orders"'))!;
    const imported = onImported.mock.calls[0]?.[1];
    if (injected) {
      expect(imported).toMatchObject({ snapshot: 'created' });
      expect(insert.sql).toContain('"paid_at_source"');
      expect(insert.parameters).toContain('platform');
      expect(port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 480n, orderType: 'share' });
      const historyAt = sqls.findIndex((s) =>
        s.startsWith('insert into "app"."order_status_history"'),
      );
      expect(historyAt).toBeLessThan(sqls.indexOf('snapshot.create'));
      expect(sqls.indexOf('snapshot.create')).toBeLessThan(sqls.indexOf('rebate.onImported'));
    } else {
      // D10-69：未注入端口时交给 settlement 的对象恰为 B1-08h 的 6 个字段（不带 snapshot）。
      expect(Object.keys(imported ?? {}).sort()).toEqual([
        'app_id',
        'attr_at',
        'attributed',
        'order_id',
        'platform_status',
        'received_at',
      ]);
      expect(insert.sql).not.toContain('"paid_at_source"');
      expect(port.create).not.toHaveBeenCalled();
    }
  }
});

type Row = Selectable<DB['orders']>;
const deposit = at('2026-10-04T01:00:00.000Z');
const current = {
  order_id: '019a0000-0000-7000-8000-000000000001',
  app_id: 'unit-app',
  platform: 'pdd',
  sub_order_id: 'unit-child',
  attr_at: deposit,
  platform_status: 'DEPOSIT_PAID',
  rebate_status: 'ESTIMATED',
  row_version: 3,
  commission_version: 1,
  user_id: OWNER,
  locked: false,
  buy_type: 'self',
  activity_type: null,
  is_presale: true,
  paid_at_source: null,
  subsidy_commission_fen: null,
  pid: 'slot-ours',
  relation_id: null,
  sub_union_id: null,
  custom_params: null,
  pay_amount_fen: 100n,
  est_commission_fen: 500n,
  settle_commission_fen: null,
  received_at: null,
  platform_received_at: null,
  deposit_paid_at: deposit,
  paid_at: deposit,
  settled_at: null,
  platform_modified_at: null,
  parent_order_id: null,
  raw_item_id: 'unit-item',
  content_hash: 'old',
  raw_payload_id: 1n,
} as Row;

function updateDeps(mark: (sql: string) => void, snapshots?: CommissionSnapshotPort) {
  const onUpdated = vi.fn<OrderUpdateDeps['rebate']['onUpdated']>(() => {
    mark('rebate.onUpdated');
    return Promise.resolve();
  });
  const deps: OrderUpdateDeps = {
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    users: { findByAttrCode: () => Promise.resolve(null) },
    bindings: { findByRelation: () => Promise.resolve([]) },
    pids: { find: () => Promise.resolve([]) },
    rebate: { onUpdated, onUnmappedStatus: () => Promise.resolve() },
    events: { publish: () => Promise.resolve({ eventId: 'unit', duplicate: false }) },
    logger: logger(),
    ...(snapshots === undefined ? {} : { snapshots }),
  };
  return { deps, onUpdated };
}

it('[AC-B1-08k#U12] 更新 P2：来源并入 CAS UPDATE，端口在 history 后、settlement 前；未注入时 change 不带 snapshot', async () => {
  const { db, log, mark } = scriptedDb();
  const port = fakePort(mark);
  const { deps, onUpdated } = updateDeps(mark, port);
  const step = createOrderUpdateStep(deps);
  await db
    .transaction()
    .execute((trx) => step.apply(trx, current, union({ paid_at: deposit }), ctx));
  const sqls = log.map((s) => s.sql);
  const update = log.find((s) => s.sql.startsWith('update "app"."orders"'))!;
  expect(update.sql).toContain('"paid_at_source"');
  expect(update.parameters).toContain('platform_modified');
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    paidAt: union().modified_at,
    paidAtSource: 'platform_modified',
    nBaseFen: 480n,
  });
  expect(
    sqls.findIndex((s) => s.startsWith('insert into "app"."order_status_history"')),
  ).toBeLessThan(sqls.indexOf('snapshot.create'));
  expect(sqls.indexOf('snapshot.create')).toBeLessThan(sqls.indexOf('rebate.onUpdated'));
  expect(onUpdated.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'created' });
  expect(deps.logger?.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'PID_SCENE_NOT_FOUND', outcome: 'snapshot_scene_unknown' }),
    expect.any(String),
  );

  const bare = scriptedDb();
  const plain = updateDeps(bare.mark);
  await bare.db
    .transaction()
    .execute((trx) => createOrderUpdateStep(plain.deps).apply(trx, current, union(), ctx));
  expect(plain.onUpdated.mock.calls[0]?.[1]).not.toHaveProperty('snapshot');
  expect(
    bare.log.some((s) => s.sql.includes('order_status_history') && s.sql.startsWith('select')),
  ).toBe(false);
});

it('[AC-B1-08k#U13] 晚于首次已付的观测时刻取旧历史；库内已有来源不覆盖', async () => {
  const firstPaid = at('2026-10-10T02:00:00.000Z');
  const { db, log, mark } = scriptedDb(() => [{ at: firstPaid }]);
  const port = fakePort(mark);
  const { deps } = updateDeps(mark, port);
  const paidRow = {
    ...current,
    platform_status: 'PAID',
    user_id: null,
    rebate_status: 'UNATTRIBUTED',
  };
  const withSource = { ...paidRow, paid_at_source: 'observed' } as Row;
  const users = { findByAttrCode: () => Promise.resolve(OWNER) };
  const step = createOrderUpdateStep({ ...deps, users });
  const order = union({
    paid_at: deposit,
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"abcd1234"}',
    },
  });
  await db.transaction().execute((trx) => step.apply(trx, withSource, order, ctx));
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    paidAt: firstPaid,
    paidAtSource: 'observed',
  });
  const update = log.find((s) => s.sql.startsWith('update "app"."orders"'))!;
  expect(update.sql).not.toContain('"paid_at_source"');
});
