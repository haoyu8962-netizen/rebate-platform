// B1-08zi（D10-814 ②，BR-FUND-01「判定先于写库」）：表外事件的报文整条不落 orders——带来不同的件数与已退件数也
// 一样，两列不写，不调 settlement。生产 worker 上的拼多多映射表只有付款 / 收货 / 结算三种事件，表外事件到不了
// （P10 倒退见 sync.int.test.ts），这里在更新步骤上用合成映射表（含维权码）判定：DEPOSIT_PAID / INVALID 收到维权
// 不在迁移表内。不连库：脚本化驱动只回预设结果，记录编译后的语句。对照：同状态（P15）报文的 UPDATE 写已退件数。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
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
import {
  createOrderUpdateStep,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import type { OrderPipelineContext } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import type {
  PlatformStatusEvent,
  StatusMap,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';

const NOW = '2026-10-30T03:00:00.000Z';
const at = (iso: string) => new FixedClock(iso).now();

type Row = Selectable<DB['orders']>;

/** Answers UPDATE orders with one row, SELECT orders with `row`, everything else with none. */
function scriptedDb(row: Row) {
  const log: string[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: { sql: string }): Promise<QueryResult<R>> {
          log.push(compiled.sql);
          if (compiled.sql.startsWith('update "app"."orders"')) {
            return Promise.resolve({ rows: [], numAffectedRows: 1n });
          }
          if (compiled.sql.startsWith('select') && compiled.sql.includes('"app"."orders"')) {
            return Promise.resolve({ rows: [row] as R[] });
          }
          if (compiled.sql.startsWith('insert into "app"."order_sync_pending"')) {
            const pending = { id: 7n, inserted: true, raw_status: null, detail: null };
            return Promise.resolve({ rows: [pending] as R[] });
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

/** Synthetic codes (test labels, not platform recordings). */
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

function stored(platformStatus: string, rebateStatus: string): Row {
  return {
    order_id: '019a0000-0000-7000-8000-0000000008a1',
    app_id: 'spec-app',
    platform: 'pdd',
    sub_order_id: 'spec-child',
    attr_at: at('2026-10-28T16:00:00.000Z'),
    platform_status: platformStatus,
    rebate_status: rebateStatus,
    row_version: 3,
    commission_version: 1,
    user_id: '019a0000-0000-7000-8000-0000000008a2',
    locked: false,
    pid: 'slot-ours',
    relation_id: null,
    sub_union_id: null,
    custom_params: null,
    pay_amount_fen: 100n,
    est_commission_fen: 10n,
    settle_commission_fen: null,
    received_at: platformStatus === 'RECEIVED' ? at('2026-10-29T03:04:05.000Z') : null,
    platform_received_at: null,
    deposit_paid_at: at('2026-10-28T16:00:00.000Z'),
    paid_at: at('2026-10-28T16:00:00.000Z'),
    settled_at: null,
    platform_modified_at: null,
    parent_order_id: null,
    raw_item_id: 'spec-item',
    content_hash: 'old',
    raw_payload_id: 1n,
    quantity: 3,
    refunded_quantity: 0,
    refunded_quantity_at_credit: null,
  } as Row;
}

function incoming(rawStatus: string): UnionOrder {
  return {
    platform: 'pdd',
    order_id: 'spec-order',
    sub_order_id: 'spec-child',
    parent_order_id: null,
    promotion_slot: 'slot-ours',
    attr_params: { relation_id: null, sub_union_id: null, custom_parameters: null },
    raw_status: rawStatus,
    goods_id: 'spec-item',
    paid_fen: 100n,
    commission_fen: 10n,
    est_commission_fen: 10n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at('2026-10-28T16:00:00.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: at('2026-10-30T02:00:00.000Z'),
    raw_payload_id: '2',
    quantity: 5,
    refunded_quantity: 2,
  };
}

const ctx: OrderPipelineContext = {
  app_id: 'spec-app',
  platform: 'pdd',
  union_account_id: 'spec-account',
  query_kind: 'increment',
  scene: '-',
  window_start: '2026-10-01T00:00:00.000Z',
  window_end: NOW,
  requestId: 'spec-request',
};

function deps() {
  const onUpdated = vi.fn<OrderUpdateDeps['rebate']['onUpdated']>(() => Promise.resolve());
  const d: OrderUpdateDeps = {
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    users: { findByAttrCode: vi.fn(() => Promise.resolve(null)) },
    bindings: { findByRelation: vi.fn(() => Promise.resolve([])) },
    rebate: {
      onUpdated,
      onUnmappedStatus: vi.fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>(() =>
        Promise.resolve(),
      ),
    },
    events: {
      publish: vi.fn<OrderUpdateDeps['events']['publish']>((_trx, event) =>
        Promise.resolve({ eventId: event.eventId ?? 'spec', duplicate: false }),
      ),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { d, onUpdated };
}

async function run(row: Row, rawStatus: string) {
  const { db, log } = scriptedDb(row);
  const { d, onUpdated } = deps();
  const step = createOrderUpdateStep(d);
  const outcome = await db
    .transaction()
    .execute((trx) => step.apply(trx, row, incoming(rawStatus), ctx));
  const orderWrites = log.filter((sql) => sql.startsWith('update "app"."orders"'));
  return { outcome, log, orderWrites, onUpdated };
}

it('[AC-B1-08zi#41] 表外事件（DEPOSIT_PAID / INVALID 收到维权）带不同件数：整条拒收，不 UPDATE orders、两列不出现在任何语句里、不调 settlement；对照 P15 照写已退件数', async () => {
  // 对照：RECEIVED 订单收到同状态报文（P15），本次报文的件数照常处理，UPDATE 写 refunded_quantity。
  const received = stored('RECEIVED', 'WAITING');
  const control = await run(received, 'received');
  expect(control.outcome).toEqual({ kind: 'updated', order_id: received.order_id });
  expect(control.orderWrites.some((sql) => /"refunded_quantity" = \$\d+/.test(sql))).toBe(true);

  for (const [platformStatus, rebateStatus] of [
    ['DEPOSIT_PAID', 'ESTIMATED'],
    ['INVALID', 'VOID'],
  ] as const) {
    const row = stored(platformStatus, rebateStatus);
    const rejected = await run(row, 'rights');
    expect(rejected.outcome).toEqual({
      kind: 'pending',
      order_id: row.order_id,
      reason: 'ILLEGAL_TRANSITION',
    });
    expect(rejected.orderWrites).toEqual([]);
    expect(rejected.log.filter((sql) => sql.includes('quantity'))).toEqual([]);
    expect(rejected.onUpdated).not.toHaveBeenCalled();
  }
});
