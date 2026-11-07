// B2-09zb (FU-SETTLE-ADJ-POSITIVE; 08 BR-FUND-09 ②, BR-CALC-02, BR-CALC-09; D10-769, D10-770,
// D10-780): R1's positive-difference candidate run of one app and platform. Skeleton of the rule-test
// round; the contract below is what test/spec/settlement/settle-adjust-generate/** pins.
//
// run({ appId, platform, accountingDate }):
//   - scope: the app's orders of `platform` with rebate_status CREDITED; the current settlement is
//     orders.settle_commission_fen (latest STATEMENT, else latest API) and the current seq the
//     greatest order_settlements seq of the order;
//   - per order, on its own transaction (all of its rows or none): order key lock, users, the
//     beneficiaries' states after the locks, the nets from ledger, the snapshot's reserve_bp and
//     ratios; @couli/domain planCommissionAdjustment({ event: 'settlement', … }); only the
//     `approval` route (positive difference) is written, `immediate` and `none` are left alone;
//   - 决-10 A: while settle.adjust.void_on_clawback.enabled is on (the default; false / 'false' /
//     'off' turn it off) an order is only taken when its current settlement record was written
//     after the order's latest CLAWBACK;
//   - rows: one settle_adjust_batches row per run that writes at least one candidate (never an
//     empty batch; confirmed_* null), one settle_adjustments row per beneficiary with a positive
//     difference (status pending, settle_seq the current seq, commission_version the order's
//     current one; a frozen / appealing beneficiary's row as usual; a banned or deleting / deleted
//     beneficiary's share is in the platform row) and one platform row (user_id, role null) when
//     its difference is not 0; no voucher, no balance, no booked pair, no event;
//   - D10-780: pending rows of the same order and seq at another commission_version become
//     voided_stale_seq (reason superseded_by_version, decided_at the Clock) on the same transaction
//     before the new rows, with one system audit record (action
//     settle_adjust_candidate_superseded: the order, the old and the new version); pending rows of
//     the same version, and approved / rejected rows of the same version, make the order a skip.
// Result: batchId (null when nothing was written), orders (orders that got candidates), candidates
// (rows written), superseded (rows voided by a version change).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  orderKey,
  planCommissionAdjustment,
  transitionSettleAdjustment,
  type AdjustmentBeneficiary,
  type AdjustmentPlan,
  type CreditBeneficiaryState,
} from '@couli/domain';
import { applyReserve, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { OrderNetSelection, OrderNets } from '../../ledger/index.ts';
import type { Clock, RootLogger } from '../../platform/index.ts';
import { lockOrderKey } from '../../orders/index.ts';
import { readOpenObligations, type BeneficiaryCreditRow } from '../clawback/clawback-store.ts';
import { readLatestSettleSeq, readOrderLocator } from '../credit/credit-store.ts';
import type {
  BeneficiaryGate,
  CreditRole,
  CreditSnapshot,
  CreditSnapshotSelection,
} from '../credit/index.ts';
import { readRebateOrder } from '../rebate/infra/rebate-store.ts';
import { isForfeitedShare } from '../reads/pending-earnings-rules.ts';

/** One system audit record (the shape of admin's SystemActionAudit; actor system:settlement). */
export interface SettleAdjustAuditInput {
  readonly appId: string;
  readonly actor: 'system:settlement';
  readonly action: string;
  readonly target: string;
  readonly before: Readonly<Record<string, string | number | boolean | null>>;
  readonly after: Readonly<Record<string, string | number | boolean | null>>;
}

/** admin's system audit writer on the caller's transaction (createSystemAuditWriter, by shape). */
export interface SettleAdjustAudit {
  appendAction(trx: Transaction<DB>, input: SettleAdjustAuditInput): Promise<void>;
}

export interface SettleAdjustGeneratorDependencies {
  /** Each order runs on its own transaction opened here. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly gate: BeneficiaryGate;
  /** commission readCommissionSnapshot (current commission_version). */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** ledger getOrderNets. */
  readOrderNets(trx: Transaction<DB>, input: OrderNetSelection): Promise<OrderNets>;
  /** content's configuration reader (settle.adjust.void_on_clawback.enabled). */
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  readonly audit: SettleAdjustAudit;
}

export interface SettleAdjustRunInput {
  readonly appId: string;
  readonly platform: string;
  /** The +08:00 day D of the run (YYYY-MM-DD). */
  readonly accountingDate: string;
}

export interface SettleAdjustRunResult {
  readonly batchId: string | null;
  readonly orders: number;
  readonly candidates: number;
  readonly superseded: number;
}

export interface SettleAdjustGenerator {
  run(input: SettleAdjustRunInput): Promise<SettleAdjustRunResult>;
}

/** 决-10 A switch (default on): only false / 'false' / 'off' turn it off. */
const VOID_ON_CLAWBACK = 'settle.adjust.void_on_clawback.enabled';
/** D10-780: the reason a pending row is voided when the order's commission_version moved on. */
const SUPERSEDED_REASON = 'superseded_by_version';
const SUPERSEDED_ACTION = 'settle_adjust_candidate_superseded';
const SYSTEM_ACTOR = 'system:settlement';
/** The rebate history events of a clawback out of CREDITED (R8 / R9; clawback-order.ts). */
const CLAWBACK_EVENTS = [
  'PLATFORM_INVALID',
  'INVALID_AFTER_SETTLE',
  'REFUND_AFTER_SETTLE',
  'PUNISH',
  'RIGHTS_FULL',
  'RIGHTS_PARTIAL',
  'COMMISSION_POSITIVE_ZERO',
  'BASE_ZERO',
  'PARTIAL_REFUND',
] as const;
const UNIQUE_VIOLATION = '23505';
/** A user with no identity row any more reads as deleted (clawback-order.ts MISSING_USER). */
const MISSING_USER: CreditBeneficiaryState = Object.freeze({
  risk_state: 'normal',
  deletion_status: 'done',
  is_minor: false,
});

function switchedOff(value: unknown): boolean {
  return value === false || value === 'false' || value === 'off';
}

function identity(userId: string, role: string): string {
  return `${userId}\u0000${role}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

interface CandidateRow {
  readonly userId: string | null;
  readonly role: CreditRole | null;
  readonly diffFen: bigint;
}

type OrderOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'written'; readonly candidates: number; readonly superseded: number };

export function createSettleAdjustGenerator(
  deps: SettleAdjustGeneratorDependencies,
): SettleAdjustGenerator {
  const { db, clock, logger, gate } = deps;

  async function voidOnClawback(appId: string): Promise<boolean> {
    return !switchedOff(await deps.config.get(appId, VOID_ON_CLAWBACK));
  }

  /** The created_at of the order's current settlement record (seq). */
  async function recordWrittenAt(
    trx: Transaction<DB>,
    appId: string,
    orderId: string,
    seq: number,
  ): Promise<Date | null> {
    const row = await trx
      .withSchema('app')
      .selectFrom('order_settlements')
      .select('created_at')
      .where('app_id', '=', appId)
      .where('order_id', '=', orderId)
      .where('seq', '=', seq)
      .executeTakeFirst();
    return row?.created_at ?? null;
  }

  /** The latest clawback out of CREDITED (R8 / R9), from settlement's own rebate history. */
  async function latestClawbackAt(
    trx: Transaction<DB>,
    appId: string,
    orderId: string,
  ): Promise<Date | null> {
    const row = await trx
      .withSchema('app')
      .selectFrom('order_status_history')
      .select((eb) => eb.fn.max('at').as('at'))
      .where('app_id', '=', appId)
      .where('order_id', '=', orderId)
      .where('field', '=', 'rebate')
      .where('from_status', '=', 'CREDITED')
      .where('event', 'in', [...CLAWBACK_EVENTS])
      .executeTakeFirst();
    const at: unknown = row?.at ?? null;
    return at instanceof Date ? at : null;
  }

  function beneficiariesOf(
    snapshot: CreditSnapshot,
    states: ReadonlyMap<string, CreditBeneficiaryState>,
    nets: ReadonlyMap<string, bigint>,
    obligations: ReadonlyMap<string, BeneficiaryCreditRow>,
  ): AdjustmentBeneficiary[] {
    return snapshot.beneficiaries.map((b) => {
      const id = identity(b.userId, b.role);
      const obligation = obligations.get(id) ?? null;
      const current = states.get(b.userId) ?? MISSING_USER;
      let status: AdjustmentBeneficiary['status'] = 'active';
      if (isForfeitedShare(b, snapshot.forfeitedEvents)) status = 'forfeited';
      else if (obligation !== null && obligation.kind !== 'deferred') status = 'held';
      return {
        user_id: b.userId,
        role: b.role,
        ratio_bp: BigInt(b.ratioBp),
        status,
        risk_state: current.risk_state,
        deletion_status: current.deletion_status,
        is_minor: current.is_minor,
        net_fen: nets.get(id) ?? 0n,
        obligation:
          obligation === null
            ? null
            : {
                beneficiary_credit_id: obligation.beneficiary_credit_id,
                kind: obligation.kind as 'first_credit' | 'reassign_credit' | 'deferred',
              },
      };
    });
  }

  /**
   * The rows of the approval route.
   * - The base grew (B_settle > booked_base): the shares are split again. A member's row is the new
   *   share less the net already credited (BR-FUND-08 / 09; the approval credits that whole
   *   difference and closes an open obligation, so a deferred amount is part of it, never taken
   *   off it — money review r1 S0). A frozen or appealing member is written as usual (the state is
   *   judged again at approval, D10-770 ②); a member whose share the plan gives the platform
   *   (banned, deleting / deleted, minor, forfeited) gets no row.
   * - The base did not change (only the commission did, BR-FUND-09: 基数不变只调平台): no member
   *   row at all — the members are neither credited nor charged and their obligations stay as they
   *   are (money review r2 S0).
   * The platform row is the plan's platform difference, either sign.
   */
  function rowsOf(
    input: AdjustmentBeneficiary[],
    plan: AdjustmentPlan,
    baseGrew: boolean,
  ): CandidateRow[] {
    const before = new Map(input.map((b) => [identity(b.user_id, b.role), b]));
    const rows: CandidateRow[] = [];
    for (const r of baseGrew ? plan.beneficiaries : []) {
      const b = before.get(identity(r.user_id, r.role));
      if (b === undefined || b.status === 'forfeited' || r.forfeit_reason !== null) continue;
      const diff = subFen(r.entitlement_fen, b.net_fen);
      if (diff > 0n) rows.push({ userId: r.user_id, role: r.role, diffFen: diff });
    }
    if (plan.platform_delta_fen !== 0n) {
      rows.push({ userId: null, role: null, diffFen: plan.platform_delta_fen });
    }
    return rows;
  }

  async function processOrder(
    input: SettleAdjustRunInput,
    orderId: string,
    batch: { id: string | null },
    clawbackGate: boolean,
  ): Promise<OrderOutcome> {
    const { appId } = input;
    return db.transaction().execute(async (trx): Promise<OrderOutcome> => {
      const locator = await readOrderLocator(trx, appId, orderId);
      if (locator === undefined) return { kind: 'skipped' };
      await lockOrderKey(trx, locator.platform, locator.sub_order_id);
      const order = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
      if (
        order === undefined ||
        order.rebate_status !== 'CREDITED' ||
        order.settle_commission_fen === null ||
        order.booked_base_fen === null ||
        order.booked_n_fen === null
      ) {
        return { kind: 'skipped' };
      }
      const seq = await readLatestSettleSeq(trx, appId, orderId);
      if (seq === null) return { kind: 'skipped' };
      const snapshot = await deps.readSnapshot(trx, {
        appId,
        orderId,
        commissionVersion: order.commission_version,
      });
      if (snapshot === null) return { kind: 'skipped' };
      const reserveBp = BigInt(snapshot.reserveBp);
      const settle = order.settle_commission_fen;
      // Only the positive route (BR-FUND-09 ②): cheap check before any user lock.
      const { after_reserve_fen: baseSettle } = applyReserve(settle, reserveBp);
      const nPositive = settle > 0n ? settle : 0n;
      const baseGrew = baseSettle > order.booked_base_fen;
      const positiveRoute =
        baseGrew || (baseSettle === order.booked_base_fen && nPositive > order.booked_n_fen);
      if (!positiveRoute) return { kind: 'skipped' };

      if (clawbackGate) {
        const recordAt = await recordWrittenAt(trx, appId, orderId, seq);
        const clawedAt = await latestClawbackAt(trx, appId, orderId);
        if (clawedAt !== null && (recordAt === null || recordAt.getTime() <= clawedAt.getTime())) {
          return { kind: 'skipped' };
        }
      }

      const pending = await trx
        .withSchema('app')
        .selectFrom('settle_adjustments')
        .select(['id', 'commission_version', 'row_version'])
        .where('app_id', '=', appId)
        .where('order_id', '=', orderId)
        .where('settle_seq', '=', seq)
        .where('status', '=', 'pending')
        .execute();
      if (pending.some((r) => r.commission_version === order.commission_version)) {
        return { kind: 'skipped' };
      }
      const decided = await trx
        .withSchema('app')
        .selectFrom('settle_adjustments')
        .select('id')
        .where('app_id', '=', appId)
        .where('order_id', '=', orderId)
        .where('settle_seq', '=', seq)
        .where('commission_version', '=', order.commission_version)
        .where('status', 'in', ['approved', 'rejected'])
        .limit(1)
        .executeTakeFirst();
      if (decided !== undefined) return { kind: 'skipped' };

      const key = orderKey(locator.platform, locator.sub_order_id);
      const userIds = [...new Set(snapshot.beneficiaries.map((b) => b.userId))].sort();
      const locked =
        userIds.length === 0 ? new Set<string>() : await gate.lockUsers(trx, { appId, userIds });
      const present = userIds.filter((id) => locked.has(id));
      const states =
        present.length === 0
          ? new Map<string, CreditBeneficiaryState>()
          : await gate.readStates(trx, { appId, userIds: present });
      const stored = await deps.readOrderNets(trx, { appId, orderKey: key });
      const nets = new Map(
        stored.beneficiaries.map((b) => [identity(b.beneficiary_user_id, b.role), b.net_fen]),
      );
      const obligations = new Map(
        (await readOpenObligations(trx, appId, orderId)).map((r) => [
          identity(r.user_id, r.role),
          r,
        ]),
      );
      const beneficiaries = beneficiariesOf(snapshot, states, nets, obligations);
      const plan = planCommissionAdjustment({
        event: 'settlement',
        n_new_fen: settle,
        reserve_bp: reserveBp,
        booked_base_fen: order.booked_base_fen,
        booked_n_fen: order.booked_n_fen,
        platform_net_fen: stored.platform_net_fen,
        beneficiaries,
      });
      if (plan.route !== 'approval') return { kind: 'skipped' };
      const rows = rowsOf(beneficiaries, plan, baseGrew);
      if (rows.length === 0) return { kind: 'skipped' };

      const now = clock.now();
      // D10-780: an older commission_version's pending rows of the same seq give way.
      let superseded = 0;
      if (pending.length > 0) {
        const step = transitionSettleAdjustment('pending', 'VOID_STALE_SEQ');
        if (!step.ok || step.to !== 'voided_stale_seq') {
          throw new Error('settlement adjust: illegal candidate transition');
        }
        for (const r of pending) {
          const res = await trx
            .withSchema('app')
            .updateTable('settle_adjustments')
            .set({
              status: step.to,
              reason: SUPERSEDED_REASON,
              decided_at: now,
              row_version: r.row_version + 1,
            })
            .where('app_id', '=', appId)
            .where('id', '=', r.id)
            .where('status', '=', 'pending')
            .where('row_version', '=', r.row_version)
            .executeTakeFirst();
          if (res.numUpdatedRows !== 1n) throw new Error('settlement adjust: supersede CAS failed');
          superseded += 1;
        }
        const versions = [...new Set(pending.map((r) => r.commission_version))].sort(
          (x, y) => x - y,
        );
        await deps.audit.appendAction(trx, {
          appId,
          actor: SYSTEM_ACTOR,
          action: SUPERSEDED_ACTION,
          target: `orders:${orderId}`,
          before: { order_id: orderId, settle_seq: seq, commission_version: versions.join(',') },
          after: {
            order_id: orderId,
            settle_seq: seq,
            commission_version: order.commission_version,
            superseded,
          },
        });
      }

      if (batch.id === null) {
        const batchId = randomUUID();
        await trx
          .withSchema('app')
          .insertInto('settle_adjust_batches')
          .values({ batch_id: batchId, app_id: appId, created_at: now })
          .execute();
        batch.id = batchId;
      }
      const batchId = batch.id;
      await trx
        .withSchema('app')
        .insertInto('settle_adjustments')
        .values(
          rows.map((r) => ({
            id: randomUUID(),
            app_id: appId,
            batch_id: batchId,
            order_id: orderId,
            user_id: r.userId,
            role: r.role,
            commission_version: order.commission_version,
            settle_seq: seq,
            diff_fen: r.diffFen,
            status: 'pending',
            created_at: now,
          })),
        )
        .execute();
      return { kind: 'written', candidates: rows.length, superseded };
    });
  }

  return {
    async run(input) {
      const { appId, platform } = input;
      const orderIds = (
        await db
          .withSchema('app')
          .selectFrom('orders')
          .select('order_id')
          .where('app_id', '=', appId)
          .where('platform', '=', platform)
          .where('rebate_status', '=', 'CREDITED')
          .where('settle_commission_fen', 'is not', null)
          .orderBy('order_id')
          .execute()
      ).map((r) => r.order_id);
      const clawbackGate = await voidOnClawback(appId);
      const batch: { id: string | null } = { id: null };
      let orders = 0;
      let candidates = 0;
      let superseded = 0;
      let failed = 0;
      for (const orderId of orderIds) {
        // A batch created by a transaction that rolled back never existed.
        const batchBefore = batch.id;
        try {
          const outcome = await processOrder(input, orderId, batch, clawbackGate);
          if (outcome.kind === 'written') {
            orders += 1;
            candidates += outcome.candidates;
            superseded += outcome.superseded;
          }
        } catch (error: unknown) {
          batch.id = batchBefore;
          if (isUniqueViolation(error)) {
            logger.info(
              { app_id: appId, order_id: orderId },
              'settle adjust: candidates already written by another run',
            );
            continue;
          }
          failed += 1;
          logger.error(
            { app_id: appId, order_id: orderId, err: error },
            'settle adjust: order failed, its candidates were not written',
          );
        }
      }
      if (orders > 0) {
        logger.info(
          { app_id: appId, platform, batch_id: batch.id, orders, candidates, superseded },
          'settle adjust: candidates generated',
        );
      }
      // Money review r1 S2: the other orders are done (each committed on its own); a run with a
      // failed order fails as a whole, so the job is recorded failed and delivered again — the
      // orders already written are skipped then (same version, pending).
      if (failed > 0) {
        throw new Error(`settle adjust: ${failed} order(s) failed, the run is to be retried`);
      }
      return { batchId: batch.id, orders, candidates, superseded };
    },
  };
}
