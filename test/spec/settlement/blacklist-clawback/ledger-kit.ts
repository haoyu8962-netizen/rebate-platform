// B2-04zzl rule-test kit, ledger histories and interleavings (claude-independent, SPEC_REF d5713bf4):
// the order histories a confirmation must net against (BR-FUND-08 已入账净额), the open obligations
// it voids (BR-FUND-04 ⑫), and the barriers of the two-connection account-lock tests.
// Real pieces: the clawback service (R9), the settlement difference path (R10, through the settlement
// record port and onUpdated), ledger post / lockBalances for every voucher, so nets, balances and
// entries are what the ledger wrote. Synthetic: the appeal's and R13's vouchers are posted straight
// through the ledger with the keys and lines of specs/ledger-templates.csv (ADMIN_ADJUST:RESTORE:*),
// and an order put back to CREDITED is a direct UPDATE, as the tests name where they do it. Expected
// amounts stay in the tests, by hand.
import { randomUUID } from 'node:crypto';
import { PostgresQueryCompiler, type KyselyPlugin, type QueryId } from 'kysely';
import { expect } from 'vitest';
import type {
  PostingResult,
  PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  lockOrderKey,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ClawbackResult } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import type { CreditRole } from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import { createSettlementRecords } from '../../../../apps/api/src/modules/settlement/settlements/index.ts';
import {
  clawbackKey,
  deferred,
  platformClawbackKey,
  receivable as receivableOf,
  type OrderSpec,
} from '../clawback/kit.ts';
import type { App, SeededOrder } from './kit.ts';

// ---------------------------------------------------------------------------------------------
// Histories.

/**
 * An order credited on an API settlement record (no STATEMENT row), so that a later API record
 * decides the amount and goes the R10 route.
 */
export async function creditedOnApiRecord(a: App, spec: OrderSpec = {}): Promise<SeededOrder> {
  const { h } = a;
  const n = spec.settleFen ?? 1000n;
  const o = await h.order({
    ...spec,
    seqs: [],
    patch: { ...spec.patch, settle_commission_fen: n },
  });
  await h.db
    .insertInto('order_settlements')
    .values({
      app_id: h.appId,
      order_id: o.orderId,
      seq: 1,
      source: 'API',
      settle_commission_fen: n,
      settled_at: o.attrAt,
      content_hash: randomUUID(),
      created_at: o.attrAt,
    })
    .execute();
  expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
  return o;
}

/**
 * The orders sync step of a new deciding settlement amount: order key lock, the API record, the
 * orders column, then the clawback service's onUpdated on one transaction (BR-FUND-09, R10).
 */
export async function settleTo(a: App, o: SeededOrder, settleFen: bigint): Promise<ClawbackResult> {
  const { h } = a;
  const clawback = h.boot();
  const records = createSettlementRecords({ clock: h.clock });
  return h.db.transaction().execute(async (trx) => {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    const before = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .executeTakeFirstOrThrow();
    await records.recordApi(trx, {
      appId: h.appId,
      orderId: o.orderId,
      commissionFen: settleFen,
      reportedSettledAt: null,
      orderSettledAt: null,
    });
    await trx
      .updateTable('orders')
      .set({
        settle_commission_fen: settleFen,
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
      rule: null,
      received_at: before.received_at,
      est_before: before.est_commission_fen,
      est_after: before.est_commission_fen,
      settle_commission_fen: settleFen,
      attributed_now: false,
    };
    return clawback.onUpdated(trx, change, { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' });
  });
}

function accountOf(a: App, userId: string): string {
  const accountId = a.h.accounts.get(userId);
  expect(accountId, `balance account of ${userId}`).toBeDefined();
  return accountId!;
}

/**
 * An account appeal gives a forfeited share back (BR-FUND-22 ③): the risk state normal again, an
 * active share event after the forfeited one, and ADMIN_ADJUST:RESTORE:APPEAL
 * (debit COMMISSION_REVENUE, credit the member's available).
 */
export async function appealRestore(
  a: App,
  o: SeededOrder,
  role: CreditRole,
  fen: bigint,
): Promise<void> {
  const { h } = a;
  const userId = o.user(role);
  await h.setRisk(h.db, userId, 'normal');
  await h.db
    .insertInto('commission_split_beneficiary_events')
    .values({
      app_id: h.appId,
      order_id: o.orderId,
      user_id: userId,
      role,
      status: 'active',
      reason: null,
      created_at: h.clock.now(),
    })
    .execute();
  const diffId = randomUUID();
  await h.db.transaction().execute(async (trx) => {
    await h.ledger.lockBalances(trx, { appId: h.appId, userIds: [userId] });
    await h.ledger.post(trx, {
      appId: h.appId,
      uniqKey: `${o.orderKey}:${userId}:${role}:RESTORE:${diffId}`,
      bizType: 'ADMIN_RESTORE',
      bizId: diffId,
      operator: `admin:${randomUUID()}`,
      memo: null,
      orderKey: o.orderKey,
      beneficiaryUserId: userId,
      role,
      voucherKind: 'ADMIN_ADJUST',
      entries: [
        {
          account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
          sub_account: 'available',
          amount_fen: fen,
          ledger_type: 'ADMIN_ADJUST',
          sub_type: 'RESTORE',
          income_type: null,
        },
        {
          account: { ownerType: 'user', accountId: accountOf(a, userId) },
          sub_account: 'available',
          amount_fen: -fen,
          ledger_type: 'ADMIN_ADJUST',
          sub_type: 'RESTORE',
          income_type: null,
        },
      ],
    });
  });
}

function restoreVoucher(
  a: App,
  o: SeededOrder,
  uniqKey: string,
  beneficiary: { readonly role: CreditRole; readonly userId: string } | null,
  fen: bigint,
): PostingVoucher {
  return {
    appId: a.h.appId,
    uniqKey,
    bizType: 'ADMIN_RESTORE',
    bizId: o.orderKey,
    operator: `admin:${randomUUID()}`,
    memo: null,
    orderKey: o.orderKey,
    beneficiaryUserId: beneficiary?.userId ?? null,
    role: beneficiary?.role ?? null,
    voucherKind: 'ADMIN_ADJUST',
    entries: [
      {
        account: { ownerType: 'platform', subject: receivableOf(o) },
        sub_account: 'available',
        amount_fen: fen,
        ledger_type: 'ADMIN_ADJUST',
        sub_type: 'RESTORE',
        income_type: null,
      },
      {
        account:
          beneficiary === null
            ? { ownerType: 'platform', subject: 'COMMISSION_REVENUE' }
            : { ownerType: 'user', accountId: accountOf(a, beneficiary.userId) },
        sub_account: 'available',
        amount_fen: -fen,
        ledger_type: 'ADMIN_ADJUST',
        sub_type: 'RESTORE',
        income_type: null,
      },
    ],
  };
}

/**
 * R13's vouchers after a full clawback (BR-FUND-22; ADMIN_ADJUST:RESTORE:USER / PLATFORM, debit
 * UNION_RECEIVABLE): every listed role's net and the platform's net come back.
 */
export async function restoreNets(
  a: App,
  o: SeededOrder,
  users: readonly { readonly role: CreditRole; readonly fen: bigint }[],
  platformFen: bigint,
): Promise<void> {
  const { h } = a;
  const diffId = randomUUID();
  await h.db.transaction().execute(async (trx) => {
    await h.ledger.lockBalances(trx, {
      appId: h.appId,
      userIds: users.map((user) => o.user(user.role)),
    });
    for (const user of users) {
      const userId = o.user(user.role);
      await h.ledger.post(
        trx,
        restoreVoucher(
          a,
          o,
          `${o.orderKey}:${userId}:${user.role}:RESTORE:${diffId}`,
          { role: user.role, userId },
          user.fen,
        ),
      );
    }
    await h.ledger.post(
      trx,
      restoreVoucher(a, o, `${o.orderKey}:PLATFORM:RESTORE:${diffId}`, null, platformFen),
    );
  });
}

/** Puts a clawed-back order back to CREDITED with the given booked pair (a direct UPDATE). */
export async function reopenOrder(
  a: App,
  o: SeededOrder,
  bookedBaseFen: bigint,
  bookedNFen: bigint,
): Promise<void> {
  await a.h.db
    .updateTable('orders')
    .set({
      rebate_status: 'CREDITED',
      booked_base_fen: bookedBaseFen,
      booked_n_fen: bookedNFen,
      reason: null,
      reason_sub: null,
    })
    .where('app_id', '=', a.h.appId)
    .where('order_id', '=', o.orderId)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Redelivery of a stored voucher.

/** An INSERT into ledger_vouchers, as compiled. */
const VOUCHER_INSERT = new RegExp(
  String.raw`\binsert\s+into\s+(?:"?app"?\s*\.\s*)?"?ledger_vouchers\b`,
  'i',
);

/** The whole-order clawback voucher of `role` (null: the platform's), per CLAWBACK:FULL:*. */
function fullClawbackVoucher(
  a: App,
  o: SeededOrder,
  event: string,
  role: CreditRole | null,
  fen: bigint,
): PostingVoucher {
  return {
    appId: a.h.appId,
    uniqKey: role === null ? platformClawbackKey(o, event) : clawbackKey(o, role, event),
    bizType: 'ORDER_CLAWBACK',
    bizId: o.orderKey,
    operator: 'system',
    memo: null,
    orderKey: o.orderKey,
    beneficiaryUserId: role === null ? null : o.user(role),
    role,
    voucherKind: 'CLAWBACK',
    entries: [
      {
        account:
          role === null
            ? { ownerType: 'platform', subject: 'COMMISSION_REVENUE' }
            : { ownerType: 'user', accountId: accountOf(a, o.user(role)) },
        sub_account: 'available',
        amount_fen: fen,
        ledger_type: 'CLAWBACK',
        sub_type: 'FULL',
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: receivableOf(o) },
        sub_account: 'available',
        amount_fen: -fen,
        ledger_type: 'CLAWBACK',
        sub_type: 'FULL',
        income_type: null,
      },
    ],
  };
}

export interface ReplayedVoucher extends PostingResult {
  readonly uniqKey: string;
}

/**
 * Posts the users' and then the platform's whole-order clawback vouchers of `event` through the real
 * ledger entry on one committed transaction, with the balance rows locked as a clawback locks them.
 * Returns ledger.post's answers and how many INSERTs into ledger_vouchers were sent: a stored
 * uniq_key answers before any write, so a replay sends none.
 */
export async function replayClawbackVouchers(
  a: App,
  o: SeededOrder,
  event: string,
  amounts: {
    readonly users: readonly { readonly role: CreditRole; readonly fen: bigint }[];
    readonly platformFen: bigint;
  },
): Promise<{ readonly results: readonly ReplayedVoucher[]; readonly voucherInserts: number }> {
  const { h } = a;
  const compiler = new PostgresQueryCompiler();
  let voucherInserts = 0;
  const counting: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (VOUCHER_INSERT.test(compiler.compileQuery(node, queryId).sql)) voucherInserts += 1;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  const vouchers = [
    ...amounts.users.map((user) => fullClawbackVoucher(a, o, event, user.role, user.fen)),
    fullClawbackVoucher(a, o, event, null, amounts.platformFen),
  ];
  const results = await h.db
    .withPlugin(counting)
    .transaction()
    .execute(async (trx) => {
      await h.ledger.lockBalances(trx, {
        appId: h.appId,
        userIds: amounts.users.map((user) => o.user(user.role)),
      });
      const posted: ReplayedVoucher[] = [];
      for (const voucher of vouchers) {
        posted.push({ uniqKey: voucher.uniqKey, ...(await h.ledger.post(trx, voucher)) });
      }
      return posted;
    });
  return { results, voucherInserts };
}

// ---------------------------------------------------------------------------------------------
// Obligations.

/**
 * The default order (425 / 85 / 42, platform 448) with the direct member's 85 taken back earlier and
 * still owed to them as an open deferred obligation (kind deferred, opened by R10): direct's net is
 * 0, the platform's net stays 448, UNION_RECEIVABLE is 915 (BR-FUND-19 ⑤: 425 + 42 + 448).
 */
export async function creditedWithDeferred(a: App): Promise<SeededOrder> {
  const { h } = a;
  const o = await h.credited();
  const direct = o.user('direct');
  await h.db.transaction().execute(async (trx) => {
    await h.ledger.lockBalances(trx, { appId: h.appId, userIds: [direct] });
    await h.ledger.post(trx, {
      appId: h.appId,
      uniqKey: `${o.orderKey}:${direct}:direct:CLAWBACK:fixture`,
      bizType: 'ORDER_CLAWBACK',
      bizId: o.orderKey,
      operator: 'system',
      memo: null,
      orderKey: o.orderKey,
      beneficiaryUserId: direct,
      role: 'direct',
      voucherKind: 'CLAWBACK',
      entries: [
        {
          account: { ownerType: 'user', accountId: accountOf(a, direct) },
          sub_account: 'available',
          amount_fen: 85n,
          ledger_type: 'CLAWBACK',
          sub_type: 'PART_REFUND',
          income_type: null,
        },
        {
          account: { ownerType: 'platform', subject: receivableOf(o) },
          sub_account: 'available',
          amount_fen: -85n,
          ledger_type: 'CLAWBACK',
          sub_type: 'PART_REFUND',
          income_type: null,
        },
      ],
    });
  });
  await h.db
    .insertInto('beneficiary_credits')
    .values({
      beneficiary_credit_id: randomUUID(),
      app_id: h.appId,
      order_id: o.orderId,
      user_id: direct,
      role: 'direct',
      kind: 'deferred',
      opened_by: 'R10',
      opened_ref: 'S2',
      origin_ledger_type: 'SETTLE_ADJUST',
      origin_sub_type: 'SETTLE_DIFF',
      split_ref: 'commission_version:1',
      status: 'open',
      closed_by: null,
      closed_ref: null,
      voucher_id: null,
      opened_at: h.clock.now(),
      closed_at: null,
    })
    .execute();
  return o;
}

// ---------------------------------------------------------------------------------------------
// Barriers.

export interface VoucherBarrier {
  readonly plugin: KyselyPlugin;
  /** Resolves once the transaction under test has written its first voucher. */
  readonly reached: Promise<void>;
  /** Whether the barrier was reached. */
  readonly hit: () => boolean;
  /** Lets the transaction under test go on. */
  release(): void;
}

/**
 * Stops the first INSERT into ledger_vouchers after PostgreSQL ran it, on its own transaction: every
 * balance row the voucher needs is locked by then (ledger.post refuses an account not locked by the
 * transaction), and they stay locked until release().
 */
export function voucherBarrier(): VoucherBarrier {
  const compiler = new PostgresQueryCompiler();
  const pending = new Set<QueryId>();
  const reached = deferred();
  const gate = deferred();
  let armed = true;
  let hit = false;
  return {
    plugin: {
      transformQuery({ node, queryId }) {
        if (armed && VOUCHER_INSERT.test(compiler.compileQuery(node, queryId).sql)) {
          armed = false;
          pending.add(queryId);
        }
        return node;
      },
      async transformResult({ queryId, result }) {
        if (pending.delete(queryId)) {
          hit = true;
          reached.resolve();
          await gate.promise;
        }
        return result;
      },
    },
    reached: reached.promise,
    hit: () => hit,
    release: () => gate.resolve(),
  };
}

/** The app whose admin entry runs through `plugin`, as far as withAdmin is concerned. */
export function throughPlugin(a: App, plugin: KyselyPlugin): App {
  return { ...a, f: { ...a.f, db: a.f.db.withPlugin(plugin) } };
}

export interface HeldFreeze {
  readonly uniqKey: string;
  /** Settles once the freeze is posted and its row lock held, or once its transaction failed. */
  readonly posted: Promise<void>;
  /** Lets the freeze's transaction commit. */
  release(): void;
  readonly done: Promise<void>;
}

/**
 * A withdrawal freeze of `fen` on the suite's second connection, which holds the member's balance
 * row (and only that: no order key, no users row, the same way a withdrawal touches an account) from
 * its lockBalances until release().
 */
export function heldFreeze(a: App, userId: string, fen: bigint): HeldFreeze {
  const { h, s } = a;
  const uniqKey = `WDR:test:${randomUUID()}`;
  const posted = deferred();
  const gate = deferred();
  const done = s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const [balance] = await h.ledger.lockBalances(trx, { appId: h.appId, userIds: [userId] });
      expect(balance, 'balance row of the freeze').toBeDefined();
      await h.ledger.post(trx, {
        appId: h.appId,
        uniqKey,
        bizType: 'WITHDRAW',
        bizId: randomUUID(),
        operator: 'system',
        memo: null,
        orderKey: null,
        beneficiaryUserId: null,
        role: null,
        voucherKind: 'WITHDRAW_FREEZE',
        entries: [
          {
            account: { ownerType: 'user', accountId: balance!.account_id },
            sub_account: 'available',
            amount_fen: fen,
            ledger_type: 'WITHDRAW_FREEZE',
            sub_type: null,
            income_type: null,
          },
          {
            account: { ownerType: 'user', accountId: balance!.account_id },
            sub_account: 'frozen',
            amount_fen: -fen,
            ledger_type: 'WITHDRAW_FREEZE',
            sub_type: null,
            income_type: null,
          },
        ],
      });
      posted.resolve();
      await gate.promise;
    });
  const settle = () => posted.resolve();
  void done.then(settle, settle);
  return { uniqKey, posted: posted.promise, release: () => gate.resolve(), done };
}

/** The member's balance row as stored. */
export async function balanceRow(a: App, userId: string) {
  return a.h.db
    .selectFrom('account_balances')
    .select(['available_fen', 'frozen_fen', 'version'])
    .where('app_id', '=', a.h.appId)
    .where('account_id', '=', accountOf(a, userId))
    .executeTakeFirstOrThrow();
}

/** The member's entries above `afterVersion`, in posting order (available before frozen). */
export async function entriesAfter(a: App, userId: string, afterVersion: bigint) {
  return a.h.db
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_vouchers as v', (join) =>
      join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
    )
    .select([
      'v.uniq_key',
      'e.sub_account',
      'e.amount_fen',
      'e.balance_after_fen',
      'e.account_version',
      'e.ledger_type',
      'e.sub_type',
    ])
    .where('e.app_id', '=', a.h.appId)
    .where('e.account_id', '=', accountOf(a, userId))
    .where('e.account_version', '>', afterVersion)
    .orderBy('e.account_version')
    .orderBy('e.sub_account')
    .execute();
}
