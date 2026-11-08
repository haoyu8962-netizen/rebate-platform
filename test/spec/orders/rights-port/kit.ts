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
import { vi } from 'vitest';
import type {
  AdminHoldInput,
  AdminHoldResult,
  OrderRightsPorts,
  RebateAdminCommandPort,
  RightsCommandPort,
  RightsRecordInput,
  RightsRecordResult,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

export const APP = 'rights-app-a';
export const NOW = '2026-10-22T08:00:00.000Z';
export const at = (iso = NOW) => new FixedClock(iso).now();

export function order(patch: Partial<Selectable<DB['orders']>> = {}): Selectable<DB['orders']> {
  return {
    app_id: APP,
    order_id: '019a0000-0000-7000-8000-000000000001',
    platform: 'taobao',
    sub_order_id: '880012340001',
    parent_order_id: '880012340000',
    row_version: 17,
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
    hold: false,
    hold_reason: null,
    rights_pending: false,
    attr_at: at('2026-10-01T08:00:00.000Z'),
    created_at: at('2026-10-01T08:01:00.000Z'),
    updated_at: at('2026-10-20T08:00:00.000Z'),
    paid_at: at('2026-10-01T08:00:00.000Z'),
    received_at: at('2026-10-15T08:00:00.000Z'),
    platform_received_at: at('2026-10-15T08:00:00.000Z'),
    user_id: '019a0000-0000-7000-8000-000000000002',
    raw_item_id: 'synthetic-item',
    activity_type: null,
    agent_session_id: null,
    base_fen: 123n,
    booked_base_fen: null,
    booked_n_fen: null,
    buy_type: 'self',
    commission_rate_bp: null,
    commission_rate_max_bp: null,
    commission_rate_min_bp: null,
    commission_version: 1,
    content_hash: null,
    credit_requires_settle: false,
    credited_at: null,
    custom_params: null,
    deposit_paid_at: null,
    diff_reason_code: null,
    est_commission_fen: 321n,
    image_url: null,
    initial_est_fen: 123n,
    is_presale: false,
    is_price_compare: null,
    link_id: null,
    locked: true,
    n_total_fen: null,
    paid_at_source: 'normal',
    pay_amount_fen: 4567n,
    pid: null,
    platform_est_profit_fen: null,
    platform_modified_at: null,
    pre_base_deduct_fen: null,
    product_key: null,
    quantity: 1,
    raw_payload_id: null,
    reason: null,
    reason_sub: null,
    reason_sub_manual: false,
    received_synced_at: null,
    refunded_quantity: null,
    refunded_quantity_at_credit: null,
    refunded_quantity_r9_baseline: null,
    relation_id: null,
    scene_basis: null,
    service_fee_fen: null,
    settle_commission_fen: null,
    settle_period: '2026-10',
    settled_at: null,
    shop_id: null,
    shop_type: null,
    source_match: null,
    source_scene: null,
    sub_union_id: null,
    subsidy_commission_fen: null,
    title: null,
    union_settled_at: null,
    user_basis: 'param',
    ...patch,
  };
}

export function rightsInput(patch: Partial<RightsRecordInput> = {}): RightsRecordInput {
  const before = Object.freeze(order());
  return {
    before,
    order_id: before.order_id,
    source: 'IMPORT',
    type: 'RIGHTS',
    status: 'PROCESSING',
    amount_fen: 9007199254740993n,
    deduction_commission_fen: 123n,
    occurred_at: at('2026-10-21T03:04:05.000Z'),
    platform_rights_no: 'synthetic-rights-001',
    now: at(),
    ...patch,
  };
}

export function holdInput(patch: Partial<AdminHoldInput> = {}): AdminHoldInput {
  return {
    before: Object.freeze(order()),
    expected_row_version: 16,
    reason_code: 'RISK',
    reason: '人工核对订单，保留完整说明。',
    actor: '019a0000-0000-7000-8000-000000000003',
    ip: '192.0.2.1',
    now: at(),
    ...patch,
  };
}

export function ports(
  rightsResult: RightsRecordResult = { kind: 'applied' },
  holdResult: AdminHoldResult = { kind: 'applied' },
) {
  const record = vi.fn<RightsCommandPort['record']>().mockResolvedValue(rightsResult);
  const adminHold = vi.fn<RebateAdminCommandPort['adminHold']>().mockResolvedValue(holdResult);
  const adminUnhold = vi.fn<RebateAdminCommandPort['adminUnhold']>().mockResolvedValue(holdResult);
  const injected: OrderRightsPorts = { rights: { record }, rebate: { adminHold, adminUnhold } };
  return { injected, record, adminHold, adminUnhold };
}

export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Real Kysely SQL compilation, no PG/socket. Replies do not emulate settlement business rules. */
export function database(replies: readonly (readonly unknown[])[] = []) {
  const statements: Statement[] = [];
  let next = 0;
  class RecordingDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(query: Statement): Promise<QueryResult<R>> {
          statements.push({ sql: query.sql, parameters: [...query.parameters] });
          const rows = replies[next++] ?? [];
          return Promise.resolve({ rows: [...rows] as R[] });
        },
        streamQuery() {
          throw new Error('unexpected stream query');
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
  });
  return { db, statements };
}

export async function capture<T>(action: () => Promise<T>) {
  try {
    return { ok: true as const, value: await action() };
  } catch (error) {
    return { ok: false as const, error };
  }
}
