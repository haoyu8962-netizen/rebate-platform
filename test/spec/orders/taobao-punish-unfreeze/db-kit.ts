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
import { NOW, fixture as handlerFixture, lateWindow, punishWindow } from './kit.ts';

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

/** The punish window of `appId` that ended 12 minutes before the injected Clock (kit lateWindow). */
export function lateWindowOf(appId: string): PunishSyncWindow {
  return { ...lateWindow(), app_id: appId };
}

export interface DbHandlerOptions {
  /** Wraps the production pending recorder (e.g. to fail one call). */
  readonly wrap?: (recorder: PunishPendingPort) => PunishPendingPort;
}

/**
 * The handler over the real database: fake adapter pages and gates (the frozen B1-04zza kit), the
 * real rights writer over a settlement stand-in that only records being called, and the
 * production pending recorder.
 */
export function dbHandler(
  db: Kysely<DB>,
  pages: readonly (readonly UnionPunish[])[],
  options: DbHandlerOptions = {},
) {
  const base = handlerFixture({ punishPages: pages });
  const record = vi.fn<RightsCommandPort['record']>(async () => ({ kind: 'applied' }));
  const rights: RightsCommandPort = { record };
  const recorder: PunishPendingPort = createPunishPendingRecorder({ db });
  const pending = options.wrap === undefined ? recorder : options.wrap(recorder);
  const deps: RightsSyncHandlerDeps = {
    ...base.bare,
    writer: createRightsSyncWriter({ db, clock: base.clock, rights }),
    pending,
  };
  return {
    deps,
    rightsRecord: record,
    logger: base.logger,
    listPunishments: base.listPunishments,
    now: new Date(NOW),
  };
}

/** A user of `appId` (the attributed member of a credited order). */
export async function seedUser(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'synthetic',
      avatar: 'synthetic',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
      created_at: PAID,
      updated_at: PAID,
    })
    .execute();
  return id;
}

/** The China (+08:00) calendar date of an instant, for ledger_vouchers.accounting_date. */
function chinaDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export interface ClawedBackLedger {
  /** The member's USER_BALANCE account. */
  readonly userAccountId: string;
  /** account_balances of that account after the clawback (other orders keep it non-zero). */
  readonly availableFen: bigint;
  readonly frozenFen: bigint;
}

/**
 * The ledger an earlier credit and its PUNISH clawback left for `order` (synthetic, debit
 * positive): the credit (UNION_RECEIVABLE debit `n`, USER_BALANCE credit `base`, COMMISSION_REVENUE
 * credit the rest), the clawback reversing it, and the member's balance row.
 */
export async function seedClawedBackLedger(
  db: Kysely<DB>,
  order: Order,
  userId: string,
  amounts: {
    readonly n: bigint;
    readonly base: bigint;
    readonly credited: Date;
    readonly clawed: Date;
  },
): Promise<ClawedBackLedger> {
  const appId = order.app_id;
  const orderKey = `${order.platform}:${order.sub_order_id}`;
  const account = async (ownerType: 'user' | 'platform', ownerId: string, subject: string) => {
    const id = randomUUID();
    await db
      .insertInto('ledger_accounts')
      .values({
        id,
        app_id: appId,
        owner_type: ownerType,
        owner_id: ownerId,
        subject,
        created_at: amounts.credited,
      })
      .execute();
    return id;
  };
  const member = await account('user', userId, 'USER_BALANCE');
  const receivable = await account('platform', 'platform', `UNION_RECEIVABLE:${order.platform}`);
  const revenue = await account('platform', 'platform', 'COMMISSION_REVENUE');
  const voucher = async (
    kind: 'CREDIT' | 'CLAWBACK',
    ledgerType: 'REBATE_CREDIT' | 'CLAWBACK',
    sign: 1n | -1n,
    at: Date,
  ) => {
    const id = randomUUID();
    await db
      .insertInto('ledger_vouchers')
      .values({
        id,
        app_id: appId,
        biz_type: kind === 'CREDIT' ? 'ORDER_CREDIT' : 'ORDER_CLAWBACK',
        biz_id: orderKey,
        uniq_key: `${orderKey}:${userId}:self:${kind}`,
        accounting_date: chinaDate(at),
        operator: 'system',
        memo: kind === 'CLAWBACK' ? 'reason=PUNISH' : null,
        order_key: orderKey,
        beneficiary_user_id: userId,
        role: 'self',
        voucher_kind: kind,
        created_at: at,
      })
      .execute();
    await db
      .insertInto('ledger_entries')
      .values(
        [
          { account_id: receivable, amount_fen: sign * amounts.n },
          { account_id: member, amount_fen: -sign * amounts.base },
          { account_id: revenue, amount_fen: -sign * (amounts.n - amounts.base) },
        ].map((line) => ({
          app_id: appId,
          voucher_id: id,
          account_id: line.account_id,
          sub_account: 'available',
          amount_fen: line.amount_fen,
          ledger_type: ledgerType,
          sub_type: kind === 'CLAWBACK' ? 'PUNISH' : null,
          income_type: null,
          balance_after_fen: null,
          account_version: null,
          booked_at: at,
          created_at: at,
        })),
      )
      .execute();
  };
  await voucher('CREDIT', 'REBATE_CREDIT', 1n, amounts.credited);
  await voucher('CLAWBACK', 'CLAWBACK', -1n, amounts.clawed);
  const availableFen = 1_234n;
  const frozenFen = 56n;
  await db
    .insertInto('account_balances')
    .values({
      app_id: appId,
      account_id: member,
      available_fen: availableFen,
      frozen_fen: frozenFen,
      negative_since: null,
      version: 2n,
      created_at: amounts.credited,
    })
    .execute();
  return { userAccountId: member, availableFen, frozenFen };
}

/** Everything of `appId` a restore or a payout would write: ledger, balances, recon diffs. */
export async function moneyOf(db: Kysely<DB>, appId: string) {
  return {
    accounts: await db
      .selectFrom('ledger_accounts')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    balances: await db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('account_id')
      .execute(),
    vouchers: await db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    entries: await ledgerOf(db, appId),
    diffs: await db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
