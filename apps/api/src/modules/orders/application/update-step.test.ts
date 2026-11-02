// B1-08i 源码旁单元测试：更新步骤的写序、CAS 重读与整条拒收，以及告警事件与 order.updated 经同一个 events
// 总线、与写库同一事务入队（不连库：脚本化驱动只回预设结果，记录编译后的语句）。
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
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionOrder } from '../../union/index.ts';
import type { PlatformStatusEvent, StatusMap } from '../domain/status-map.ts';
import type { OrderPipelineContext } from './pipeline-types.ts';
import {
  createOrderUpdateStep,
  type OrderSettlementRecordsPort,
  type OrderUpdateDeps,
} from './update-step.ts';

const NOW = '2026-10-17T17:30:00.000Z';
const PENDING_ID = 77n;
const at = (iso: string) => new FixedClock(iso).now();

type Row = Selectable<DB['orders']>;

interface PendingRow {
  id: bigint;
  inserted: boolean;
  raw_status: string | null;
  detail: string | null;
}

/** writePending 的 returning 回行：默认是同键 open 已存在、存量两列为空的行。 */
function pendingRow(patch: Partial<PendingRow> = {}): PendingRow {
  return { id: PENDING_ID, inserted: false, raw_status: null, detail: null, ...patch };
}

function scriptedDb(
  updatedRows: () => bigint,
  reread: () => Row | undefined,
  pendingRows: PendingRow[] = [pendingRow({ inserted: true })],
) {
  const log: string[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: { sql: string }): Promise<QueryResult<R>> {
          log.push(compiled.sql);
          if (compiled.sql.startsWith('update "app"."orders"')) {
            return Promise.resolve({ rows: [], numAffectedRows: updatedRows() });
          }
          if (compiled.sql.startsWith('select') && compiled.sql.includes('"app"."orders"')) {
            const row = reread();
            return Promise.resolve({ rows: (row === undefined ? [] : [row]) as R[] });
          }
          if (compiled.sql.startsWith('insert into "app"."order_sync_pending"')) {
            return Promise.resolve({ rows: pendingRows as R[] });
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
  return { db, log };
}

const map: StatusMap = {
  platform: 'pdd',
  entries: new Map(
    (
      [
        ['paid', 'PLATFORM_PAID'],
        ['received', 'PLATFORM_RECEIVED'],
        ['rights', 'PLATFORM_RIGHTS'],
        ['punish', 'PLATFORM_PUNISH'],
      ] as [string, PlatformStatusEvent][]
    ).map(([code, event]) => [code, { event, source: 'unit', verified: false, note: '' }]),
  ),
};

const current = {
  order_id: '019a0000-0000-7000-8000-000000000001',
  app_id: 'unit-app',
  platform: 'pdd',
  sub_order_id: 'unit-child',
  attr_at: at('2026-10-15T16:00:00.000Z'),
  platform_status: 'RECEIVED',
  rebate_status: 'WAITING',
  row_version: 3,
  commission_version: 1,
  user_id: '019a0000-0000-7000-8000-000000000042',
  locked: false,
  pid: 'slot-ours',
  relation_id: null,
  sub_union_id: null,
  custom_params: null,
  pay_amount_fen: 100n,
  est_commission_fen: 10n,
  settle_commission_fen: null,
  received_at: at('2026-10-16T03:04:05.000Z'),
  platform_received_at: null,
  deposit_paid_at: null,
  paid_at: at('2026-10-15T16:00:00.000Z'),
  settled_at: null,
  platform_modified_at: null,
  parent_order_id: null,
  raw_item_id: 'unit-item',
  content_hash: 'old',
  raw_payload_id: 1n,
} as Row;

function incoming(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: null,
    promotion_slot: 'slot-ours',
    attr_params: { relation_id: null, sub_union_id: null, custom_parameters: null },
    raw_status: 'received',
    goods_id: 'unit-item',
    paid_fen: 100n,
    commission_fen: 20n,
    est_commission_fen: 20n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at('2026-10-15T16:00:00.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: null,
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

type Publish = OrderUpdateDeps['events']['publish'];
type Trx = Parameters<Publish>[0];

/** 每次入队在 order 里记 event:<事件名>；领域事件与告警事件都经这一个总线。 */
function deps(order: string[]): OrderUpdateDeps {
  return {
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    users: { findByAttrCode: vi.fn(() => Promise.resolve(null)) },
    bindings: { findByRelation: vi.fn(() => Promise.resolve([])) },
    rebate: {
      onUpdated: vi.fn<OrderUpdateDeps['rebate']['onUpdated']>(() => {
        order.push('rebate');
        return Promise.resolve();
      }),
      onUnmappedStatus: vi.fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>(() => {
        order.push('unmapped');
        return Promise.resolve();
      }),
    },
    events: {
      publish: vi.fn<Publish>((_trx, event) => {
        order.push(`event:${event.name}`);
        return Promise.resolve({ eventId: event.eventId ?? 'unit', duplicate: false });
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

it('[AC-B1-08i#U6] 首次 CAS 0 行 → 重读一次后按新状态重新判定并写入', async () => {
  const results = [0n, 1n];
  const { db, log } = scriptedDb(
    () => results.shift() ?? 0n,
    () => ({ ...current, row_version: 4 }),
  );
  const order: string[] = [];
  const step = createOrderUpdateStep(deps(order));
  const outcome = await db
    .transaction()
    .execute((trx) => step.apply(trx, current, incoming({ raw_status: 'received' }), ctx));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  const updates = log.filter((sql) => sql.startsWith('update "app"."orders"'));
  expect(updates).toHaveLength(2);
  expect(log.filter((sql) => sql.startsWith('select'))).toHaveLength(1);
  expect(order).toEqual(['rebate', 'event:order.updated']);
});

it('[AC-B1-08i#U7] 两次 CAS 都 0 行抛 ORDER_CAS_CONFLICT，不调用端口', async () => {
  const { db } = scriptedDb(
    () => 0n,
    () => current,
  );
  const order: string[] = [];
  const step = createOrderUpdateStep(deps(order));
  await expect(
    db.transaction().execute((trx) => step.apply(trx, current, incoming(), ctx)),
  ).rejects.toThrow('ORDER_CAS_CONFLICT');
  expect(order).toEqual([]);
});

it('[AC-B1-08i#U8] P10 倒退整条拒收：只写待处理（含说明），不 UPDATE、不调 settlement、不发 order.updated，只入队告警', async () => {
  const { db, log } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const step = createOrderUpdateStep(deps(order));
  const outcome = await db
    .transaction()
    .execute((trx) => step.apply(trx, current, incoming({ raw_status: 'paid' }), ctx));
  expect(outcome).toEqual({
    kind: 'pending',
    order_id: current.order_id,
    reason: 'ILLEGAL_TRANSITION',
  });
  expect(log.some((sql) => sql.startsWith('update'))).toBe(false);
  expect(
    log.filter((sql) => sql.startsWith('insert into "app"."order_sync_pending"')),
  ).toHaveLength(1);
  expect(order).toEqual(['event:order.illegal_transition']);
});

it('[AC-B1-08i#U9] P8 维权与处罚：change 相同，第三参数带各自的映射事件与原始码供 settlement 选 order_rights 类型', async () => {
  const calls: Parameters<OrderUpdateDeps['rebate']['onUpdated']>[] = [];
  for (const raw of ['rights', 'punish'] as const) {
    const { db } = scriptedDb(
      () => 1n,
      () => current,
    );
    const order: string[] = [];
    const d = deps(order);
    const step = createOrderUpdateStep(d);
    const outcome = await db
      .transaction()
      .execute((trx) => step.apply(trx, current, incoming({ raw_status: raw }), ctx));
    expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
    expect(order).toEqual(['rebate', 'event:order.updated']);
    const onUpdated = vi.mocked(d.rebate.onUpdated);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    const call = onUpdated.mock.calls[0];
    if (call) calls.push(call);
  }
  const [rights, punish] = calls;
  expect(rights?.[1]).toMatchObject({ from_status: 'RECEIVED', to_status: 'RECEIVED', rule: 'P8' });
  expect(punish?.[1]).toEqual(rights?.[1]);
  expect(rights?.[2]).toEqual({ event: 'PLATFORM_RIGHTS', raw_status: 'rights' });
  expect(punish?.[2]).toEqual({ event: 'PLATFORM_PUNISH', raw_status: 'punish' });
});

it('[AC-B1-08i#U10] 表外码未入账：onUnmappedStatus 与 onUpdated 的第三参数同为事件空、原始码原样', async () => {
  const { db } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const d = deps(order);
  const step = createOrderUpdateStep(d);
  const outcome = await db
    .transaction()
    .execute((trx) => step.apply(trx, current, incoming({ raw_status: ' Unit-Unknown ' }), ctx));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  expect(order).toEqual(['unmapped', 'rebate', 'event:order.updated']);
  const source = { event: null, raw_status: ' Unit-Unknown ' };
  expect(vi.mocked(d.rebate.onUnmappedStatus).mock.calls[0]?.[2]).toEqual(source);
  expect(vi.mocked(d.rebate.onUpdated).mock.calls[0]?.[2]).toEqual(source);
  expect(vi.mocked(d.rebate.onUpdated).mock.calls[0]?.[1]).toMatchObject({
    to_status: 'RECEIVED',
    rule: null,
  });
});

// —— 告警事件（D10-47 / D10-48 / D10-57；BR-ATTR-01 ⑦、BR-ATTR-07、BR-FUND-01 P10）——

/** deps 加补丁，并交回它的 events.publish（领域事件与告警事件共用）。 */
function withBus(order: string[], patch: Partial<OrderUpdateDeps> = {}) {
  const d: OrderUpdateDeps = { ...deps(order), ...patch };
  return { d, publish: vi.mocked(d.events.publish) };
}

const named = (publish: ReturnType<typeof withBus>['publish'], name: string) =>
  publish.mock.calls.filter(([, event]) => event.name === name);

/** 在一个事务里跑一次 apply，同时交回该事务对象，供断言「同一 trx」。 */
async function run(
  db: ReturnType<typeof scriptedDb>['db'],
  d: OrderUpdateDeps,
  row: Row,
  order: UnionOrder,
  context: OrderPipelineContext = ctx,
) {
  let seen: Trx | undefined;
  const outcome = await db.transaction().execute((trx) => {
    seen = trx;
    return createOrderUpdateStep(d).apply(trx, row, order, context);
  });
  return { outcome, trx: seen };
}

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it.each([
  {
    label: 'P10 倒退',
    row: current,
    raw: 'paid',
    rule: 'P10',
    from: 'RECEIVED',
    event: 'PLATFORM_PAID',
  },
  {
    label: '表外事件',
    row: { ...current, platform_status: 'DEPOSIT_PAID', received_at: null } as Row,
    raw: 'rights',
    rule: 'illegal',
    from: 'DEPOSIT_PAID',
    event: 'PLATFORM_RIGHTS',
  },
])(
  '[AC-B1-08i#U11] $label 整条拒收：写待处理后同一 trx 入队 order.illegal_transition，载荷只有 id 与枚举，重复判出事件 ID 不变',
  async ({ row, raw, rule, from, event }) => {
    const { db, log } = scriptedDb(
      () => 1n,
      () => row,
    );
    const order: string[] = [];
    const { d, publish } = withBus(order);
    const first = await run(db, d, row, incoming({ raw_status: raw }));
    expect(first.outcome).toEqual({
      kind: 'pending',
      order_id: current.order_id,
      reason: 'ILLEGAL_TRANSITION',
    });
    expect(log.some((sql) => sql.startsWith('update'))).toBe(false);
    expect(order).toEqual(['event:order.illegal_transition']);
    expect(publish).toHaveBeenCalledTimes(1);
    const [trx, published] = publish.mock.calls[0] ?? [];
    expect(trx).toBe(first.trx);
    expect(published).toEqual({
      appId: current.app_id,
      name: 'order.illegal_transition',
      payload: {
        order_id: current.order_id,
        pending_id: String(PENDING_ID),
        platform: 'pdd',
        reason: 'ILLEGAL_TRANSITION',
        rule,
        from_status: from,
        event,
        outcome: 'rejected',
      },
      eventId: expect.stringMatching(UUID_V8),
    });
    const text = JSON.stringify(published);
    for (const secret of [current.sub_order_id, current.user_id ?? '', raw]) {
      expect(text).not.toContain(`"${secret}"`);
    }
    // 同一条 open 待处理记录上再次判出同样的非法迁移：同一个事件 ID（总线按 ID 去重）。
    const again = await run(db, d, row, incoming({ raw_status: raw, raw_payload_id: '3' }));
    expect(again.outcome).toEqual(first.outcome);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[1].eventId).toBe(published?.eventId);
  },
);

it('[AC-B1-08i#U12] P10 开关关：照常写后与待处理同一 trx、同一总线入队 order.illegal_transition（status_kept），排在 order.updated 之后', async () => {
  const { db } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const { d, publish } = withBus(order, { regressionHold: () => false });
  const { outcome, trx } = await run(db, d, current, incoming({ raw_status: 'paid' }));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  expect(order).toEqual(['rebate', 'event:order.updated', 'event:order.illegal_transition']);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls[0]?.[0]).toBe(trx);
  expect(publish.mock.calls[1]?.[0]).toBe(trx);
  expect(vi.mocked(d.rebate.onUpdated).mock.calls[0]?.[0]).toBe(trx);
  expect(publish.mock.calls[1]?.[1]).toMatchObject({
    name: 'order.illegal_transition',
    payload: {
      order_id: current.order_id,
      pending_id: String(PENDING_ID),
      rule: 'P10',
      from_status: 'RECEIVED',
      event: 'PLATFORM_PAID',
      outcome: 'status_kept',
    },
  });
});

it('[AC-B1-08i#U13] 已归属订单归因参数变化：参数列不写，同一 trx 入队 order.attr_param_changed，载荷只列变化的列名', async () => {
  const { db, log } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const { d, publish } = withBus(order);
  const changed = incoming({
    raw_status: 'received',
    attr_params: {
      relation_id: 'unit-rel-new',
      sub_union_id: null,
      custom_parameters: 'unit-buyer',
    },
  });
  const { outcome, trx } = await run(db, d, current, changed);
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  const update = log.find((sql) => sql.startsWith('update "app"."orders"')) ?? '';
  for (const column of ['"pid"', '"relation_id"', '"sub_union_id"', '"custom_params"']) {
    expect(update.split(' where ')[0]).not.toContain(column);
  }
  expect(order).toEqual(['rebate', 'event:order.updated', 'event:order.attr_param_changed']);
  const alerts = named(publish, 'order.attr_param_changed');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.[0]).toBe(trx);
  expect(alerts[0]?.[1]).toEqual({
    appId: current.app_id,
    name: 'order.attr_param_changed',
    payload: {
      order_id: current.order_id,
      platform: 'pdd',
      changed: ['relation_id', 'custom_params'],
    },
  });
  const text = JSON.stringify(alerts[0]?.[1]);
  expect(text).not.toContain('unit-rel-new');
  expect(text).not.toContain('unit-buyer');
});

it('[AC-B1-08i#U14] 未归因订单重跑归属遇淘宝绑定冲突：不写 user_id，同一 trx 入队 order.attr_binding_conflict', async () => {
  const row = { ...current, platform: 'taobao', user_id: null } as Row;
  const { db, log } = scriptedDb(
    () => 1n,
    () => row,
  );
  const order: string[] = [];
  const bound = at('2026-10-01T00:00:00.000Z');
  const { d, publish } = withBus(order, {
    bindings: {
      findByRelation: vi.fn(() =>
        Promise.resolve([
          { user_id: 'unit-user-a', bound_at: bound, released_at: null, cooldown_until: null },
          { user_id: 'unit-user-b', bound_at: bound, released_at: null, cooldown_until: null },
        ]),
      ),
    },
  });
  const taobao = incoming({
    platform: 'taobao',
    raw_status: 'received',
    attr_params: { relation_id: 'unit-rel', sub_union_id: null, custom_parameters: null },
  });
  const { outcome, trx } = await run(db, d, row, taobao, { ...ctx, platform: 'taobao' });
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  const update = log.find((sql) => sql.startsWith('update "app"."orders"')) ?? '';
  expect(update.split(' where ')[0]).not.toContain('"user_id"');
  expect(order).toEqual(['rebate', 'event:order.updated', 'event:order.attr_binding_conflict']);
  const alerts = named(publish, 'order.attr_binding_conflict');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.[0]).toBe(trx);
  expect(alerts[0]?.[1]).toEqual({
    appId: current.app_id,
    name: 'order.attr_binding_conflict',
    payload: { order_id: current.order_id, platform: 'taobao' },
  });
  expect(JSON.stringify(alerts[0]?.[1])).not.toContain('unit-user-');
});

it('[AC-B1-08i#U15] 映射表外的码（已入账整条拒收、未入账照常写）不入队 order.illegal_transition', async () => {
  for (const rebate of ['CREDITED', 'WAITING']) {
    const row = { ...current, rebate_status: rebate } as Row;
    const { db } = scriptedDb(
      () => 1n,
      () => row,
    );
    const order: string[] = [];
    const { d, publish } = withBus(order);
    const { outcome } = await run(db, d, row, incoming({ raw_status: 'unit-unknown' }));
    expect(outcome.kind).toBe(rebate === 'CREDITED' ? 'pending' : 'updated');
    expect(named(publish, 'order.illegal_transition')).toEqual([]);
    expect(order).toEqual(
      rebate === 'CREDITED' ? [] : ['unmapped', 'rebate', 'event:order.updated'],
    );
  }
});

it.each([
  { label: 'P10 倒退整条拒收', hold: true, outcome: 'rejected' },
  { label: 'P10 开关关照常写', hold: false, outcome: 'status_kept' },
])(
  '[AC-B1-08i#U18] $label：order.illegal_transition 入队抛错原样抛出、不打已处理日志，由所在事务整体回滚',
  async ({ hold, outcome }) => {
    const { db } = scriptedDb(
      () => 1n,
      () => current,
    );
    const order: string[] = [];
    const failure = new Error('unit-bus-failure');
    const { d, publish } = withBus(order, { regressionHold: () => hold });
    publish.mockImplementation((_trx, event) => {
      order.push(`event:${event.name}`);
      return event.name === 'order.illegal_transition'
        ? Promise.reject(failure)
        : Promise.resolve({ eventId: 'unit', duplicate: false });
    });
    await expect(run(db, d, current, incoming({ raw_status: 'paid' }))).rejects.toBe(failure);
    expect(order).toEqual(
      hold
        ? ['event:order.illegal_transition']
        : ['rebate', 'event:order.updated', 'event:order.illegal_transition'],
    );
    expect(named(publish, 'order.illegal_transition')[0]?.[1]).toMatchObject({
      payload: { outcome },
    });
    // 失败的这次不打「已拒收 / 已照写」告警日志，也不打 updated。
    expect(vi.mocked(d.logger!.error)).not.toHaveBeenCalled();
    expect(vi.mocked(d.logger!.info)).not.toHaveBeenCalled();
  },
);

const P10_DETAIL = 'order_illegal_transition P10 RECEIVED→PLATFORM_PAID';

it.each([
  {
    label: 'P10 倒退新开待处理',
    rebate: 'WAITING',
    raw: 'paid',
    reason: 'ILLEGAL_TRANSITION',
    rows: [pendingRow({ inserted: true, raw_status: 'paid', detail: P10_DETAIL })],
    logs: 1,
    events: ['event:order.illegal_transition'],
  },
  {
    label: 'P10 倒退真重复',
    rebate: 'WAITING',
    raw: 'paid',
    reason: 'ILLEGAL_TRANSITION',
    rows: [pendingRow({ raw_status: 'paid', detail: P10_DETAIL })],
    logs: 0,
    events: ['event:order.illegal_transition'],
  },
  {
    label: 'P10 倒退存量 detail 为空（首次入库路径开的行）',
    rebate: 'WAITING',
    raw: 'paid',
    reason: 'ILLEGAL_TRANSITION',
    rows: [pendingRow({ raw_status: 'paid', detail: null })],
    logs: 1,
    events: ['event:order.illegal_transition'],
  },
  {
    label: 'P10 倒退存量 detail 不同',
    rebate: 'WAITING',
    raw: 'paid',
    reason: 'ILLEGAL_TRANSITION',
    rows: [pendingRow({ raw_status: 'paid', detail: 'order_illegal_transition P10 other' })],
    logs: 1,
    events: ['event:order.illegal_transition'],
  },
  {
    label: '表外码真重复（detail 都为空）',
    rebate: 'CREDITED',
    raw: 'unit-unknown',
    reason: 'UNMAPPED_STATUS',
    rows: [pendingRow({ raw_status: 'unit-unknown' })],
    logs: 0,
    events: [],
  },
  {
    label: '表外码同键 open 已存在但 raw_status 不同',
    rebate: 'CREDITED',
    raw: 'unit-unknown',
    reason: 'UNMAPPED_STATUS',
    rows: [pendingRow({ raw_status: 'unit-other' })],
    logs: 1,
    events: [],
  },
  {
    label: '表外码新开待处理',
    rebate: 'CREDITED',
    raw: 'unit-unknown',
    reason: 'UNMAPPED_STATUS',
    rows: [pendingRow({ inserted: true, raw_status: 'unit-unknown' })],
    logs: 1,
    events: [],
  },
  {
    label: '表外码驱动未回行（无从判断，宁多不漏）',
    rebate: 'CREDITED',
    raw: 'unit-unknown',
    reason: 'UNMAPPED_STATUS',
    rows: [],
    logs: 1,
    events: [],
  },
])(
  '[AC-B1-08i#U20] $label：整条拒收的 P1 日志只有真重复不打，事件、待处理写入与返回值不变',
  async ({ rebate, raw, reason, rows, logs, events }) => {
    const row = { ...current, rebate_status: rebate } as Row;
    const { db, log } = scriptedDb(
      () => 1n,
      () => row,
      rows,
    );
    const order: string[] = [];
    const { d } = withBus(order);
    const { outcome } = await run(db, d, row, incoming({ raw_status: raw }));
    expect(outcome).toEqual({ kind: 'pending', order_id: current.order_id, reason });
    expect(
      log.filter((sql) => sql.startsWith('insert into "app"."order_sync_pending"')),
    ).toHaveLength(1);
    expect(order).toEqual(events);
    expect(vi.mocked(d.logger!.error)).toHaveBeenCalledTimes(logs);
  },
);

const settledMap: StatusMap = {
  platform: 'pdd',
  entries: new Map([
    ...map.entries,
    ['settled', { event: 'PLATFORM_SETTLED', source: 'unit', verified: false, note: '' }],
  ]),
};
const SETTLED_AT = at('2026-10-17T04:05:06.000Z');

/** deps 加结算记录端口：两个方法都往 order 里记名字。 */
function withRecords(order: string[], statementFen: bigint | null = null) {
  const base = deps(order);
  const recordApi = vi.fn<OrderSettlementRecordsPort['recordApi']>(() => {
    order.push('recordApi');
    return Promise.resolve();
  });
  const latestStatementFen = vi.fn<OrderSettlementRecordsPort['latestStatementFen']>(() => {
    order.push('latestStatementFen');
    return Promise.resolve(statementFen);
  });
  const rebate = { ...base.rebate, settlements: { recordApi, latestStatementFen } };
  return { d: { ...base, statusMaps: () => settledMap, rebate }, recordApi };
}

function updateSql(log: readonly string[]): string {
  const sql = log.find((text) => text.startsWith('update "app"."orders"'));
  if (sql === undefined) throw new Error('no orders update');
  return sql;
}

it('[AC-B2-04zj#U3] 结算额算数：读 STATEMENT → 写列 → 记录 → settlement 端口；记录拿报文原值与库内结算时间', async () => {
  const { db, log } = scriptedDb(
    () => 1n,
    () => undefined,
  );
  const order: string[] = [];
  const { d, recordApi } = withRecords(order);
  const report = incoming({
    raw_status: 'settled',
    settle_commission_fen: 15n,
    settled_at: SETTLED_AT,
  });
  await db
    .transaction()
    .execute((trx) => createOrderUpdateStep(d).apply(trx, current, report, ctx));
  expect(order).toEqual(['latestStatementFen', 'recordApi', 'rebate', 'event:order.updated']);
  expect(recordApi.mock.calls[0]?.[1]).toEqual({
    appId: current.app_id,
    orderId: current.order_id,
    commissionFen: 15n,
    reportedSettledAt: SETTLED_AT,
    orderSettledAt: null,
  });
  expect(updateSql(log)).toContain('"union_settled_at" =');
});

it('[AC-B2-04zj#U4] 有 STATEMENT：给 settlement 的是 STATEMENT 金额，记录仍是报文金额', async () => {
  const { db } = scriptedDb(
    () => 1n,
    () => undefined,
  );
  const order: string[] = [];
  const { d, recordApi } = withRecords(order, 12n);
  const report = incoming({ raw_status: 'settled', settle_commission_fen: 15n });
  await db
    .transaction()
    .execute((trx) => createOrderUpdateStep(d).apply(trx, current, report, ctx));
  expect(recordApi.mock.calls[0]?.[1]).toMatchObject({
    commissionFen: 15n,
    reportedSettledAt: null,
  });
  expect(vi.mocked(d.rebate.onUpdated).mock.calls[0]?.[1]).toMatchObject({
    settle_commission_fen: 12n,
  });
});

it('[AC-B2-04zj#U5] 结算额不算数不记录；union_settled_at 报文给了就写，不看状态与结算额；没给不进 UPDATE', async () => {
  const { db, log } = scriptedDb(
    () => 1n,
    () => undefined,
  );
  const order: string[] = [];
  const { d, recordApi } = withRecords(order);
  const step = createOrderUpdateStep(d);
  const given = incoming({ raw_status: 'received', settled_at: SETTLED_AT });
  await db.transaction().execute((trx) => step.apply(trx, current, given, ctx));
  expect(updateSql(log)).toContain('"union_settled_at" =');
  log.length = 0;
  const absent = incoming({ raw_status: 'settled', settle_commission_fen: null });
  await db.transaction().execute((trx) => step.apply(trx, current, absent, ctx));
  expect(updateSql(log)).not.toContain('"union_settled_at"');
  expect(recordApi).not.toHaveBeenCalled();
});

it('[AC-B2-04zj#U6] CAS 两次未命中不写记录；整条拒收连 STATEMENT 都不读', async () => {
  const { db } = scriptedDb(
    () => 0n,
    () => current,
  );
  const order: string[] = [];
  const { d, recordApi } = withRecords(order);
  const step = createOrderUpdateStep(d);
  const report = incoming({ raw_status: 'settled', settle_commission_fen: 15n });
  await expect(
    db.transaction().execute((trx) => step.apply(trx, current, report, ctx)),
  ).rejects.toThrow('ORDER_CAS_CONFLICT');
  expect(recordApi).not.toHaveBeenCalled();

  order.length = 0;
  const backward = { ...current, platform_status: 'SETTLED' } as Row;
  const late = incoming({ raw_status: 'received', settle_commission_fen: 15n });
  await db.transaction().execute((trx) => step.apply(trx, backward, late, ctx));
  expect(order).not.toContain('latestStatementFen');
  expect(recordApi).not.toHaveBeenCalled();
});
