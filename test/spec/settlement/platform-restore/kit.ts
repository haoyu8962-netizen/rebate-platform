// B2-09gb rule-test kit (claude-independent, SPEC_REF 29c27a1b): contracts/openapi.yaml
// restoreAdminReconDiff for a `platform_restore` difference (CT-24zz; 编排裁定 D10-973, D10-982,
// D10-986, D10-994) and 08 BR-FUND-22 R12 / R13, BR-FUND-01 (R13 row,「已处置退件数」D10-937),
// BR-CALC-02 (有效联盟佣金), BR-CALC-09 (受益人状态规则).
// Real pieces: the admin entry (createHttpApp('admin'): token, session, order.restore, the totp
// step-up gate over Redis, contract validation, PostgreSQL idempotency, the audit writer), ledger,
// PostgreSQL through @couli/db/testing as couli_app — all through ../admin-recon-restore/kit.ts
// (read only, imported). Synthetic, written directly as the earlier steps would have left them:
//   - R12: a VOID order (never credited, no voucher) with its rebate history rows, the last one the
//     row by which it entered VOID;
//   - R13: an order credited through the B2-09g kit's seedOrder (snapshot, events, credit vouchers),
//     optionally a forfeited share given back by an account appeal (active event and the
//     ADMIN_ADJUST RESTORE of the appeal, as B2-09g writes them), then clawed back in full by hand
//     (R8: every beneficiary net and the platform net reversed as CLAWBACK vouchers, booked pair 0,
//     reason, refund counters, history row entering CLAWED_BACK), then the union's later data
//     (settle / est commission, a second order_settlements row; with no settled amount the order
//     has no order_settlements row at all, so the estimate is the only effective commission);
//   - the difference as orders' producer registers it (apps/api/src/modules/orders/application/
//     platform-restore-step.ts): source R1, type platform_restore, ref_type order, ref_id
//     `{order_key}#RESTORE#{entry_id}`, dedupe_key `platform_restore:{order_key}:{entry_id}`,
//     resolution {reason_code, rebate_status, trigger, platform_status}.
// No real user or merchant data. Expected amounts are written by hand in the tests (BR-CALC-02:
// B = floor(N⁺ × (10000 − reserve_bp) / 10000); BR-CALC-04: floor(B × ratio / 10000); the platform
// gets N⁺ less the beneficiaries' shares, reserve included, BR-FUND-05).
// Missing pieces fail as assertions: today the route answers 20001 restore_not_supported for every
// platform_restore difference.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { mulDivFloor, subFen } from '@couli/money';
import type { Selectable } from 'kysely';
import { expect } from 'vitest';
import type { PostingVoucher } from '../../../../apps/api/src/modules/ledger/index.ts';
import type { DiffSeed } from '../../ledger/admin-recon-diffs/kit.ts';
import {
  answer,
  diffNow,
  everything,
  memberOf,
  netsOf,
  normalize,
  seedDiff,
  seedOrder,
  type AdminSent,
  type DiffRow,
  type Envelope,
  type PersonSpec,
  type RestoreFixture,
  type Role,
  type SeededOrder,
} from '../admin-recon-restore/kit.ts';

export {
  DETAIL_KEYS,
  FAULT_POINTS,
  RESTORE,
  RESTORE_ACTION,
  answer,
  audits,
  available,
  detailView,
  diffNow,
  fixture,
  holdOrderKey,
  idempotencyRows,
  memberOf,
  netOf,
  netsOf,
  newKey,
  restoreKey,
  restorePath,
  restoreVouchers,
  seedDiff,
  setRisk,
  suite,
  track,
  unknownDiff,
  voucherLines,
  waiting,
  withRestoreAdmin,
  type AdminSent,
  type DiffRow,
  type FaultPoint,
  type RestoreFixture,
  type Role,
} from '../admin-recon-restore/kit.ts';

/** When the synthetic orders were attributed (the B2-09g kit's instant). */
const ATTR_AT = new Date('2026-08-20T00:00:00.000Z');
/** The batch that credited the R13 orders (the B2-09g kit's instant). */
const CREDITED_AT = new Date('2026-09-10T00:00:00.000Z');
/** The sync that voided or clawed back the order. */
const LEFT_AT = new Date('2026-10-01T00:00:00.000Z');
/** The union's later report that restored the order (the producer registered the difference). */
const RESTORED_SYNC_AT = new Date('2026-10-20T00:00:00.000Z');
/** The rights event of the hand-written R8 clawback. */
const CLAWBACK_EVENT = 'R1';
/** When an account appeal gave a forfeited share back (after the forfeiture, before the clawback). */
const APPEALED_AT = new Date('2026-09-20T00:00:00.000Z');

export type PlatformStatus = 'DEPOSIT_PAID' | 'PAID' | 'RECEIVED' | 'SETTLED' | 'INVALID';
export type RestorableStatus = 'VOID' | 'CLAWED_BACK';
export type RestoreReason = 'REFUND' | 'RIGHTS' | 'COMMISSION_ZERO';

/** Self 5000 / direct 1000 / indirect 500, nobody forfeited (each a new member). */
export const THREE_PEOPLE: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000 },
  { role: 'indirect', ratioBp: 500 },
];

/** What the difference of an order names and records. */
export interface PlatformDiffTarget {
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly orderKey: string;
  /** The order_status_history (field rebate) row by which the order entered its current status. */
  readonly entryId: bigint;
  readonly rebate: RestorableStatus;
  readonly reason: string | null;
  readonly platformStatus: PlatformStatus;
  /** The union commission after the platform restore (display only in the difference). */
  readonly commissionFen: bigint;
  readonly trigger: 'status' | 'commission';
}

// ---------------------------------------------------------------------------------------------
// Rebate history.

export interface RebateStep {
  readonly from: string | null;
  readonly event: string;
  readonly to: string;
  readonly source?: 'sync' | 'admin' | 'system';
  readonly at?: Date;
}

/** One order_status_history row with field rebate (settlement's rows, written directly). */
export async function addRebateStep(
  f: RestoreFixture,
  orderId: string,
  step: RebateStep,
): Promise<bigint> {
  const row = await f.db
    .insertInto('order_status_history')
    .values({
      app_id: f.appId,
      order_id: orderId,
      field: 'rebate',
      from_status: step.from,
      event: step.event,
      to_status: step.to,
      source: step.source ?? 'sync',
      at: step.at ?? LEFT_AT,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The order's rebate history rows, oldest first. */
export function rebateHistory(f: RestoreFixture, orderId: string) {
  return f.db
    .selectFrom('order_status_history')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .where('field', '=', 'rebate')
    .orderBy('id')
    .execute();
}

/** All the order's status history rows (both fields), oldest first. */
export function orderHistory(f: RestoreFixture, orderId: string) {
  return f.db
    .selectFrom('order_status_history')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .orderBy('id')
    .execute();
}

export type HistoryRow = Awaited<ReturnType<typeof orderHistory>>[number];

/**
 * The restore went through the rebate state machine (specs/state-machines/order-rebate.yaml R12 /
 * R13, event ADMIN_RESTORE): orders.row_version moved by exactly one, and the order's history has
 * exactly one new row — field rebate, from the status of the difference to `to`, event
 * ADMIN_RESTORE, source admin, at the server's clock — the earlier rows untouched.
 */
export async function expectRestoreStep(
  f: RestoreFixture,
  before: { readonly order: OrderRow; readonly history: readonly HistoryRow[] },
  step: { readonly from: RestorableStatus; readonly to: string },
): Promise<void> {
  const order = await orderRow(f, before.order.order_id);
  expect(order.row_version, `row_version of ${order.order_id}`).toBe(before.order.row_version + 1);
  const history = await orderHistory(f, before.order.order_id);
  expect(history.slice(0, before.history.length)).toEqual(before.history);
  const added = history.slice(before.history.length);
  expect(
    added.map((row) => ({
      field: row.field,
      from_status: row.from_status,
      to_status: row.to_status,
      event: row.event,
      source: row.source,
      at: row.at,
    })),
    `history of ${order.order_id}`,
  ).toEqual([
    {
      field: 'rebate',
      from_status: step.from,
      to_status: step.to,
      event: 'ADMIN_RESTORE',
      source: 'admin',
      at: f.clock.now(),
    },
  ]);
}

// ---------------------------------------------------------------------------------------------
// R12: a VOID order that was never credited.

export interface BareSpec {
  /** VOID by default; CLAWED_BACK only as a bare twin (no snapshot, no voucher). */
  readonly rebate?: RestorableStatus;
  /** The current platform_status (default PAID). */
  readonly platformStatus?: PlatformStatus;
  /** The attributed member; null: unattributed (user_id empty); omitted: a new member. */
  readonly userId?: string | null;
  /** orders.received_at (default none). */
  readonly receivedAt?: Date | null;
  /** orders.reason (default REFUND). */
  readonly reason?: RestoreReason | null;
  /** est_commission_fen (default 800). */
  readonly est?: bigint | null;
  /** settle_commission_fen (default none). */
  readonly settle?: bigint | null;
  /** The sub-order number (default a fresh one); the same number in another app is allowed. */
  readonly subOrderId?: string;
}

export interface BareOrder extends PlatformDiffTarget {
  readonly userId: string | null;
}

/** reserve_bp and the member's ratio of a bare order's snapshot (the B2-09g kit's defaults). */
const BARE_RESERVE_BP = 1500;
const BARE_SELF_RATIO_BP = 5000;
/**
 * The platform statuses at which an attributed order has its snapshot: paid or later, and INVALID
 * (such an order had its snapshot before the platform invalidated it, and goes back to a paid
 * status in the tests).
 */
const SNAPSHOT_STATUSES: readonly PlatformStatus[] = ['PAID', 'RECEIVED', 'SETTLED', 'INVALID'];

/**
 * The immutable snapshot (version 1) of a bare order, the four tables commission's insertSnapshot
 * writes: the member alone, self, on the estimate. BR-CALC-02 B = floor(N⁺ × (10000 − reserve_bp) /
 * 10000), BR-CALC-04 amount = floor(B × ratio / 10000), the rest of B retained by the platform.
 */
async function seedBareSnapshot(
  f: RestoreFixture,
  orderId: string,
  userId: string,
  est: bigint | null,
): Promise<void> {
  const rawN = est ?? 0n;
  const positiveN = rawN > 0n ? rawN : 0n;
  const base = mulDivFloor(positiveN, BigInt(10000 - BARE_RESERVE_BP), 10000n);
  const amount = mulDivFloor(base, BigInt(BARE_SELF_RATIO_BP), 10000n);
  await f.db
    .insertInto('commission_splits')
    .values({
      app_id: f.appId,
      order_id: orderId,
      rule_version_id: f.ruleVersionId,
      order_type: 'self',
      activity_type: null,
      rebate_mode: null,
      paid_at: ATTR_AT,
      paid_at_source: 'platform',
      raw_n_fen: rawN,
      subsidy_commission_fen: 0n,
      reserve_bp: BARE_RESERVE_BP,
      reserve_fen: subFen(positiveN, base),
      tlj_deduct_fen: 0n,
      base_fen: base,
      platform_retain_fen: subFen(base, amount),
      beneficiaries: JSON.stringify([
        {
          user_id: userId,
          role: 'self',
          ratio_bp: BARE_SELF_RATIO_BP,
          level: 'L1',
          initial_status: 'active',
          forfeit_reason: null,
        },
      ]),
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('commission_split_totals')
    .values({
      app_id: f.appId,
      order_id: orderId,
      commission_version: 1,
      n_total_fen: rawN,
      pre_base_deduct_fen: subFen(rawN, base),
      base_fen: base,
      user_share_total_fen: amount,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: subFen(rawN, amount),
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('commission_split_amounts')
    .values({
      app_id: f.appId,
      order_id: orderId,
      commission_version: 1,
      user_id: userId,
      role: 'self',
      base_fen: base,
      amount_fen: amount,
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('commission_split_beneficiary_events')
    .values({
      app_id: f.appId,
      order_id: orderId,
      user_id: userId,
      role: 'self',
      status: 'active',
      reason: null,
      created_at: ATTR_AT,
    })
    .execute();
}

/**
 * A VOID order of the fixture's app (est 800, PAID, never credited, settle_period empty) with its
 * rebate history: imported (ESTIMATED, or UNATTRIBUTED without user) and the row entering VOID.
 * An attributed VOID order paid or later, or INVALID, also has its snapshot (D10-1136); an
 * unattributed order, a bare CLAWED_BACK twin and a DEPOSIT_PAID order have none.
 */
export async function seedBareOrder(f: RestoreFixture, spec: BareSpec = {}): Promise<BareOrder> {
  const orderId = randomUUID();
  const platform = 'taobao';
  const subOrderId = spec.subOrderId ?? `void-${orderId}`;
  const orderKey = `${platform}:${subOrderId}`;
  const userId = spec.userId === undefined ? await memberOf(f) : spec.userId;
  const rebate = spec.rebate ?? 'VOID';
  const platformStatus = spec.platformStatus ?? 'PAID';
  const reason = spec.reason === undefined ? 'REFUND' : spec.reason;
  const est = spec.est === undefined ? 800n : spec.est;
  const settle = spec.settle === undefined ? null : spec.settle;
  const clawed = rebate === 'CLAWED_BACK';
  await f.db
    .insertInto('order_keys')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: ATTR_AT,
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('orders')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: ATTR_AT,
      raw_item_id: 'synthetic',
      user_id: userId,
      user_basis: userId === null ? null : 'param',
      buy_type: userId === null ? null : 'self',
      platform_status: platformStatus,
      rebate_status: rebate,
      reason,
      hold: false,
      rights_pending: false,
      commission_version: 1,
      est_commission_fen: est,
      settle_commission_fen: settle,
      paid_at: ATTR_AT,
      received_at: spec.receivedAt ?? null,
      settle_period: null,
      booked_base_fen: clawed ? 0n : null,
      booked_n_fen: clawed ? 0n : null,
      credited_at: clawed ? CREDITED_AT : null,
      quantity: 1,
      refunded_quantity: 0,
      row_version: 2,
      created_at: ATTR_AT,
      updated_at: LEFT_AT,
    })
    .execute();
  if (userId !== null && rebate === 'VOID' && SNAPSHOT_STATUSES.includes(platformStatus)) {
    await seedBareSnapshot(f, orderId, userId, est);
  }
  const start = userId === null ? 'UNATTRIBUTED' : 'ESTIMATED';
  await addRebateStep(f, orderId, {
    from: null,
    event: userId === null ? 'IMPORT_UNATTRIBUTED' : 'IMPORT_ATTRIBUTED',
    to: start,
    at: ATTR_AT,
  });
  if (clawed) {
    await addRebateStep(f, orderId, {
      from: start,
      event: 'SETTLE_BATCH_CREDIT',
      to: 'CREDITED',
      source: 'system',
      at: CREDITED_AT,
    });
  }
  const entryId = await addRebateStep(f, orderId, {
    from: clawed ? 'CREDITED' : start,
    event: clawed ? 'RIGHTS_FULL' : 'PLATFORM_INVALID',
    to: rebate,
  });
  return {
    orderId,
    platform,
    subOrderId,
    orderKey,
    userId,
    entryId,
    rebate,
    reason,
    platformStatus,
    commissionFen: (settle ?? est ?? 0n) > 0n ? (settle ?? est ?? 0n) : 0n,
    trigger: 'status',
  };
}

// ---------------------------------------------------------------------------------------------
// R13: a credited order clawed back in full.

export interface ClawedSpec {
  /** The beneficiaries (default THREE_PEOPLE). */
  readonly people?: readonly PersonSpec[];
  /** N of the credit (default 1000). */
  readonly creditFen?: bigint;
  /** reserve_bp of the snapshot (default 1500). */
  readonly reserveBp?: number;
  /** orders.reason the clawback wrote (default RIGHTS). */
  readonly reason?: RestoreReason;
  /** The current platform_status (default SETTLED). */
  readonly platformStatus?: PlatformStatus;
  /** The current est_commission_fen (default 5555: never the effective one while settle is set). */
  readonly est?: bigint | null;
  /** The current settle_commission_fen (default 2000), with an order_settlements row seq 2. */
  readonly settle?: bigint | null;
  readonly quantity?: number;
  /** refunded_quantity now (default 2). */
  readonly refundedQuantity?: number;
  /** refunded_quantity_at_credit (default 0). */
  readonly refundedAtCredit?: number | null;
  /** refunded_quantity_r9_baseline after the clawback (default 0). */
  readonly baselineBefore?: number | null;
  /**
   * Vouchers of a beneficiary key written after the clawback (synthetic; BR-FUND-22 细则「正常不会
   * 出现」): a SETTLE_ADJUST of `fen` to the role's member.
   */
  readonly residual?: readonly { readonly role: Role; readonly fen: bigint }[];
  /**
   * A platform voucher written after the clawback (synthetic, 正常不会出现): a SETTLE_ADJUST of
   * `fen` from UNION_RECEIVABLE:{platform} to COMMISSION_REVENUE, so the platform's net is `fen`.
   */
  readonly platformResidual?: bigint;
  /**
   * Forfeited roles (PersonSpec.forfeited) an account appeal gave back before the clawback: an
   * active share event after the forfeited one and the appeal's ADMIN_ADJUST RESTORE of the
   * forfeited amount (debit COMMISSION_REVENUE, credit the member's available; B2-09g).
   */
  readonly appealRestored?: readonly Role[];
}

export interface ClawedOrder extends PlatformDiffTarget {
  readonly order: SeededOrder;
  readonly user: (role: Role) => string;
}

/** The voucher builder's view of the order. */
interface Ref {
  readonly platform: string;
  readonly orderKey: string;
}

/** One voucher on its own transaction, its beneficiary's balance row locked first. */
async function post(f: RestoreFixture, voucher: PostingVoucher): Promise<void> {
  await f.db.transaction().execute(async (trx) => {
    if (voucher.beneficiaryUserId !== null) {
      await f.ledger.lockBalances(trx, { appId: f.appId, userIds: [voucher.beneficiaryUserId] });
    }
    await f.ledger.post(trx, voucher);
  });
}

/** UNION_RECEIVABLE:{platform} against the member's available; `fen` is the change of the net. */
function memberVoucher(
  f: RestoreFixture,
  ref: Ref,
  userId: string,
  role: Role,
  input: { uniqKey: string; kind: string; type: string; sub: string; fen: bigint },
): PostingVoucher {
  const accountId = f.accounts.get(userId);
  if (accountId === undefined) throw new Error('fixture: the member has no account');
  return {
    appId: f.appId,
    uniqKey: input.uniqKey,
    bizType: `ORDER_${input.kind}`,
    bizId: ref.orderKey,
    operator: 'system',
    memo: null,
    orderKey: ref.orderKey,
    beneficiaryUserId: userId,
    role,
    voucherKind: input.kind,
    entries: [
      {
        account: { ownerType: 'platform', subject: `UNION_RECEIVABLE:${ref.platform}` },
        sub_account: 'available',
        amount_fen: input.fen,
        ledger_type: input.type,
        sub_type: input.sub,
        income_type: null,
      },
      {
        account: { ownerType: 'user', accountId },
        sub_account: 'available',
        amount_fen: -input.fen,
        ledger_type: input.type,
        sub_type: input.sub,
        income_type: null,
      },
    ],
  };
}

/** The platform's full clawback: debit COMMISSION_REVENUE, credit UNION_RECEIVABLE:{platform}. */
function platformClawback(f: RestoreFixture, ref: Ref, fen: bigint, sub: string): PostingVoucher {
  return {
    appId: f.appId,
    uniqKey: `${ref.orderKey}:PLATFORM:CLAWBACK:${CLAWBACK_EVENT}`,
    bizType: 'ORDER_CLAWBACK',
    bizId: ref.orderKey,
    operator: 'system',
    memo: null,
    orderKey: ref.orderKey,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'CLAWBACK',
    entries: [
      {
        account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
        sub_account: 'available',
        amount_fen: fen,
        ledger_type: 'CLAWBACK',
        sub_type: sub,
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: `UNION_RECEIVABLE:${ref.platform}` },
        sub_account: 'available',
        amount_fen: -fen,
        ledger_type: 'CLAWBACK',
        sub_type: sub,
        income_type: null,
      },
    ],
  };
}

/** A platform SETTLE_ADJUST after the clawback: debit UNION_RECEIVABLE, credit COMMISSION_REVENUE. */
function platformAdjust(f: RestoreFixture, ref: Ref, fen: bigint): PostingVoucher {
  return {
    appId: f.appId,
    uniqKey: `${ref.orderKey}:PLATFORM:ADJ:X1`,
    bizType: 'ORDER_SETTLE_ADJUST',
    bizId: ref.orderKey,
    operator: 'system',
    memo: null,
    orderKey: ref.orderKey,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'SETTLE_ADJUST',
    entries: [
      {
        account: { ownerType: 'platform', subject: `UNION_RECEIVABLE:${ref.platform}` },
        sub_account: 'available',
        amount_fen: fen,
        ledger_type: 'SETTLE_ADJUST',
        sub_type: 'SETTLE_DIFF',
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
        sub_account: 'available',
        amount_fen: -fen,
        ledger_type: 'SETTLE_ADJUST',
        sub_type: 'SETTLE_DIFF',
        income_type: null,
      },
    ],
  };
}

/**
 * The account appeal's restore of a forfeited share (B2-09g, ADMIN_ADJUST:RESTORE:APPEAL): debit
 * COMMISSION_REVENUE, credit the member's available, keyed by the appeal's difference.
 */
function appealVoucher(
  f: RestoreFixture,
  ref: Ref,
  userId: string,
  role: Role,
  fen: bigint,
): PostingVoucher {
  const accountId = f.accounts.get(userId);
  if (accountId === undefined) throw new Error('fixture: the member has no account');
  const appealDiffId = randomUUID();
  return {
    appId: f.appId,
    uniqKey: `${ref.orderKey}:${userId}:${role}:RESTORE:${appealDiffId}`,
    bizType: 'ADMIN_RESTORE',
    bizId: appealDiffId,
    operator: `admin:${randomUUID()}`,
    memo: null,
    orderKey: ref.orderKey,
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
        account: { ownerType: 'user', accountId },
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
 * The fixture with its INSERTs into order_settlements dropped (that table is append-only, so a
 * row seedOrder writes could not be removed afterwards); every other call goes to the real handle.
 */
function withoutSettlementRows(f: RestoreFixture): RestoreFixture {
  const skipped = { values: () => ({ execute: () => Promise.resolve([]) }) };
  const handle = new Proxy(f.db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (property === 'insertInto') {
        return (table: unknown) =>
          table === 'order_settlements' ? skipped : method.call(target, table);
      }
      return method.bind(target);
    },
  });
  return { ...f, db: handle };
}

const ENTRY_EVENTS: Readonly<Record<RestoreReason, string>> = {
  RIGHTS: 'RIGHTS_FULL',
  REFUND: 'REFUND_AFTER_SETTLE',
  COMMISSION_ZERO: 'COMMISSION_POSITIVE_ZERO',
};

/**
 * A CREDITED order (B2-09g kit: snapshot taken on an estimate N + 3333, credit vouchers at
 * `creditFen`) clawed back in full by hand, then the union's later data written on the row.
 */
export async function seedClawedBack(
  f: RestoreFixture,
  spec: ClawedSpec = {},
): Promise<ClawedOrder> {
  const creditFen = spec.creditFen ?? 1000n;
  const reason = spec.reason ?? 'RIGHTS';
  const platformStatus = spec.platformStatus ?? 'SETTLED';
  const est = spec.est === undefined ? 5555n : spec.est;
  const settle = spec.settle === undefined ? 2000n : spec.settle;
  // No settled amount now: no order_settlements row either, so only the estimate can be effective.
  const order = await seedOrder(settle === null ? withoutSettlementRows(f) : f, {
    people: spec.people ?? THREE_PEOPLE,
    settleFen: creditFen,
    reserveBp: spec.reserveBp ?? 1500,
  });
  const ref: Ref = { platform: order.platform, orderKey: order.orderKey };

  // An account appeal gave forfeited shares back (B2-09g): active event, then its RESTORE voucher.
  for (const role of spec.appealRestored ?? []) {
    const person = order.people.find((p) => p.role === role);
    if (person === undefined || !person.forfeited || person.forfeitFen <= 0n) {
      throw new Error(`fixture: the ${role} share was not forfeited`);
    }
    await f.db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: f.appId,
        order_id: order.orderId,
        user_id: person.userId,
        role,
        status: 'active',
        reason: null,
        created_at: APPEALED_AT,
      })
      .execute();
    await post(f, appealVoucher(f, ref, person.userId, role, person.forfeitFen));
  }

  // R8 by hand: every net reversed (BR-FUND-08), the beneficiaries first, then the platform.
  const nets = await netsOf(f, order.orderKey);
  for (const b of nets.beneficiaries) {
    if (b.net_fen <= 0n) continue;
    await post(
      f,
      memberVoucher(f, ref, b.beneficiary_user_id, b.role, {
        uniqKey: `${order.orderKey}:${b.beneficiary_user_id}:${b.role}:CLAWBACK:${CLAWBACK_EVENT}`,
        kind: 'CLAWBACK',
        type: 'CLAWBACK',
        sub: reason,
        fen: -b.net_fen,
      }),
    );
  }
  if (nets.platform_net_fen > 0n) {
    await post(f, platformClawback(f, ref, nets.platform_net_fen, reason));
  }
  for (const [index, extra] of (spec.residual ?? []).entries()) {
    await post(
      f,
      memberVoucher(f, ref, order.user(extra.role), extra.role, {
        uniqKey: `${order.orderKey}:${order.user(extra.role)}:${extra.role}:ADJ:X${index + 1}`,
        kind: 'SETTLE_ADJUST',
        type: 'SETTLE_ADJUST',
        sub: 'SETTLE_DIFF',
        fen: extra.fen,
      }),
    );
  }
  if (spec.platformResidual !== undefined) {
    await post(f, platformAdjust(f, ref, spec.platformResidual));
  }

  await f.db
    .updateTable('orders')
    .set({
      rebate_status: 'CLAWED_BACK',
      reason,
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      platform_status: platformStatus,
      est_commission_fen: est,
      settle_commission_fen: settle,
      quantity: spec.quantity ?? 3,
      refunded_quantity: spec.refundedQuantity ?? 2,
      refunded_quantity_at_credit: spec.refundedAtCredit === undefined ? 0 : spec.refundedAtCredit,
      refunded_quantity_r9_baseline: spec.baselineBefore === undefined ? 0 : spec.baselineBefore,
      row_version: 4,
      updated_at: RESTORED_SYNC_AT,
    })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', order.orderId)
    .execute();
  if (settle !== null && settle !== creditFen) {
    await f.db
      .insertInto('order_settlements')
      .values({
        app_id: f.appId,
        order_id: order.orderId,
        seq: 2,
        source: 'STATEMENT',
        settle_commission_fen: settle,
        settled_at: RESTORED_SYNC_AT,
        content_hash: randomUUID(),
        created_at: RESTORED_SYNC_AT,
      })
      .execute();
  }
  await addRebateStep(f, order.orderId, {
    from: null,
    event: 'IMPORT_ATTRIBUTED',
    to: 'ESTIMATED',
    at: ATTR_AT,
  });
  await addRebateStep(f, order.orderId, {
    from: 'ESTIMATED',
    event: 'PLATFORM_RECEIVED_OR_SETTLED',
    to: 'WAITING',
    at: ATTR_AT,
  });
  await addRebateStep(f, order.orderId, {
    from: 'WAITING',
    event: 'SETTLE_BATCH_CREDIT',
    to: 'CREDITED',
    source: 'system',
    at: CREDITED_AT,
  });
  const entryId = await addRebateStep(f, order.orderId, {
    from: 'CREDITED',
    event: ENTRY_EVENTS[reason],
    to: 'CLAWED_BACK',
  });
  const effective = settle ?? est ?? 0n;
  return {
    order,
    user: (role) => order.user(role),
    orderId: order.orderId,
    platform: order.platform,
    subOrderId: order.subOrderId,
    orderKey: order.orderKey,
    entryId,
    rebate: 'CLAWED_BACK',
    reason,
    platformStatus,
    commissionFen: effective > 0n ? effective : 0n,
    trigger: 'commission',
  };
}

// ---------------------------------------------------------------------------------------------
// The difference.

/** `{order_key}#RESTORE#{entry_id}` (orders' platformRestoreRefId). */
export function refIdOf(orderKey: string, entryId: bigint): string {
  return `${orderKey}#RESTORE#${entryId.toString(10)}`;
}

/** The platform_restore difference of the order as orders' producer registers it. */
export function seedPlatformDiff(
  f: RestoreFixture,
  target: PlatformDiffTarget,
  patch: DiffSeed = {},
): Promise<DiffRow> {
  return seedDiff(f, {
    source: 'R1',
    type: 'platform_restore',
    period: '2026-10',
    ref_type: 'order',
    ref_id: refIdOf(target.orderKey, target.entryId),
    expected_fen: target.commissionFen,
    actual_fen: 0n,
    diff_fen: target.commissionFen,
    dedupe_key: `platform_restore:${target.orderKey}:${target.entryId.toString(10)}`,
    resolution: {
      reason_code: target.reason,
      rebate_status: target.rebate,
      trigger: target.trigger,
      platform_status: target.platformStatus,
    },
    ...patch,
  });
}

// ---------------------------------------------------------------------------------------------
// Reads.

export type OrderRow = Selectable<DB['orders']>;

/** The order row now. */
export async function orderRow(f: RestoreFixture, orderId: string): Promise<OrderRow> {
  const row = await f.db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  expect(row, `orders ${orderId}`).toBeDefined();
  return row!;
}

/** The columns no platform restore may change (R12 and R13 alike). */
export function untouched(row: OrderRow) {
  return {
    user_id: row.user_id,
    platform: row.platform,
    sub_order_id: row.sub_order_id,
    attr_at: row.attr_at,
    platform_status: row.platform_status,
    est_commission_fen: row.est_commission_fen,
    settle_commission_fen: row.settle_commission_fen,
    subsidy_commission_fen: row.subsidy_commission_fen,
    base_fen: row.base_fen,
    n_total_fen: row.n_total_fen,
    paid_at: row.paid_at,
    received_at: row.received_at,
    quantity: row.quantity,
    refunded_quantity: row.refunded_quantity,
    refunded_quantity_at_credit: row.refunded_quantity_at_credit,
    hold: row.hold,
    locked: row.locked,
  };
}

/** The order's beneficiary_credits rows. */
export function obligationsOf(f: RestoreFixture, orderId: string) {
  return f.db
    .selectFrom('beneficiary_credits')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .orderBy('user_id')
    .orderBy('role')
    .execute();
}

/** Everything of the app a platform restore may write (the B2-09g set plus the order tables). */
export async function world(f: RestoreFixture) {
  return {
    ...(await everything(f)),
    history: await f.db
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    obligations: await f.db
      .selectFrom('beneficiary_credits')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('beneficiary_credit_id')
      .execute(),
    settlements: await f.db
      .selectFrom('order_settlements')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('order_id')
      .orderBy('seq')
      .execute(),
    adjustments: await f.db
      .selectFrom('settle_adjustments')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('order_id')
      .execute(),
  };
}

/** The vouchers of one order key (all kinds), by uniq_key. */
export function orderVouchers(f: RestoreFixture, orderKey: string) {
  return f.db
    .selectFrom('ledger_vouchers')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_key', '=', orderKey)
    .orderBy('uniq_key')
    .execute();
}

/** `{order_key}:PLATFORM:RESTORE:{recon_diff_id}` (specs/ledger-templates.csv). */
export function platformKey(orderKey: string, diffId: string): string {
  return `${orderKey}:PLATFORM:RESTORE:${diffId}`;
}

/** ADMIN_ADJUST:RESTORE:USER — debit UNION_RECEIVABLE:{platform}, credit the member's available. */
export function memberLines(platform: string, userId: string, fen: bigint): string[] {
  return [
    `UNION_RECEIVABLE:${platform}|platform|available|${String(fen)}|ADMIN_ADJUST|RESTORE`,
    `USER_BALANCE|${userId}|available|${String(-fen)}|ADMIN_ADJUST|RESTORE`,
  ].sort();
}

/** ADMIN_ADJUST:RESTORE:PLATFORM — debit UNION_RECEIVABLE:{platform}, credit COMMISSION_REVENUE. */
export function platformLines(platform: string, fen: bigint): string[] {
  return [
    `UNION_RECEIVABLE:${platform}|platform|available|${String(fen)}|ADMIN_ADJUST|RESTORE`,
    `COMMISSION_REVENUE|platform|available|${String(-fen)}|ADMIN_ADJUST|RESTORE`,
  ].sort();
}

// ---------------------------------------------------------------------------------------------
// Answers.

export interface PlatformRestored {
  /** data.recon_diff, its instants as epoch milliseconds. */
  readonly recon_diff: Record<string, unknown>;
  readonly restored_fen: unknown;
  readonly rebate_status_after: unknown;
}

/** A successful platform restore: exactly recon_diff, restored_fen and rebate_status_after. */
export async function platformRestored(sent: AdminSent): Promise<PlatformRestored> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual([
    'rebate_status_after',
    'recon_diff',
    'restored_fen',
  ]);
  return {
    recon_diff: normalize(data['recon_diff']),
    restored_fen: data['restored_fen'],
    rebate_status_after: data['rebate_status_after'],
  };
}

/** 20001 [recon_diff_id] with the reason of the contract. */
export function refusedWith(
  sent: AdminSent,
  reason: 'restore_not_supported' | 'restore_platform_invalid' | 'restore_commission_zero',
): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'], reason });
}

/** 20902 data.resource=order: the order left the status of the difference (or re-entered it). */
export function orderConflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'order' });
}

/** 20902 data.resource=recon_diff: the difference is no longer open or processing. */
export function diffConflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'recon_diff' });
}

/**
 * The difference after a platform restore by `adminId` at the fixture's clock: adjusted, handler,
 * closed_at = updated_at = the clock, the three amounts as registered, resolution the stored keys
 * plus restore (rebate_status_before / _after, restored_fen as a string, operator, restored_at) and
 * the trimmed note when given; every other column as it was. Returns the row and resolution.restore.
 */
export async function expectAdjusted(
  f: RestoreFixture,
  before: DiffRow,
  expected: {
    readonly adminId: string;
    readonly from: RestorableStatus;
    readonly to: string;
    readonly restoredFen: bigint;
    readonly note?: string;
  },
): Promise<{ row: DiffRow; restore: Record<string, unknown> }> {
  const now = await diffNow(f, before.id);
  const resolution = now.resolution as Record<string, unknown> | null;
  expect(typeof resolution === 'object' && resolution !== null, JSON.stringify(resolution)).toBe(
    true,
  );
  const restore = resolution!['restore'] as Record<string, unknown> | undefined;
  expect(typeof restore === 'object' && restore !== null, JSON.stringify(resolution)).toBe(true);
  expect(restore, JSON.stringify(resolution)).toMatchObject({
    rebate_status_before: expected.from,
    rebate_status_after: expected.to,
    restored_fen: expected.restoredFen.toString(),
    operator: expected.adminId,
  });
  expect(typeof restore!['restored_at']).toBe('string');
  expect(Date.parse(restore!['restored_at'] as string)).toBe(f.clock.now().getTime());
  expect(resolution).toEqual({
    ...(before.resolution as Record<string, unknown>),
    restore,
    ...(expected.note === undefined ? {} : { note: expected.note }),
  });
  expect(now).toEqual({
    ...before,
    status: 'adjusted',
    handler_id: expected.adminId,
    closed_at: f.clock.now(),
    updated_at: f.clock.now(),
    resolution: now.resolution,
  });
  return { row: now, restore: restore! };
}

/** JSON text of a value with bigint as decimal strings (for "contains" checks). */
export function text(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ) ?? ''
  );
}

/** A signed amount standing alone in JSON text (`"-30"` or `:-30`), never inside a uuid. */
export function amountIn(json: string, fen: bigint): boolean {
  const digits = fen.toString().replace('-', '\\-');
  return new RegExp(`[":]\\s*${digits}(?![0-9a-f])`).test(json);
}
