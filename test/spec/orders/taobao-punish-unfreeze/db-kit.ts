// B1-04zzab 的连库夹具；只被本目录的 *.int.test.ts 引用，数据库生命周期在它们里管理（@couli/db/testing）。
// 种入的订单、order_rights 行都是合成值；单号是全数字的合成串，每次调用唯一。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { vi } from 'vitest';
import {
  createPunishPendingRecorder,
  type PunishPendingPort,
} from '../../../../apps/api/src/modules/orders/application/punish-pending.ts';
import {
  createRightsSyncWriter,
  type PunishSyncWindow,
} from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import type { RightsCommandPort } from '../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import type { RightsSyncHandlerDeps } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import type { UnionPunish } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { NOW, fixture as handlerFixture, punishWindow } from './kit.ts';

/** The part of @couli/db/testing's TestDatabase this kit uses. */
export interface TestDatabaseUrls {
  urlFor(role: 'couli_app'): string;
}

export async function open(database: TestDatabaseUrls) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  return {
    db,
    async close() {
      await destroyDb(db);
    },
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export type Order = Selectable<DB['orders']>;
export type RightsRow = Selectable<DB['order_rights']>;
export type PendingRow = Selectable<DB['order_sync_pending']>;

export const newAppId = () => `pu_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

/** A synthetic all-digit order number, unique per call. */
export const orderNo = () =>
  `87${randomUUID()
    .replaceAll('-', '')
    .replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10))
    .slice(0, 16)}`;

const PAID = new Date('2026-10-05T02:00:00.000Z');
const RECEIVED = new Date('2026-10-12T08:00:00.000Z');
/** When the earlier (frozen) punishment was recorded. */
export const PUNISHED = new Date('2026-11-01T04:00:00.000Z');

/** One Taobao sub-order of `appId` (order_keys + orders); WAITING unless `patch` says otherwise. */
export async function seedOrder(
  db: Kysely<DB>,
  appId: string,
  patch: Partial<Insertable<DB['orders']>> = {},
): Promise<Order> {
  const row = {
    order_id: randomUUID(),
    app_id: appId,
    platform: 'taobao',
    sub_order_id: orderNo(),
    parent_order_id: orderNo(),
    raw_item_id: 'synthetic-item',
    pay_amount_fen: 4567n,
    est_commission_fen: 321n,
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
    hold: false,
    rights_pending: false,
    is_presale: false,
    paid_at: PAID,
    received_at: RECEIVED,
    settle_period: '2026-10',
    attr_at: PAID,
    created_at: PAID,
    updated_at: PAID,
    ...patch,
  } satisfies Insertable<DB['orders']>;
  await db
    .insertInto('order_keys')
    .values({
      order_id: row.order_id,
      app_id: row.app_id,
      platform: row.platform,
      sub_order_id: row.sub_order_id,
      attr_at: row.attr_at,
      created_at: row.created_at,
    })
    .execute();
  await db.insertInto('orders').values(row).execute();
  return orderRow(db, appId, row.order_id);
}

export function orderRow(db: Kysely<DB>, appId: string, orderId: string): Promise<Order> {
  return db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

/** The PUNISH / SUCCEEDED row an earlier frozen punishment left on `order`. */
export async function seedPunishRow(db: Kysely<DB>, order: Order, punishmentNo: string) {
  await db
    .insertInto('order_rights')
    .values({
      id: randomUUID(),
      app_id: order.app_id,
      order_id: order.order_id,
      source: 'API',
      type: 'PUNISH',
      status: 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: PUNISHED,
      platform_rights_no: punishmentNo,
      created_at: PUNISHED,
      updated_at: PUNISHED,
    })
    .execute();
}

export function rightsOf(db: Kysely<DB>, appId: string): Promise<RightsRow[]> {
  return db
    .selectFrom('order_rights')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

export function ledgerOf(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('ledger_entries')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

export function pendingOf(db: Kysely<DB>, appId: string): Promise<PendingRow[]> {
  return db
    .selectFrom('order_sync_pending')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** Someone handled the open record (B1-04zzab 9.2 ②: a later unfreeze row opens a new one). */
export async function closePending(db: Kysely<DB>, id: bigint, status: 'resolved' | 'dismissed') {
  await db
    .updateTable('order_sync_pending')
    .set({
      status,
      resolved_at: new Date('2026-11-06T05:00:00.000Z'),
      resolution_note: 'synthetic review',
    })
    .where('id', '=', id)
    .execute();
}

/** A punish row naming `subOrderId`, reported unfrozen unless `patch` says otherwise. */
export function unfreezeRow(subOrderId: string, patch: Partial<UnionPunish> = {}): UnionPunish {
  return {
    order_id: subOrderId,
    punishment_id: `${subOrderId}:202610`,
    deduction_fen: null,
    punish_status: '1',
    violation_type: '1',
    settle_month: '202610',
    ...patch,
  };
}

/** The punish window of `appId` at NOW. */
export function windowOf(appId: string): PunishSyncWindow {
  return { ...punishWindow(), app_id: appId };
}

/**
 * The handler over the real database: fake adapter pages and gates (the frozen B1-04zza kit), the
 * real rights writer over a settlement stand-in that only records being called, and the
 * production pending recorder.
 */
export function dbHandler(db: Kysely<DB>, pages: readonly (readonly UnionPunish[])[]) {
  const base = handlerFixture({ punishPages: pages });
  const record = vi.fn<RightsCommandPort['record']>(async () => ({ kind: 'applied' }));
  const rights: RightsCommandPort = { record };
  const pending: PunishPendingPort = createPunishPendingRecorder({ db });
  const deps: RightsSyncHandlerDeps = {
    ...base.bare,
    writer: createRightsSyncWriter({ db, clock: base.clock, rights }),
    pending,
  };
  return { deps, rightsRecord: record, logger: base.logger, now: new Date(NOW) };
}
