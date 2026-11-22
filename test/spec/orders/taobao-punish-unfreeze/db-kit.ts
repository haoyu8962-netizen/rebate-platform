// B1-04zzab 的连库夹具；只被本目录的 *.int.test.ts 引用，数据库生命周期在它们里管理（@couli/db/testing）。
// 种入的订单、order_rights 行都是合成值；单号是全数字的合成串，每次调用唯一。账务三张表（凭证、分录、余额）
// 本文件一律不直写：入账、扣回、冻结都经 ledger 模块的记账入口（createLedger 的 openUserAccount / lockBalances /
// post，与 test/spec/settlement/clawback/kit.ts 同一做法），凭证、分录与余额由记账函数产生（账本单一写者守卫）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { vi } from 'vitest';
import {
  createLedger,
  type PostingEntry,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
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

/** The PUNISH / SUCCEEDED row an earlier frozen punishment left on `order`; returns its id. */
export async function seedPunishRow(
  db: Kysely<DB>,
  order: Order,
  punishmentNo: string,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('order_rights')
    .values({
      id,
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
  return id;
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

export interface ClawedBackLedger {
  /** The member's USER_BALANCE account (opened by the ledger's openUserAccount). */
  readonly userAccountId: string;
  /** account_balances of that account after the clawback (other activity keeps it non-zero). */
  readonly availableFen: bigint;
  readonly frozenFen: bigint;
  /** account_balances.version after the four postings that touch the member's account. */
  readonly version: bigint;
  /** uniq_keys of the order's own vouchers: user / platform CREDIT, user / platform CLAWBACK. */
  readonly orderVoucherKeys: readonly string[];
}

/** Another credited order of the member (keeps available non-zero after the clawback). */
const OTHER_CREDITED = new Date('2026-10-15T02:00:00.000Z');
const OTHER_CREDIT_FEN = 1_290n;
/** A withdrawal freeze of the member (keeps frozen non-zero). */
const WITHDRAW_FROZEN = new Date('2026-10-16T02:00:00.000Z');
const WITHDRAW_FROZEN_FEN = 56n;

function userLine(
  accountId: string,
  amount: bigint,
  ledgerType: string,
  subType: string | null,
  subAccount: 'available' | 'frozen' = 'available',
): PostingEntry {
  return {
    account: { ownerType: 'user', accountId },
    sub_account: subAccount,
    amount_fen: amount,
    ledger_type: ledgerType,
    sub_type: subType,
    income_type: null,
  };
}

function platformLine(
  subject: string,
  amount: bigint,
  ledgerType: string,
  subType: string | null,
): PostingEntry {
  return {
    account: { ownerType: 'platform', subject },
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: ledgerType,
    sub_type: subType,
    income_type: null,
  };
}

/**
 * Posts `vouchers` through the ledger module's posting entry, in one transaction at `at` (the
 * ledger's Clock gives booked_at and accounting_date), with the member's balance locked first.
 */
async function postAt(
  db: Kysely<DB>,
  at: Date,
  appId: string,
  userId: string,
  vouchers: (memberAccountId: string) => readonly PostingVoucher[],
): Promise<void> {
  const ledger = createLedger({ clock: new FixedClock(at) });
  await db.transaction().execute(async (trx) => {
    const [balance] = await ledger.lockBalances(trx, { appId, userIds: [userId] });
    if (balance === undefined) throw new Error('db-kit: the member has no ledger account');
    for (const voucher of vouchers(balance.account_id)) {
      const result = await ledger.post(trx, voucher);
      if (result.kind !== 'posted') throw new Error(`db-kit: ${voucher.uniqKey} not posted`);
    }
  });
}

/**
 * The ledger an earlier credit (R5) and its full PUNISH clawback (R8) left for `order`, all
 * written by the ledger module (createLedger().post), in the production template shapes (BR-FUND-05
 * CREDIT:SELF / CREDIT:PLATFORM, BR-FUND-08 CLAWBACK:PUNISH:USER / :PLATFORM:DECREASE; debit
 * positive): at `credited` the member's CREDIT (debit UNION_RECEIVABLE:{platform} `base`, credit
 * USER_BALANCE.available `base`) and the PLATFORM:CREDIT (`n - base` to COMMISSION_REVENUE); at
 * `clawed` the CLAWBACK of each (rights_event_id `R{order_rights.id}`). Before them the member had
 * another credited order (1290) and a withdrawal freeze (56), so after the clawback the balance is
 * available 1234, frozen 56 (version 4: four postings on the account).
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
    /** order_rights.id of the PUNISH row the clawback was for. */
    readonly rightsId: string;
  },
): Promise<ClawedBackLedger> {
  const appId = order.app_id;
  const orderKey = `${order.platform}:${order.sub_order_id}`;
  const receivable = `UNION_RECEIVABLE:${order.platform}`;
  const revenue = 'COMMISSION_REVENUE';
  const platformFen = amounts.n - amounts.base;
  const eventId = `R${amounts.rightsId}`;
  const keys = {
    userCredit: `${orderKey}:${userId}:self:CREDIT`,
    platformCredit: `${orderKey}:PLATFORM:CREDIT`,
    userClawback: `${orderKey}:${userId}:self:CLAWBACK:${eventId}`,
    platformClawback: `${orderKey}:PLATFORM:CLAWBACK:${eventId}`,
  };
  const orderVoucher = (
    uniqKey: string,
    kind: 'CREDIT' | 'CLAWBACK',
    beneficiary: string | null,
    entries: readonly PostingEntry[],
  ): PostingVoucher => ({
    appId,
    uniqKey,
    bizType: kind === 'CREDIT' ? 'ORDER_CREDIT' : 'ORDER_CLAWBACK',
    bizId: orderKey,
    operator: 'system',
    memo: null,
    orderKey,
    beneficiaryUserId: beneficiary,
    role: beneficiary === null ? null : 'self',
    voucherKind: kind,
    entries,
  });

  const opener = createLedger({ clock: new FixedClock(OTHER_CREDITED) });
  const opened = await db
    .transaction()
    .execute((trx) => opener.openUserAccount(trx, { appId, userId }));
  const otherKey = `${order.platform}:${orderNo()}`;
  await postAt(db, OTHER_CREDITED, appId, userId, (member) => [
    {
      appId,
      uniqKey: `${otherKey}:${userId}:self:CREDIT`,
      bizType: 'ORDER_CREDIT',
      bizId: otherKey,
      operator: 'system',
      memo: null,
      orderKey: otherKey,
      beneficiaryUserId: userId,
      role: 'self',
      voucherKind: 'CREDIT',
      entries: [
        platformLine(receivable, OTHER_CREDIT_FEN, 'REBATE_CREDIT', null),
        userLine(member, -OTHER_CREDIT_FEN, 'REBATE_CREDIT', null),
      ],
    },
  ]);
  await postAt(db, WITHDRAW_FROZEN, appId, userId, (member) => [
    {
      appId,
      uniqKey: `WDR:test:${randomUUID()}`,
      bizType: 'WITHDRAW',
      bizId: randomUUID(),
      operator: 'system',
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: 'WITHDRAW_FREEZE',
      entries: [
        userLine(member, WITHDRAW_FROZEN_FEN, 'WITHDRAW_FREEZE', null, 'available'),
        userLine(member, -WITHDRAW_FROZEN_FEN, 'WITHDRAW_FREEZE', null, 'frozen'),
      ],
    },
  ]);
  await postAt(db, amounts.credited, appId, userId, (member) => [
    orderVoucher(keys.userCredit, 'CREDIT', userId, [
      platformLine(receivable, amounts.base, 'REBATE_CREDIT', null),
      userLine(member, -amounts.base, 'REBATE_CREDIT', null),
    ]),
    orderVoucher(keys.platformCredit, 'CREDIT', null, [
      platformLine(receivable, platformFen, 'REBATE_CREDIT', null),
      platformLine(revenue, -platformFen, 'REBATE_CREDIT', null),
    ]),
  ]);
  await postAt(db, amounts.clawed, appId, userId, (member) => [
    orderVoucher(keys.userClawback, 'CLAWBACK', userId, [
      userLine(member, amounts.base, 'CLAWBACK', 'PUNISH'),
      platformLine(receivable, -amounts.base, 'CLAWBACK', 'PUNISH'),
    ]),
    orderVoucher(keys.platformClawback, 'CLAWBACK', null, [
      platformLine(revenue, platformFen, 'CLAWBACK', 'PUNISH'),
      platformLine(receivable, -platformFen, 'CLAWBACK', 'PUNISH'),
    ]),
  ]);
  return {
    userAccountId: opened.account_id,
    availableFen: OTHER_CREDIT_FEN - WITHDRAW_FROZEN_FEN,
    frozenFen: WITHDRAW_FROZEN_FEN,
    version: 4n,
    orderVoucherKeys: [
      keys.userCredit,
      keys.platformCredit,
      keys.userClawback,
      keys.platformClawback,
    ],
  };
}

/**
 * What a handled unfreeze / unmapped row must leave alone on its orders (B1-04zzab 13.2 ②): the
 * order rows (platform_status, rebate_status, hold, amount columns, everything), their status
 * history, their order_rights rows, and the app's event_log rows naming them (no order-invalid or
 * other event published for them).
 */
export async function trailOf(db: Kysely<DB>, appId: string, orders: readonly Order[]) {
  const ids = orders.map((o) => o.order_id);
  const markers = [...ids, ...orders.map((o) => o.sub_order_id)];
  const events = await db
    .selectFrom('event_log')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
  return {
    orders: await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', 'in', ids)
      .orderBy('order_id')
      .execute(),
    history: await db
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', 'in', ids)
      .orderBy('id')
      .execute(),
    rights: await db
      .selectFrom('order_rights')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', 'in', ids)
      .orderBy('id')
      .execute(),
    events: events.filter((e) => {
      const text = `${e.name} ${JSON.stringify(e.payload)}`;
      return markers.some((m) => text.includes(m));
    }),
  };
}
export type Trail = Awaited<ReturnType<typeof trailOf>>;

/** The state columns of an order a wrong implementation might touch (13.2 ②), by order_id. */
export function stateOf(trail: Trail) {
  return trail.orders.map((o) => ({
    order_id: o.order_id,
    platform_status: o.platform_status,
    rebate_status: o.rebate_status,
    reason: o.reason,
    hold: o.hold,
    hold_reason: o.hold_reason,
    est_commission_fen: o.est_commission_fen,
    settle_commission_fen: o.settle_commission_fen,
    booked_base_fen: o.booked_base_fen,
    booked_n_fen: o.booked_n_fen,
    row_version: o.row_version,
  }));
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
