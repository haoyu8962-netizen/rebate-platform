// B2-04zzf rule-test kit (claude-independent; FU-R9-REFUND-BASELINE, D10-814 ⑤ / D10-868 ② / D10-870).
// 「退款数量增加」(BR-FUND-01「R9 与 R9b 的判定」) is refunded_quantity > COALESCE(r9 baseline,
// refunded_quantity_at_credit, 0); the baseline column orders.refunded_quantity_r9_baseline is written
// only by settlement's clawback: with the R8 / R9 / R10 order write, on the R9 positive-difference skip
// and on the no-change exit, and also when the jd switch is off (alert only); never while the clawback
// waits for the union's commission (WAIT_COMMISSION).
//
// The column is new: it is read with raw SQL after checking information_schema, so a database without
// it fails on an assertion (not on a PostgreSQL error). Only synthetic setup and observations here;
// the paths under test are the production worker (../settlement-records/kit.ts, pdd) and the real
// clawback service on the B2-04s harness (../clawback/kit.ts), whose onUpdated the orders sync calls.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ClawbackResult } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import { createSettlementRecords } from '../../../../apps/api/src/modules/settlement/settlements/index.ts';
import type { Harness, SeededOrder } from '../clawback/kit.ts';

/** content config item: jd's refunded quantity drives R9 only when it is JSON true (B1-08zi). */
export const JD_SWITCH = 'orders.jd.refunded_quantity_r9_enabled';
/** clawback-order alert names (warn lines carrying `alert`). */
export const ALERT_WAIT = 'clawback_wait_commission';
export const ALERT_JD_OFF = 'jd_refunded_quantity_r9_disabled';
export const ALERT_POSITIVE = 'settle_adjust_positive_pending';
export const ROLES = ['self', 'direct', 'indirect'] as const;
export const INJECTED = 'injected downstream failure';

export interface BaselineColumn {
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}

/** information_schema of app.orders.refunded_quantity_r9_baseline (no row when it does not exist). */
export async function baselineColumn(db: Kysely<DB>): Promise<BaselineColumn[]> {
  const result = await sql<BaselineColumn>`
    SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'app'
       AND table_name = 'orders'
       AND column_name = 'refunded_quantity_r9_baseline'`.execute(db);
  return result.rows;
}

/** The order's r9 baseline, on `db` (a pool or the sync transaction); asserts the column exists. */
export async function baselineOf(
  db: Kysely<DB>,
  appId: string,
  orderId: string,
): Promise<number | null> {
  expect(await baselineColumn(db), 'app.orders.refunded_quantity_r9_baseline').toHaveLength(1);
  const result = await sql<{ baseline: number | null }>`
    SELECT refunded_quantity_r9_baseline AS baseline
      FROM app.orders
     WHERE app_id = ${appId}
       AND order_id = ${orderId}`.execute(db);
  expect(result.rows, 'the order row').toHaveLength(1);
  return result.rows[0]!.baseline;
}

/** order_sync_pending rows of one sub-order (orders owns the table). */
export function pendingOf(db: Kysely<DB>, appId: string, subOrderId: string) {
  return db
    .selectFrom('order_sync_pending')
    .select(['reason', 'status'])
    .where('app_id', '=', appId)
    .where('sub_order_id', '=', subOrderId)
    .execute();
}

/** order.clawed_back events of one app. */
export function clawedBackEvents(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('event_log')
    .select(['name', 'payload'])
    .where('app_id', '=', appId)
    .where('name', '=', 'order.clawed_back')
    .execute();
}

/** Distinct uniq_keys of the CLAWBACK lines, sorted. */
export function clawbackKeysOf(
  lines: readonly { readonly uniq_key: string; readonly ledger_type: string }[],
): string[] {
  const keys = lines.filter((l) => l.ledger_type === 'CLAWBACK').map((l) => l.uniq_key);
  return [...new Set(keys)].sort();
}

// ---- the B2-04s clawback harness ---------------------------------------------------------------

export interface ApiOnlySpec {
  readonly quantity: number;
  readonly refunded: number;
  readonly platform?: string;
}

/**
 * An order whose only settlement record is an API one of 1000 (no STATEMENT), so the API record a
 * later sync writes decides the amount (BR-FUND-09); credited by the real credit service (R5):
 * B 850 (reserve 1500), self 425 / direct 85 / indirect 42, refunded_quantity_at_credit = refunded.
 */
export async function creditedApiOnly(
  db: Kysely<DB>,
  h: Harness,
  spec: ApiOnlySpec,
): Promise<SeededOrder> {
  const o = await h.order({
    ...(spec.platform === undefined ? {} : { platform: spec.platform }),
    seqs: [],
    patch: {
      quantity: spec.quantity,
      refunded_quantity: spec.refunded,
      settle_commission_fen: 1000n,
    },
  });
  await db
    .insertInto('order_settlements')
    .values({
      app_id: h.appId,
      order_id: o.orderId,
      seq: 1,
      source: 'API',
      settle_commission_fen: 1000n,
      settled_at: o.attrAt,
      content_hash: randomUUID(),
      created_at: o.attrAt,
    })
    .execute();
  expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
  expect(await h.read(o)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
    refunded_quantity: spec.refunded,
    refunded_quantity_at_credit: spec.refunded,
  });
  return o;
}

export interface RecordSyncSpec {
  readonly refundedAfter: number;
  readonly settleFen: bigint;
  /** Runs on the sync transaction after onUpdated answered (e.g. throws to roll it back). */
  readonly after?: (trx: Transaction<DB>) => Promise<void>;
}

/**
 * The orders sync step on one transaction with the union's new settlement amount (as B1-08zi's
 * r9-switch test): order_key lock, the API record through settlement's record port (so it is the
 * record that decides the amount on this transaction), the orders columns (settle_commission_fen,
 * refunded_quantity, row_version + 1), then the clawback's onUpdated with the change.
 */
export async function syncWithRecord(
  db: Kysely<DB>,
  h: Harness,
  o: SeededOrder,
  spec: RecordSyncSpec,
): Promise<ClawbackResult> {
  const clawback = h.boot();
  const records = createSettlementRecords({ clock: h.clock });
  return db.transaction().execute(async (trx) => {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    const before = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .executeTakeFirstOrThrow();
    const written = await records.recordApi(trx, {
      appId: h.appId,
      orderId: o.orderId,
      commissionFen: spec.settleFen,
      reportedSettledAt: null,
      orderSettledAt: before.settled_at,
    });
    expect(written).toMatchObject({ inserted: true });
    await trx
      .updateTable('orders')
      .set({
        settle_commission_fen: spec.settleFen,
        refunded_quantity: spec.refundedAfter,
        row_version: before.row_version + 1,
        updated_at: h.clock.now(),
      })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .execute();
    const change: OrderUpdateChange = {
      app_id: h.appId,
      order_id: o.orderId,
      attr_at: before.attr_at,
      from_status: before.platform_status,
      to_status: before.platform_status,
      rule: 'P15',
      received_at: before.received_at,
      est_before: before.est_commission_fen,
      est_after: before.est_commission_fen,
      settle_commission_fen: spec.settleFen,
      attributed_now: false,
    };
    const source: OrderStatusSource = { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' };
    const result = await clawback.onUpdated(trx, change, source);
    if (spec.after !== undefined) await spec.after(trx);
    return result;
  });
}

/** Everything a clawback of this order may write, for before / after comparisons. */
export async function moneyOf(h: Harness, o: SeededOrder) {
  return {
    keys: await h.orderVoucherKeys(o),
    balances: await Promise.all(ROLES.map((role) => h.balance(o.user(role)))),
    rebate: await h.rebateColumns(o),
    obligations: await h.orderObligations(o),
    candidates: await h.candidates(o),
    pending: await h.pendingRows(o),
    clawedBack: (await h.published()).filter((e) => e.name === 'order.clawed_back'),
  };
}

/** Warn lines (pino level 40) of the clawback carrying `alert` = name for this app and order. */
export function alertsFor(h: Harness, o: SeededOrder, name: string): Record<string, unknown>[] {
  return h.logs.filter(
    (line) =>
      line['level'] === 40 &&
      line['alert'] === name &&
      line['app_id'] === h.appId &&
      line['order_id'] === o.orderId,
  );
}

export function setSwitch(h: Harness, value: boolean | undefined): void {
  if (value === undefined) h.configValues.delete(JD_SWITCH);
  else h.configValues.set(JD_SWITCH, value);
}
