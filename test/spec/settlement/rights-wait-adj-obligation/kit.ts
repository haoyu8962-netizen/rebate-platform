// Shared harness of the B2-04zza rule tests (FU-RIGHTS-WAIT-ADJ-OBLIGATION; D10-474 ②, D10-781 /
// D10-792). A CREDITED order whose rights success waits for the union (WAIT_COMMISSION, BR-FUND-08
// ③) is answered by the union's new settlement record: BR-FUND-06「入账后新结算记录回应待佣金维权见
// BR-FUND-08 细则 D10-474 ②，按 R10 SETTLE_ADJUST 处理」. On the negative route (BR-FUND-09 ①) the
// SETTLE_ADJUST vouchers, the obligations the beneficiary states call for (BR-FUND-04 ⑫, BR-CALC-09:
// forfeited / a new deferred one opened by R10 / kept with its pending amount recalculated) and
// the closing of the rights record share the sync transaction. Only a positive difference
// (BR-FUND-09 ②) still waits with the alert.
//
// Built on the B2-04lb harness (real rights command, real B2-04m credit, real B2-04s / B2-04zi
// clawback service). The simulated order sync below writes, on one transaction, what orders writes
// for a new union settlement record (commission_version + 1 with the snapshot copied, the new
// order_settlements STATEMENT row, settle_commission_fen, refunded_quantity when asked, row_version
// + 1) and then calls the clawback's onUpdated; an optional `after` step runs on the same
// transaction (a downstream failure rolls everything back). Expected amounts are written by hand in
// the tests, never obtained from the adjustment planner.
//
// Default order (credit kit): N 1000, reserve_bp 1500 → B 850; self 5000 / direct 1000 / indirect
// 500 → 425 / 85 / 42; PLATFORM:CREDIT 448 (retain + reserve). A held beneficiary's share is not
// credited (first_credit obligation, pending = share − net) and UNION_RECEIVABLE = N − Σ pending.
// New record 600 (seq 3) → B 510 → shares 255 / 51 / 25, reserve 90.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect } from 'vitest';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ClawbackResult } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import type { CreditRole } from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import { bounded, platformIncreaseLines } from '../clawback/kit.ts';
import type { PersonSpec } from '../credit/kit.ts';
import {
  LATER,
  harness as rightsCreditHarness,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
  type OrderSpec,
  type SeededOrder,
} from '../rights-credit/kit.ts';

export {
  LATER,
  NOW,
  TIMEOUT,
  creditKey,
  databaseFixture,
  platformKey,
  platformLines,
  receivable,
  userClawbackLines,
  userCreditLines,
} from '../rights-credit/kit.ts';
export { bounded, deferred, platformIncreaseLines, waitBlocked } from '../clawback/kit.ts';
export type { SeededOrder } from '../rights-credit/kit.ts';
export type { PersonSpec } from '../credit/kit.ts';

/** The alert of a settlement record left waiting (clawback-order, B2-04lb). */
export const ALERT_HELD = 'rights_settle_adjust_unsupported';

export const ROLES = ['self', 'direct', 'indirect'] as const;
export type Role = (typeof ROLES)[number];

/** States a beneficiary is moved to after the credit. */
export type LaterState = 'normal' | 'frozen' | 'appealing' | 'banned' | 'deleting' | 'deleted';

export const adjKey = (o: SeededOrder, role: Role, seq: number) =>
  `${o.orderKey}:${o.user(role)}:${role}:ADJ:${String(seq)}`;
export const platformAdjKey = (o: SeededOrder, seq: number) =>
  `${o.orderKey}:PLATFORM:ADJ:${String(seq)}`;

/** The default three beneficiaries with the given states at credit time. */
export function people(states: Partial<Record<Role, 'frozen' | 'appealing'>> = {}): PersonSpec[] {
  return [
    { role: 'self', ratioBp: 5000, ...(states.self === undefined ? {} : { state: states.self }) },
    {
      role: 'direct',
      ratioBp: 1000,
      ...(states.direct === undefined ? {} : { state: states.direct }),
    },
    {
      role: 'indirect',
      ratioBp: 500,
      ...(states.indirect === undefined ? {} : { state: states.indirect }),
    },
  ];
}

export interface ArrivalSpec {
  /** The union's new settlement amount (orders.settle_commission_fen after the sync). */
  readonly settleAfter: bigint;
  /** The new order_settlements seq (STATEMENT, created_at = the clock's now). */
  readonly newSeq: number;
  /** New orders.refunded_quantity written by the same sync (default unchanged). */
  readonly refundedQuantityAfter?: number;
  /** Runs on the sync transaction after onUpdated answered (e.g. throws to roll it back). */
  readonly after?: (trx: Transaction<DB>) => Promise<void>;
  /** Executor of the sync transaction (default: the shared pool). */
  readonly via?: Kysely<DB>;
  /** Called with the backend pid first thing in the sync transaction (lock timeouts set). */
  readonly onPid?: (pid: number) => void;
}

export interface Arrival {
  readonly change: OrderUpdateChange;
  readonly source: OrderStatusSource;
  readonly result: ClawbackResult;
}

/** Hand-written R10 vouchers: user debits by role, platform signed (> 0 decrease, < 0 increase). */
export interface AdjustSpec {
  readonly users: Partial<Record<Role, bigint>>;
  readonly platform: bigint;
}

export async function harness(db: Kysely<DB>) {
  const h = await rightsCreditHarness(db);
  const appId = h.appId;

  /** commission's side of a new commission_version, on the sync transaction. */
  async function copySnapshot(
    trx: Transaction<DB>,
    o: SeededOrder,
    from: number,
    to: number,
  ): Promise<void> {
    const totals = await trx
      .selectFrom('commission_split_totals')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('commission_version', '=', from)
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('commission_split_totals')
      .values({ ...totals, commission_version: to })
      .execute();
    const amounts = await trx
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('commission_version', '=', from)
      .execute();
    if (amounts.length > 0) {
      await trx
        .insertInto('commission_split_amounts')
        .values(amounts.map((a) => ({ ...a, commission_version: to })))
        .execute();
    }
  }

  /** One order sync carrying the union's new settlement record, then the clawback's onUpdated. */
  async function arrive(o: SeededOrder, spec: ArrivalSpec): Promise<Arrival> {
    const clawback = h.boot();
    const onPid = spec.onPid;
    return (spec.via ?? db).transaction().execute(async (trx) => {
      if (onPid !== undefined) onPid(await bounded(trx));
      await lockOrderKey(trx, o.platform, o.subOrderId);
      const before = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const version =
        before.settle_commission_fen === spec.settleAfter
          ? before.commission_version
          : before.commission_version + 1;
      if (version !== before.commission_version) {
        await copySnapshot(trx, o, before.commission_version, version);
      }
      await trx
        .insertInto('order_settlements')
        .values({
          app_id: appId,
          order_id: o.orderId,
          seq: spec.newSeq,
          source: 'STATEMENT',
          settle_commission_fen: spec.settleAfter,
          settled_at: h.clock.now(),
          content_hash: randomUUID(),
          created_at: h.clock.now(),
        })
        .execute();
      await trx
        .updateTable('orders')
        .set({
          settle_commission_fen: spec.settleAfter,
          commission_version: version,
          refunded_quantity: spec.refundedQuantityAfter ?? before.refunded_quantity,
          row_version: before.row_version + 1,
          updated_at: h.clock.now(),
        })
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .execute();
      const change: OrderUpdateChange = {
        app_id: appId,
        order_id: o.orderId,
        attr_at: before.attr_at,
        from_status: before.platform_status,
        to_status: before.platform_status,
        rule: null,
        received_at: before.received_at,
        est_before: before.est_commission_fen,
        est_after: before.est_commission_fen,
        settle_commission_fen: spec.settleAfter,
        attributed_now: false,
      };
      const source: OrderStatusSource = { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' };
      const result = await clawback.onUpdated(trx, change, source);
      if (spec.after !== undefined) await spec.after(trx);
      return { change, source, result };
    });
  }

  /** Moves a beneficiary to a state after the credit (risk state, or users.status for deletion). */
  async function setState(o: SeededOrder, role: Role, state: LaterState): Promise<void> {
    const userId = o.user(role);
    if (state === 'deleting' || state === 'deleted') {
      await db
        .updateTable('users')
        .set({ status: state })
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .execute();
      return;
    }
    await h.setRisk(db, userId, state);
  }

  /**
   * Historical ledger state only (as B2-04zi), booked pair unchanged, no balance edited: an earlier
   * voucher of this order that took `amount` of the beneficiary's net. Its uniq_key has the
   * production shape (`{order_key}:{user_id}:{role}:…`), so the order-scoped reads of this kit
   * (orderVoucherKeys, orderSubjectNet) count it as the ledger's order nets do.
   *   'revenue'    — a CLAWBACK whose amount went to the platform (debit USER_BALANCE / credit
   *                  COMMISSION_REVENUE), key `…:CLAWBACK:R{id}`: platform net + amount,
   *                  UNION_RECEIVABLE unchanged.
   *   'receivable' — a SETTLE_ADJUST back to UNION_RECEIVABLE on the order's latest seq, key
   *                  `…:ADJ:{seq}`, whose amount stays pending under a deferred obligation (seed it
   *                  with seedDeferred; BR-FUND-19 ⑤ then holds).
   */
  async function pastVoucher(
    o: SeededOrder,
    role: CreditRole,
    amount: bigint,
    to: 'revenue' | 'receivable',
  ): Promise<void> {
    const type = to === 'revenue' ? 'CLAWBACK' : 'SETTLE_ADJUST';
    const subType = to === 'revenue' ? 'PART_REFUND' : 'SETTLE_DIFF';
    const prefix = `${o.orderKey}:${o.user(role)}:${role}`;
    const uniqKey =
      to === 'revenue' ? `${prefix}:CLAWBACK:R${randomUUID()}` : `${prefix}:ADJ:${String(o.seq)}`;
    await db.transaction().execute(async (trx) => {
      const [account] = await h.ledger.lockBalances(trx, { appId, userIds: [o.user(role)] });
      if (account === undefined) throw new Error('rights-wait-adj harness: user has no account');
      await h.ledger.post(trx, {
        appId,
        uniqKey,
        bizType: to === 'revenue' ? 'ORDER_CLAWBACK' : 'ORDER_SETTLE_ADJUST',
        bizId: randomUUID(),
        operator: 'system',
        memo: null,
        orderKey: o.orderKey,
        beneficiaryUserId: o.user(role),
        role,
        voucherKind: type,
        entries: [
          {
            account: { ownerType: 'user', accountId: account.account_id },
            sub_account: 'available',
            amount_fen: amount,
            ledger_type: type,
            sub_type: subType,
            income_type: null,
          },
          {
            account:
              to === 'revenue'
                ? { ownerType: 'platform', subject: 'COMMISSION_REVENUE' }
                : { ownerType: 'platform', subject: receivable(o) },
            sub_account: 'available',
            amount_fen: -amount,
            ledger_type: type,
            sub_type: subType,
            income_type: null,
          },
        ],
      });
    });
  }

  /** Synthetic setup: an open deferred obligation (BR-FUND-04 ⑫) of an earlier R10 on o.seq. */
  async function seedDeferred(o: SeededOrder, role: CreditRole): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('beneficiary_credits')
      .values({
        beneficiary_credit_id: id,
        app_id: appId,
        order_id: o.orderId,
        user_id: o.user(role),
        role,
        kind: 'deferred',
        opened_by: 'R10',
        opened_ref: `S${String(o.seq)}`,
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
    return id;
  }

  /**
   * A credited order (credit kit defaults unless `spec` says otherwise); `prepare` runs after the
   * credit and before the rights success; then a rights success without deduction leaves the order
   * waiting (WAIT_COMMISSION, rights_pending true, one open CLAWBACK_NO_COMMISSION pending row).
   */
  async function waiting(
    spec: OrderSpec = {},
    prepare?: (o: SeededOrder) => Promise<void>,
  ): Promise<{ o: SeededOrder; waitingId: string }> {
    const o = await h.credited(spec);
    if (prepare !== undefined) await prepare(o);
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const rights = await h.onlyRights(o);
    expect(rights).toMatchObject({ status: 'WAIT_COMMISSION' });
    expect((await h.read(o)).rights_pending).toBe(true);
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
    ]);
    return { o, waitingId: rights.id };
  }

  /**
   * The order's vouchers are `before` plus exactly one R10 SETTLE_ADJUST set on `seq` with the
   * given lines; no new CLAWBACK voucher (not a reverse event; historical ones stay as they were).
   */
  async function expectAdjusted(
    o: SeededOrder,
    before: readonly string[],
    seq: number,
    spec: AdjustSpec,
  ): Promise<void> {
    const added: string[] = [];
    for (const role of ROLES) {
      const amount = spec.users[role];
      if (amount === undefined) continue;
      added.push(adjKey(o, role, seq));
      expect(await h.voucherLines(adjKey(o, role, seq)), role).toEqual(
        userClawbackLines(o, role, amount),
      );
    }
    if (spec.platform !== 0n) {
      added.push(platformAdjKey(o, seq));
      expect(await h.voucherLines(platformAdjKey(o, seq)), 'platform').toEqual(
        spec.platform > 0n
          ? platformDecreaseLines(o, spec.platform)
          : platformIncreaseLines(o, -spec.platform),
      );
    }
    expect(await h.orderVoucherKeys(o)).toEqual([...before, ...added].sort());
    const pastClawbacks = before.filter((k) => k.includes(':CLAWBACK:')).sort();
    expect(await h.clawbackKeys(o)).toEqual(pastClawbacks);
    for (const key of added) {
      const types = await h.voucherTypes(key);
      expect(types, key).toHaveLength(1);
      expect(types[0]?.startsWith('SETTLE_ADJUST|'), `${key} ${String(types[0])}`).toBe(true);
    }
  }

  /** The waiting rights record answered on the sync transaction (BR-FUND-06). */
  async function expectAnswered(o: SeededOrder, waitingId: string): Promise<void> {
    expect(await h.onlyRights(o)).toMatchObject({
      id: waitingId,
      status: 'SUCCEEDED',
      updated_at: new Date(LATER),
    });
    expect((await h.read(o)).rights_pending).toBe(false);
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'resolved' }),
    ]);
  }

  /**
   * The order and its booked pair after `adjustments` R10s (rebate_status stays CREDITED; one
   * rebate history row SETTLE_NEGATIVE_DIFF each, never an R9 PARTIAL_REFUND / RIGHTS_PARTIAL).
   */
  async function expectBooked(
    o: SeededOrder,
    base: bigint,
    n: bigint,
    adjustments = 1,
  ): Promise<void> {
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: base,
      booked_n_fen: n,
    });
    const row = expect.objectContaining({
      field: 'rebate',
      from_status: 'CREDITED',
      event: 'SETTLE_NEGATIVE_DIFF',
      to_status: 'CREDITED',
    });
    expect(await h.rebateHistoryAfterCredit(o)).toEqual(
      Array.from({ length: adjustments }, () => row),
    );
  }

  /** Alert lines of a settlement record left waiting, for this app. */
  function heldAlerts() {
    return h.logs.filter((line) => line.alert === ALERT_HELD && line.app_id === appId);
  }

  return {
    ...h,
    arrive,
    setState,
    pastVoucher,
    seedDeferred,
    waiting,
    expectAdjusted,
    expectAnswered,
    expectBooked,
    heldAlerts,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
