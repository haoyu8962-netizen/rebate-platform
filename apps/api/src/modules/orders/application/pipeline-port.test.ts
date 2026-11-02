// B1-08h 源码旁单元测试：BR-ATTR-01 开启乱序判定、平台没给修改时间时，首次入库（新建订单行）也累加
// order_sync_no_mtime（D10-39）；B1-08i：首次入库的告警事件与 order.created 经同一个 events 总线、与写库同一事务
// 入队，入队失败整事务回滚。不连库：DummyDriver 不回任何行
// （锁后读 order_keys 为空 → 新子订单；写待处理时回一个 id），只记录编译后的语句与事务边界。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionOrder } from '../../union/index.ts';
import type { PlatformStatusEvent, StatusMap } from '../domain/status-map.ts';
import type { CommissionSnapshotPort } from './commission-snapshot-step.ts';
import { createOrderPipeline } from './pipeline-port.ts';
import type { OrderPipelineContext, OrderPipelineDeps } from './pipeline-types.ts';
import type { OrderSettlementRecordsPort } from './update-step.ts';

const NOW = '2026-10-17T17:30:00.000Z'; // +08:00 日 2026-10-18
const ATTR = '2026-10-15T16:00:00.000Z'; // +08:00 日 2026-10-16
const APP = 'unit-app';
const USER = '019a0000-0000-7000-8000-000000000042';
const PENDING_ID = 91n;
const at = (iso: string) => new FixedClock(iso).now();

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function recordingDb(): { db: Kysely<DB>; statements: Statement[] } {
  const statements: Statement[] = [];
  const mark = (sql: string): Promise<void> => {
    statements.push({ sql, parameters: [] });
    return Promise.resolve();
  };
  class RecordingDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: { sql: string }): Promise<QueryResult<R>> {
          const pending = compiled.sql.startsWith('insert into "app"."order_sync_pending"');
          return Promise.resolve({ rows: (pending ? [{ id: PENDING_ID }] : []) as R[] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
    override beginTransaction(): Promise<void> {
      return mark('begin');
    }
    override commitTransaction(): Promise<void> {
      return mark('commit');
    }
    override rollbackTransaction(): Promise<void> {
      return mark('rollback');
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        statements.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });
  return { db, statements };
}

function statusMap(platform: string): StatusMap {
  const events: [string, PlatformStatusEvent][] = [
    ['paid', 'PLATFORM_PAID'],
    ['rights', 'PLATFORM_RIGHTS'],
  ];
  return {
    platform,
    entries: new Map(
      events.map(([code, event]) => [code, { event, source: 'unit', verified: false, note: '' }]),
    ),
  };
}

function order(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: 'unit-parent',
    promotion_slot: 'slot-ours',
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"abcd1234"}',
    },
    raw_status: 'paid',
    goods_id: 'unit-item',
    paid_fen: 12345n,
    commission_fen: 789n,
    est_commission_fen: 789n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at(ATTR),
    received_at: null,
    settled_at: null,
    modified_at: null,
    raw_payload_id: '101',
    ...patch,
  };
}

const ctx: OrderPipelineContext = {
  app_id: APP,
  platform: 'pdd',
  union_account_id: 'unit-account',
  query_kind: 'increment',
  scene: '-',
  window_start: '2026-10-01T00:00:00.000Z',
  window_end: NOW,
  requestId: 'unit-request',
};

function setup(overrides: Partial<OrderPipelineDeps> = {}) {
  const { db, statements } = recordingDb();
  const onImported = vi.fn<OrderPipelineDeps['rebate']['onImported']>(() => {
    statements.push({ sql: 'rebate.onImported', parameters: [] });
    return Promise.resolve();
  });
  const deps: OrderPipelineDeps = {
    db,
    clock: new FixedClock(NOW),
    statusMaps: statusMap,
    pids: {
      find: () => Promise.resolve([{ pid_scene: 'self_buy', status: 'active', site_id: null }]),
    },
    accounts: { syncStartAt: () => Promise.resolve(at('2026-10-01T00:00:00.000Z')) },
    users: { findByAttrCode: () => Promise.resolve(USER) },
    bindings: { findByRelation: () => Promise.resolve([]) },
    rebate: { onImported },
    ...overrides,
  };
  return { pipeline: createOrderPipeline(deps), statements, onImported };
}

const isCounter = (s: Statement) => s.sql.includes('"app"."order_sync_counters"');
const writesOrder = (s: Statement) =>
  s.sql.startsWith('insert into "app"."order_keys"') ||
  s.sql.startsWith('insert into "app"."orders"');

it.each([
  { deposit: null, day: '2026-10-16' },
  // 预售：attr_at 取定金时刻（UTC 15:59:59.999 = +08:00 当日 23:59:59.999）。
  { deposit: '2026-10-14T15:59:59.999Z', day: '2026-10-14' },
])(
  '[AC-B1-08h#U6] 开启排序且无 mtime：首次入库同事务计一次 order_sync_no_mtime，日期取 attr_at（定金 $deposit）',
  async ({ deposit, day }) => {
    const { pipeline, statements, onImported } = setup({ mtimeOrdering: () => true });
    const incoming = order({ deposit_paid_at: deposit === null ? null : at(deposit) });
    await expect(pipeline.process(incoming, ctx)).resolves.toMatchObject({ kind: 'inserted' });
    const counters = statements.filter(isCounter);
    expect(counters).toHaveLength(1);
    expect(counters[0]!.parameters).toEqual([APP, 'pdd', day, 'order_sync_no_mtime', 1n]);
    expect(counters[0]!.sql).toContain('on conflict ("app_id", "platform", "date", "counter")');
    // 同一事务：在 begin 与 commit 之间，写订单之后、返利首态端口之前。
    const index = statements.indexOf(counters[0]!);
    const ordersAt = statements.findIndex((s) => s.sql.startsWith('insert into "app"."orders"'));
    expect(statements[0]!.sql).toBe('begin');
    expect(statements.at(-1)!.sql).toBe('commit');
    expect(statements.filter((s) => s.sql === 'begin' || s.sql === 'commit')).toHaveLength(2);
    expect(ordersAt).toBeGreaterThan(0);
    expect(index).toBeGreaterThan(ordersAt);
    expect(index).toBeLessThan(statements.findIndex((s) => s.sql === 'rebate.onImported'));
    expect(onImported).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { label: '排序关', mtimeOrdering: () => false, modified: null },
  { label: '未注入排序（默认关）', mtimeOrdering: undefined, modified: null },
  { label: '排序开但有 mtime', mtimeOrdering: () => true, modified: '2026-10-16T08:09:10.000Z' },
])(
  '[AC-B1-08h#U7] $label：首次入库不计 order_sync_no_mtime',
  async ({ mtimeOrdering, modified }) => {
    const { pipeline, statements } = setup(mtimeOrdering === undefined ? {} : { mtimeOrdering });
    const incoming = order({ modified_at: modified === null ? null : at(modified) });
    await expect(pipeline.process(incoming, ctx)).resolves.toMatchObject({ kind: 'inserted' });
    expect(statements.some(writesOrder)).toBe(true);
    expect(statements.filter(isCounter)).toEqual([]);
  },
);

it.each([
  { label: 'PID_NOT_OURS', deps: { pids: { find: () => Promise.resolve([]) } }, patch: {} },
  { label: 'NO_PAY_TIME', deps: {}, patch: { paid_at: null, deposit_paid_at: null } },
  {
    label: 'BEFORE_SYNC_START',
    deps: { accounts: { syncStartAt: () => Promise.resolve(at('2026-10-15T16:00:00.001Z')) } },
    patch: {},
  },
  { label: 'UNMAPPED_STATUS', deps: {}, patch: { raw_status: 'outside-map' } },
  { label: 'ILLEGAL_TRANSITION', deps: {}, patch: { raw_status: 'rights' } },
] satisfies { label: string; deps: Partial<OrderPipelineDeps>; patch: Partial<UnionOrder> }[])(
  '[AC-B1-08h#U8] 开启排序且无 mtime，但 $label 不建行：不计 order_sync_no_mtime',
  async ({ label, deps, patch }) => {
    const { pipeline, statements, onImported } = setup({ ...deps, mtimeOrdering: () => true });
    const result = await pipeline.process(order(patch), ctx);
    expect(['dropped', 'pending']).toContain(result.kind);
    expect(result.reason).toBe(label);
    expect(statements.some(writesOrder)).toBe(false);
    expect(statements.filter(isCounter)).toEqual([]);
    expect(onImported).not.toHaveBeenCalled();
  },
);

// —— 告警事件（B1-08i；D10-47 / D10-48 / D10-57：与领域事件同一个 events 总线）——

type Publish = NonNullable<OrderPipelineDeps['events']>['publish'];

/** 事件总线替身：每次入队在语句流里记 event:<事件名>（参数为是否在事务内）。 */
function bus(statements: Statement[]) {
  return vi.fn<Publish>((trx, event) => {
    statements.push({ sql: `event:${event.name}`, parameters: [trx.isTransaction] });
    return Promise.resolve({ eventId: event.eventId ?? 'unit', duplicate: false });
  });
}

it('[AC-B1-08i#U16] 首态为表外事件（非法首态）：不建行，写待处理后同一事务入队 order.illegal_transition；映射表外的码不入队', async () => {
  const publish = vi.fn<Publish>();
  const { pipeline, statements } = setup({ events: { publish } });
  publish.mockImplementation(bus(statements));
  const result = await pipeline.process(order({ raw_status: 'rights' }), ctx);
  expect(result).toEqual({ kind: 'pending', reason: 'ILLEGAL_TRANSITION' });
  expect(statements.some(writesOrder)).toBe(false);
  const sqls = statements.map((s) => s.sql);
  const pendingAt = sqls.findIndex((sql) =>
    sql.startsWith('insert into "app"."order_sync_pending"'),
  );
  const alertAt = sqls.indexOf('event:order.illegal_transition');
  expect(sqls[0]).toBe('begin');
  expect(sqls.at(-1)).toBe('commit');
  expect(pendingAt).toBeGreaterThan(0);
  expect(alertAt).toBeGreaterThan(pendingAt);
  expect(statements[alertAt]?.parameters).toEqual([true]);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]?.[1]).toEqual({
    appId: APP,
    name: 'order.illegal_transition',
    payload: {
      order_id: null,
      pending_id: String(PENDING_ID),
      platform: 'pdd',
      reason: 'ILLEGAL_TRANSITION',
      rule: 'illegal',
      from_status: null,
      event: 'PLATFORM_RIGHTS',
      outcome: 'rejected',
    },
    eventId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  });
  expect(JSON.stringify(publish.mock.calls[0]?.[1])).not.toContain('unit-child');

  const unmapped = setup({ events: { publish } });
  await expect(
    unmapped.pipeline.process(order({ raw_status: 'outside-map' }), ctx),
  ).resolves.toEqual({
    kind: 'pending',
    reason: 'UNMAPPED_STATUS',
  });
  expect(publish).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08i#U17] 首次入库遇淘宝绑定冲突：未归因入库，与 order.created 同一总线、同一 trx（与返利首态端口同一 trx）入队 order.attr_binding_conflict', async () => {
  const publish = vi.fn<Publish>();
  const bound = at('2026-10-01T00:00:00.000Z');
  const { pipeline, statements, onImported } = setup({
    events: { publish },
    bindings: {
      findByRelation: () =>
        Promise.resolve([
          { user_id: 'unit-user-a', bound_at: bound, released_at: null, cooldown_until: null },
          { user_id: 'unit-user-b', bound_at: bound, released_at: null, cooldown_until: null },
        ]),
    },
  });
  publish.mockImplementation(bus(statements));
  const taobao = order({
    platform: 'taobao',
    attr_params: { relation_id: 'unit-rel', sub_union_id: null, custom_parameters: null },
  });
  const result = await pipeline.process(taobao, { ...ctx, platform: 'taobao' });
  expect(result).toMatchObject({ kind: 'inserted' });
  expect(onImported.mock.calls[0]?.[1]).toMatchObject({ attributed: false });
  expect(publish.mock.calls.map(([, event]) => event.name)).toEqual([
    'order.created',
    'order.attr_binding_conflict',
  ]);
  for (const [trx] of publish.mock.calls) expect(trx).toBe(onImported.mock.calls[0]?.[0]);
  expect(publish.mock.calls[0]?.[1]).toMatchObject({ payload: { attributed: false } });
  expect(publish.mock.calls[1]?.[1]).toEqual({
    appId: APP,
    name: 'order.attr_binding_conflict',
    payload: { order_id: result.order_id, platform: 'taobao' },
  });
  expect(JSON.stringify(publish.mock.calls[1]?.[1])).not.toContain('unit-user-');
  const sqls = statements.map((s) => s.sql);
  expect(sqls.indexOf('event:order.attr_binding_conflict')).toBeGreaterThan(
    sqls.indexOf('rebate.onImported'),
  );
  expect(sqls.at(-1)).toBe('commit');
});

it.each([
  { label: '非法首态', alert: 'order.illegal_transition', patch: { raw_status: 'rights' } },
  {
    label: '淘宝绑定冲突',
    alert: 'order.attr_binding_conflict',
    patch: {
      platform: 'taobao',
      attr_params: { relation_id: 'unit-rel', sub_union_id: null, custom_parameters: null },
    },
  },
] satisfies { label: string; alert: string; patch: Partial<UnionOrder> }[])(
  '[AC-B1-08i#U19] $label：$alert 入队失败，待处理 / 订单写入随整事务回滚，错误原样抛出',
  async ({ alert, patch }) => {
    const failure = new Error('unit-bus-failure');
    const publish = vi.fn<Publish>();
    const bound = at('2026-10-01T00:00:00.000Z');
    const { pipeline, statements } = setup({
      events: { publish },
      bindings: {
        findByRelation: () =>
          Promise.resolve([
            { user_id: 'unit-user-a', bound_at: bound, released_at: null, cooldown_until: null },
            { user_id: 'unit-user-b', bound_at: bound, released_at: null, cooldown_until: null },
          ]),
      },
    });
    const record = bus(statements);
    publish.mockImplementation(async (trx, event) => {
      await record(trx, event);
      if (event.name === alert) throw failure;
      return { eventId: 'unit', duplicate: false };
    });
    const platform = patch.platform ?? 'pdd';
    await expect(pipeline.process(order(patch), { ...ctx, platform })).rejects.toBe(failure);
    const sqls = statements.map((s) => s.sql);
    expect(sqls[0]).toBe('begin');
    expect(sqls).toContain(`event:${alert}`);
    expect(sqls.at(-1)).toBe('rollback');
    expect(sqls).not.toContain('commit');
  },
);

const SETTLED_AT = at('2026-10-17T04:05:06.000Z');

function settledStatusMap(platform: string): StatusMap {
  const entries = new Map(statusMap(platform).entries);
  entries.set('settled', {
    event: 'PLATFORM_SETTLED',
    source: 'unit',
    verified: false,
    note: '',
  });
  return { platform, entries };
}

/** A pipeline over a status map with a settled code and the record port; both record their call. */
function settledPipeline(snapshots?: CommissionSnapshotPort) {
  const { db, statements } = recordingDb();
  const mark = (sql: string) => {
    statements.push({ sql, parameters: [] });
    return Promise.resolve();
  };
  const recordApi = vi.fn<OrderSettlementRecordsPort['recordApi']>(() => mark('recordApi'));
  const pipeline = createOrderPipeline({
    db,
    clock: new FixedClock(NOW),
    statusMaps: settledStatusMap,
    pids: {
      find: () => Promise.resolve([{ pid_scene: 'self_buy', status: 'active', site_id: null }]),
    },
    accounts: { syncStartAt: () => Promise.resolve(at('2026-10-01T00:00:00.000Z')) },
    users: { findByAttrCode: () => Promise.resolve(USER) },
    bindings: { findByRelation: () => Promise.resolve([]) },
    rebate: {
      onImported: () => mark('rebate.onImported'),
      settlements: {
        recordApi,
        latestStatementFen: () => Promise.reject(new Error('a first import reads no STATEMENT')),
      },
    },
    ...(snapshots === undefined ? {} : { snapshots }),
  });
  return { pipeline, statements, recordApi };
}

it('[AC-B2-04zj#U7] P12 有结算额：订单行之后、settlement 端口之前记一条，报文原值，订单回退为空', async () => {
  const { pipeline, statements, recordApi } = settledPipeline();
  const report = order({
    raw_status: 'settled',
    settle_commission_fen: 15n,
    settled_at: SETTLED_AT,
  });
  await expect(pipeline.process(report, ctx)).resolves.toMatchObject({ kind: 'inserted' });
  expect(recordApi.mock.calls[0]?.[1]).toMatchObject({
    appId: APP,
    commissionFen: 15n,
    reportedSettledAt: SETTLED_AT,
    orderSettledAt: null,
  });
  const sqls = statements.map((s) => s.sql);
  const inserted = sqls.findIndex((sql) => sql.startsWith('insert into "app"."orders"'));
  expect(sqls.indexOf('recordApi')).toBeGreaterThan(inserted);
  expect(sqls.indexOf('rebate.onImported')).toBeGreaterThan(sqls.indexOf('recordApi'));
  expect(sqls[inserted]).toContain('"settle_commission_fen"');
  expect(sqls[inserted]).toContain('"union_settled_at"');
});

it('[AC-B2-04zj#U8] P12 无结算额不记录，union_settled_at 仍随 INSERT 写', async () => {
  const { pipeline, statements, recordApi } = settledPipeline();
  const report = order({ raw_status: 'settled', settled_at: SETTLED_AT });
  await expect(pipeline.process(report, ctx)).resolves.toMatchObject({ kind: 'inserted' });
  expect(recordApi).not.toHaveBeenCalled();
  const insert = statements.find((s) => s.sql.startsWith('insert into "app"."orders"'));
  expect(insert?.parameters).toContainEqual(SETTLED_AT);
  expect(insert?.sql).toContain('"union_settled_at"');
});

function snapshotSpy() {
  const create = vi.fn<CommissionSnapshotPort['create']>(() =>
    Promise.resolve({ kind: 'existing' }),
  );
  return { create };
}

it('[AC-B2-04zj#U13] P12 有结算额：快照基数取将写入的结算额，不取预估（BR-CALC-02）', async () => {
  const snapshots = snapshotSpy();
  const { pipeline } = settledPipeline(snapshots);
  const report = order({
    raw_status: 'settled',
    est_commission_fen: 1000n,
    settle_commission_fen: 800n,
    service_fee_fen: 0n,
    settled_at: SETTLED_AT,
  });
  await pipeline.process(report, ctx);
  expect(snapshots.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 800n });
});

it('[AC-B2-04zj#U14] P12 结算额为 0 不回退预估；无结算额才取预估', async () => {
  const zero = snapshotSpy();
  await settledPipeline(zero).pipeline.process(
    order({
      raw_status: 'settled',
      est_commission_fen: 1000n,
      settle_commission_fen: 0n,
      service_fee_fen: 0n,
      settled_at: SETTLED_AT,
    }),
    ctx,
  );
  expect(zero.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 0n });

  const none = snapshotSpy();
  await settledPipeline(none).pipeline.process(
    order({
      raw_status: 'settled',
      est_commission_fen: 1000n,
      service_fee_fen: 0n,
      settled_at: SETTLED_AT,
    }),
    ctx,
  );
  expect(none.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 1000n });
});
