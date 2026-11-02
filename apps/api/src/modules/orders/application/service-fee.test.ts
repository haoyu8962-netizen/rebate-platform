// B1-08v 源码旁单元测试（实现者写）：orders.service_fee_fen 的写入与扫描读取。规则测试在
// test/spec/orders/service-fee-column/**。不连库：DummyDriver 只回预设结果，经 Kysely 日志记录编译后的语句与参数。
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
import { readSnapshotRetryInput } from '../infra/snapshot-retry-input.ts';
import { selectDueSubOrders } from '../infra/snapshot-retry-store.ts';
import { createOrderPipeline } from './pipeline-port.ts';
import type { OrderPipelineContext } from './pipeline-types.ts';
import { createOrderUpdateStep, type OrderUpdateDeps } from './update-step.ts';

const NOW = '2026-10-17T17:30:00.000Z';
const at = (iso: string) => new FixedClock(iso).now();

type Row = Selectable<DB['orders']>;

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** CAS UPDATE 回 1 行；待处理插入回一个 id；其余查询不回行（锁后读 order_keys 为空 → 新子订单）。 */
function recordingDb(): { db: Kysely<DB>; statements: Statement[] } {
  const statements: Statement[] = [];
  class RecordingDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: { sql: string }): Promise<QueryResult<R>> {
          if (compiled.sql.startsWith('update "app"."orders"')) {
            return Promise.resolve({ rows: [], numAffectedRows: 1n });
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

const map: StatusMap = {
  platform: 'pdd',
  entries: new Map(
    (
      [
        ['paid', 'PLATFORM_PAID'],
        ['received', 'PLATFORM_RECEIVED'],
      ] as [string, PlatformStatusEvent][]
    ).map(([code, event]) => [code, { event, source: 'unit', verified: false, note: '' }]),
  ),
};

function order(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: null,
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
    paid_at: at('2026-10-15T16:00:00.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: null,
    raw_payload_id: '101',
    service_fee_fen: 31n,
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

const current = {
  order_id: '019a0000-0000-7000-8000-000000000001',
  app_id: 'unit-app',
  platform: 'pdd',
  sub_order_id: 'unit-child',
  attr_at: at('2026-10-15T16:00:00.000Z'),
  platform_status: 'PAID',
  rebate_status: 'ESTIMATED',
  row_version: 3,
  commission_version: 1,
  user_id: '019a0000-0000-7000-8000-000000000042',
  locked: false,
  pid: 'slot-ours',
  relation_id: null,
  sub_union_id: null,
  custom_params: '{"app":"n","uid":"abcd1234"}',
  shop_id: null,
  source_match: 'none',
  buy_type: 'self',
  activity_type: null,
  is_presale: false,
  pay_amount_fen: 100n,
  est_commission_fen: 789n,
  settle_commission_fen: null,
  subsidy_commission_fen: null,
  received_at: null,
  platform_received_at: null,
  deposit_paid_at: null,
  paid_at: at('2026-10-15T16:00:00.000Z'),
  paid_at_source: 'platform',
  settled_at: null,
  platform_modified_at: null,
  parent_order_id: null,
  raw_item_id: 'unit-item',
  content_hash: 'old',
  raw_payload_id: 1n,
  service_fee_fen: 31n,
} as Row;

/** 单行 INSERT：列清单与 $n 一一对应（所有值都是参数）。 */
function insertedValue(statement: Statement, column: string): unknown {
  const columns = /\(([^)]*)\) values/.exec(statement.sql)![1]!.split(', ');
  expect(columns).toHaveLength(statement.parameters.length);
  const index = columns.indexOf(`"${column}"`);
  expect(index, column).toBeGreaterThanOrEqual(0);
  return statement.parameters[index];
}

/** UPDATE … set "列" = $n：取该列的参数。 */
function updatedValue(statement: Statement, column: string): unknown {
  const match = new RegExp(`"${column}" = \\$(\\d+)`).exec(statement.sql);
  expect(match, column).not.toBeNull();
  return statement.parameters[Number(match![1]) - 1];
}

/** 报文服务费：值、null 或缺省（键不存在）。 */
type Fee = bigint | null | 'omitted';

function withFee(fee: Fee, patch: Partial<UnionOrder> = {}): UnionOrder {
  const { service_fee_fen: _dropped, ...rest } = order(patch);
  void _dropped;
  return fee === 'omitted' ? rest : { ...rest, service_fee_fen: fee };
}

it.each([
  { label: '拼多多 31', fee: 31n as Fee, expected: 31n },
  { label: '服务费 0', fee: 0n as Fee, expected: 0n },
  { label: '报文 null', fee: null as Fee, expected: null },
  { label: '报文缺省', fee: 'omitted' as Fee, expected: null },
])('[AC-B1-08v#U4] 首次入库按本次报文原样写 service_fee_fen：$label', async ({ fee, expected }) => {
  const { db, statements } = recordingDb();
  const pipeline = createOrderPipeline({
    db,
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    pids: {
      find: () => Promise.resolve([{ pid_scene: 'self_buy', status: 'active', site_id: null }]),
    },
    accounts: { syncStartAt: () => Promise.resolve(at('2026-10-01T00:00:00.000Z')) },
    users: { findByAttrCode: () => Promise.resolve(current.user_id) },
    bindings: { findByRelation: () => Promise.resolve([]) },
    rebate: { onImported: vi.fn(() => Promise.resolve()) },
  });
  await expect(pipeline.process(withFee(fee), ctx)).resolves.toMatchObject({ kind: 'inserted' });
  const inserts = statements.filter((s) => s.sql.startsWith('insert into "app"."orders"'));
  expect(inserts).toHaveLength(1);
  expect(insertedValue(inserts[0]!, 'service_fee_fen')).toBe(expected);
});

function updateDeps(): OrderUpdateDeps {
  return {
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    users: { findByAttrCode: vi.fn(() => Promise.resolve(null)) },
    bindings: { findByRelation: vi.fn(() => Promise.resolve([])) },
    rebate: {
      onUpdated: vi.fn<OrderUpdateDeps['rebate']['onUpdated']>(() => Promise.resolve()),
      onUnmappedStatus: vi.fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>(() =>
        Promise.resolve(),
      ),
    },
    events: {
      publish: vi.fn<OrderUpdateDeps['events']['publish']>(() =>
        Promise.resolve({ eventId: 'unit', duplicate: false }),
      ),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

it.each([
  { label: '新值 47 覆盖库内 31', fee: 47n as Fee, expected: 47n },
  { label: '报文 null 覆盖为 NULL', fee: null as Fee, expected: null },
  { label: '报文缺省覆盖为 NULL', fee: 'omitted' as Fee, expected: null },
  { label: '0 照写', fee: 0n as Fee, expected: 0n },
])('[AC-B1-08v#U5] 变更写库按本次报文原样写 service_fee_fen：$label', async ({ fee, expected }) => {
  const { db, statements } = recordingDb();
  const step = createOrderUpdateStep(updateDeps());
  const incoming = withFee(fee, { modified_at: at('2026-10-16T00:00:00.000Z') });
  const outcome = await db.transaction().execute((trx) => step.apply(trx, current, incoming, ctx));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  const updates = statements.filter((s) => s.sql.startsWith('update "app"."orders"'));
  expect(updates).toHaveLength(1);
  expect(updatedValue(updates[0]!, 'service_fee_fen')).toBe(expected);
});

it('[AC-B1-08v#U6] 扫描的 N 不看服务费列（est 已是净额，结算优先）；N 为空且列空进 SERVICE_FEE_RATE_MISSING，不再 skip service_fee_unknown', async () => {
  const { db, statements } = recordingDb();
  const clock = new FixedClock(NOW);
  const plan = (row: Row) =>
    db.transaction().execute((trx) => readSnapshotRetryInput(trx, row, clock));
  await expect(plan(current)).resolves.toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n, platform: 'pdd', paidAtSource: 'platform' },
  });
  await expect(plan({ ...current, service_fee_fen: 47n })).resolves.toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n },
  });
  await expect(plan({ ...current, settle_commission_fen: 901n })).resolves.toMatchObject({
    kind: 'call',
    input: { nBaseFen: 901n },
  });
  await expect(plan({ ...current, service_fee_fen: null })).resolves.toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n },
  });
  await expect(
    plan({ ...current, est_commission_fen: null, service_fee_fen: null }),
  ).resolves.toEqual({ kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' });
  // 京东同样不看这一列。
  await expect(plan({ ...current, platform: 'jd', service_fee_fen: null })).resolves.toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n, platform: 'jd' },
  });
  // 只读：paid_at_source=platform 不查历史，也不写库。
  expect(statements.filter((s) => !/^(begin|commit)/.test(s.sql))).toEqual([]);
});

it('[AC-B1-08v#U7] 候选排序首键是「扫描必然 skip」，其后才是最早 detected_at、最小 id', async () => {
  const { db, statements } = recordingDb();
  await expect(selectDueSubOrders(db, 'unit-app', at(NOW), 100)).resolves.toEqual([]);
  expect(statements).toHaveLength(1);
  const { sql, parameters } = statements[0]!;
  const orderBy = sql.slice(sql.indexOf(' order by '));
  expect(orderBy).toMatch(/^ order by coalesce\(bool_or\(/);
  const skipKey = orderBy.indexOf('bool_or(');
  const detected = orderBy.indexOf('min("p"."detected_at")');
  const id = orderBy.indexOf('min("p"."id")');
  expect(skipKey).toBeLessThan(detected);
  expect(detected).toBeLessThan(id);
  expect(orderBy).not.toContain('o.service_fee_fen');
  expect(orderBy).toContain("o.paid_at_source not in ('platform', 'observed')");
  expect(parameters).toEqual(expect.arrayContaining(['taobao', 100]));
});
