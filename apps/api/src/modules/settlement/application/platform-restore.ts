// B2-09gb: the platform_restore branch of POST /admin/v1/recon-diffs/{recon_diff_id}/restore
// (contracts/openapi.yaml restoreAdminReconDiff, CT-24zz; 08 BR-FUND-22 R12 / R13, BR-FUND-01 R13
// row, BR-CALC-02, BR-CALC-09; 编排 D10-973, D10-982, D10-986, D10-994). admin-recon-restore.ts
// dispatches here on the claim's transaction after the body, the app's difference and its status
// were checked. In the contract's order:
//   ref_id not `{order_key}#RESTORE#{entry_id}` (ref_type order), or no order of the app under that
//   key → 20001 [recon_diff_id] restore_not_supported (read without a lock);
//   the order key's advisory lock, the difference's row (status judged again → 20902 recon_diff);
//   the order re-read under the lock: rebate_status not VOID / CLAWED_BACK, or the rebate-history
//   row by which it entered that status is not entry_id → 20902 order;
//   platform_status INVALID → 20001 restore_platform_invalid; R13 with an effective union
//   commission whose positive part is 0 → 20001 restore_commission_zero. Nothing is written before.
// R12 (VOID): back to ESTIMATED / WAITING / UNATTRIBUTED (platform-restore-plan r12TargetOf);
//   WAITING takes settle_period from received_at in China time when none is set (BR-FUND-04 ②, as R4
//   does; a period whose batch already ran is the batches' supplementary / next-period rule) and
//   received_synced_at from the Clock when none is set. No ledger entry.
// R13 (CLAWED_BACK → CREDITED): users rows (gate.lockUsers, ascending) → gate.readStates →
//   ledger.lockBalances of the members paid; nets from ledger getOrderNets; planR13. Per beneficiary:
//   credited → ADMIN_ADJUST:RESTORE:USER `{order_key}:{user_id}:{role}:RESTORE:{recon_diff_id}`;
//   deferred (frozen / under appeal) → a deferred obligation (opened_by R13, origin ADMIN_ADJUST /
//   RESTORE, BR-FUND-04 ⑫); to the platform (banned, deleting / deleted, a minor's promotion share)
//   → a forfeited share event when part of a live share went there (BR-CALC-13); a negative
//   difference posts nothing, logs a warning and is recorded (D10-986 ②). The platform's positive
//   difference → ADMIN_ADJUST:RESTORE:PLATFORM `{order_key}:PLATFORM:RESTORE:{recon_diff_id}`; a
//   negative one posts nothing, logs a warning and is recorded (08 BR-FUND-22 细则, D10-994). One CAS:
//   CREDITED, booked_base_fen = B, booked_n_fen = N⁺, refunded_quantity_r9_baseline =
//   refunded_quantity (casClawbackOrder; refunded_quantity_at_credit untouched).
// Both: rebate_status only through the generated transitionOrderRebate (R12 / R13, ADMIN_RESTORE),
// row_version + 1 and one history row (source admin); the difference to adjusted through ledger's
// command with resolution.restore; the audit record recon_diff_restore. Any failure rolls back.
import { randomUUID } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import {
  buildVouchers,
  chinaMonth,
  transitionOrderRebate,
  type BuiltVoucher,
  type OrderRebateEvent,
} from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import type { Transaction } from 'kysely';
import {
  adjustRestoredReconDiff,
  getOrderNets,
  lockReconDiffForRestore,
  type Ledger,
  type PostingEntry,
  type PostingVoucher,
  type ReconDiffRestoreRow,
} from '../../ledger/index.ts';
import { lockOrderKey } from '../../orders/index.ts';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type RootLogger,
} from '../../platform/index.ts';
import {
  casClawbackOrder,
  insertDeferredObligation,
  readOpenObligations,
} from '../clawback/clawback-store.ts';
import type { BeneficiaryGate } from '../credit/beneficiary-gate.ts';
import { hasSucceededInvalidSince } from '../rights/rights-store.ts';
import { isForfeitedShare } from '../reads/pending-earnings-rules.ts';
import {
  casUpdateRebate,
  readRebateOrder,
  type OrderRow,
  type RebateSet,
} from '../rebate/infra/rebate-store.ts';
import {
  findOrderOfKey,
  insertAdminRebateHistory,
  readRebateEntryId,
} from '../infra/platform-restore-store.ts';
import {
  effectiveCommissionPositive,
  parsePlatformRestoreRef,
  planR13,
  r12TargetOf,
  type PlatformRestoreRef,
  type PlatformRestoreRole,
  type R12Target,
  type R13Plan,
  type R13Row,
} from './platform-restore-plan.ts';

/** The data.reason of a 20001 [recon_diff_id] of a platform restore. */
export type PlatformRestoreRefusal =
  'restore_not_supported' | 'restore_platform_invalid' | 'restore_commission_zero';

/** commission's readCommissionAttribution (structural): ratios, reserve and share states. */
export interface PlatformRestoreSnapshot {
  readonly reserveBp: number;
  readonly beneficiaries: readonly {
    readonly userId: string;
    readonly role: PlatformRestoreRole;
    readonly ratioBp: number;
    readonly initialStatus: 'active' | 'forfeited';
    readonly forfeitLifted?: true;
  }[];
  readonly forfeitedEvents: readonly {
    readonly userId: string;
    readonly role: PlatformRestoreRole;
  }[];
}

export interface PlatformRestoreDeps {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'warn'>;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly gate: BeneficiaryGate;
  readonly readRestoreSnapshot: (
    trx: Transaction<DB>,
    selection: { readonly appId: string; readonly orderId: string },
  ) => Promise<PlatformRestoreSnapshot>;
  readonly appendBeneficiaryEvent: (
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly orderId: string;
      readonly userId: string;
      readonly role: PlatformRestoreRole;
      readonly status: 'forfeited';
      readonly reason: 'banned' | 'deleted' | 'minor';
    },
    dependencies: { readonly clock: Clock },
  ) => Promise<void>;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
}

export interface PlatformRestoreInput {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly traceId: string;
  /** The trimmed note, when given. */
  readonly note: string | undefined;
  /** The difference as first read (not locked). */
  readonly seen: ReconDiffRestoreRow;
  /** The audit action of the contract. */
  readonly auditAction: string;
}

const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
const EVENT: OrderRebateEvent = 'ADMIN_RESTORE';
const VOUCHER_KIND = 'ADMIN_ADJUST';
const BIZ_TYPE = 'ADMIN_RESTORE';
const USER_TEMPLATE = 'ADMIN_ADJUST:RESTORE:USER';
const PLATFORM_TEMPLATE = 'ADMIN_ADJUST:RESTORE:PLATFORM';
const ALERT_NEGATIVE = 'platform_restore_negative_difference';

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

function guardRefusal(reason: PlatformRestoreRefusal, traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(['recon_diff_id'], traceId);
  const body = refused.body as { data?: Record<string, unknown> };
  return {
    status: refused.statusCode,
    envelope: { ...refused.body, data: { ...(body.data ?? {}), reason } },
  };
}

function conflictRefusal(resource: 'recon_diff' | 'order', traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: { code: 20902, msg: CONFLICT_MESSAGE, data: { resource }, trace_id: traceId },
  };
}

function isOpen(row: ReconDiffRestoreRow): boolean {
  return row.status === 'open' || row.status === 'processing';
}

function storedResolution(row: ReconDiffRestoreRow): Record<string, unknown> {
  const value = row.resolution;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identity(userId: string, role: string): string {
  return `${userId}|${role}`;
}

/** The transition of the generated machine, or a throw (never guessed). */
function stepOf(from: 'VOID' | 'CLAWED_BACK', id: 'R12' | 'R13') {
  const step = transitionOrderRebate(from, EVENT);
  if (!step.ok || step.noop || step.id !== id) {
    throw new Error(`settlement platform restore: ${from} has no ${id} transition`);
  }
}

interface Located {
  readonly ref: PlatformRestoreRef;
  readonly order: OrderRow;
  readonly row: ReconDiffRestoreRow;
}

interface Outcome {
  readonly to: R12Target | 'CREDITED';
  readonly restoredFen: bigint;
  /** Added under resolution.restore and the audit's after (amounts as decimal strings). */
  readonly detail: Record<string, unknown>;
}

/** Handles one platform_restore difference of the operator's app (BR-FUND-22 R12 / R13). */
export async function restorePlatformDiff(
  deps: PlatformRestoreDeps,
  trx: Transaction<DB>,
  input: PlatformRestoreInput,
): Promise<HandlerResult> {
  const { appId, traceId } = input;
  const ref = parsePlatformRestoreRef(input.seen.ref_type, input.seen.ref_id);
  if (ref === null) return guardRefusal('restore_not_supported', traceId);
  const locator = await findOrderOfKey(trx, appId, ref.platform, ref.subOrderId);
  if (locator === undefined) return guardRefusal('restore_not_supported', traceId);

  await lockOrderKey(trx, ref.platform, ref.subOrderId);
  const row = await lockReconDiffForRestore(trx, appId, input.seen.id);
  if (row === undefined) return fieldsRefusal(['recon_diff_id'], traceId);
  if (!isOpen(row)) return conflictRefusal('recon_diff', traceId);

  const order = await readRebateOrder(trx, {
    appId,
    orderId: locator.order_id,
    attrAt: locator.attr_at,
  });
  if (order === undefined) throw new Error('settlement platform restore: order not found for app');
  const from = order.rebate_status;
  if (from !== 'VOID' && from !== 'CLAWED_BACK') return conflictRefusal('order', traceId);
  const entryId = await readRebateEntryId(trx, appId, order.order_id, from);
  if (entryId !== ref.entryId) return conflictRefusal('order', traceId);
  if (order.platform_status === 'INVALID') {
    return guardRefusal('restore_platform_invalid', traceId);
  }
  // B2-04zzr (BR-FUND-22 处理时再核): a successful INVALID_AFTER_SETTLE record at or after the
  // difference's registration means the platform invalidated the order again (R12 and R13 alike).
  if (await hasSucceededInvalidSince(trx, appId, order.order_id, row.created_at)) {
    return guardRefusal('restore_platform_invalid', traceId);
  }

  const located: Located = { ref, order, row };
  let outcome: Outcome;
  if (from === 'VOID') {
    outcome = await restoreVoid(deps, trx, located);
  } else {
    const n = effectiveCommissionPositive(order.settle_commission_fen, order.est_commission_fen);
    if (n === 0n) return guardRefusal('restore_commission_zero', traceId);
    outcome = await restoreClawedBack(deps, trx, located, input, n);
  }

  const now = deps.clock.now();
  await insertAdminRebateHistory(trx, order, { from, event: EVENT, to: outcome.to }, now);
  const restore = {
    rebate_status_before: from,
    rebate_status_after: outcome.to,
    ...outcome.detail,
    restored_fen: outcome.restoredFen.toString(),
    operator: input.adminId,
    restored_at: now.toISOString(),
  };
  const written = await adjustRestoredReconDiff(trx, {
    appId,
    id: row.id,
    handlerId: input.adminId,
    at: now,
    resolution: {
      ...storedResolution(row),
      restore,
      ...(input.note === undefined ? {} : { note: input.note }),
    },
  });
  // The row is locked above, so the compare-and-set cannot miss: nothing may commit without it.
  if (written === undefined)
    throw new Error('settlement platform restore: the difference left open');
  await deps.auditOn(trx).append({
    appId,
    actor: input.adminId,
    action: input.auditAction,
    target: row.id,
    before: { status: row.status, order_key: ref.orderKey, rebate_status: from },
    after: {
      status: written.status,
      order_key: ref.orderKey,
      rebate_status: outcome.to,
      ...outcome.detail,
      restored_fen: outcome.restoredFen.toString(),
    },
    ip: input.ip,
  });
  const data: Schema<'AdminReconDiffRestore'> = {
    recon_diff: written,
    restored_fen: fenToJsonNumber(outcome.restoredFen),
    rebate_status_after: outcome.to,
  };
  return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
}

/** R12: the rebate status by platform_status / user_id; no ledger entry. */
async function restoreVoid(
  deps: PlatformRestoreDeps,
  trx: Transaction<DB>,
  located: Located,
): Promise<Outcome> {
  const { order } = located;
  stepOf('VOID', 'R12');
  const to = r12TargetOf(order);
  const now = deps.clock.now();
  const waiting = to === 'WAITING' ? order.received_at : null;
  // BR-FUND-04 ②, as R4: settle_period is never recalculated once written; received_synced_at
  // from the Clock, an existing value kept.
  const set: RebateSet = {
    rebate_status: to,
    ...(waiting !== null && order.settle_period === null
      ? { settle_period: chinaMonth(waiting) }
      : {}),
    ...(waiting !== null && order.received_synced_at === null ? { received_synced_at: now } : {}),
  };
  const ok = await casUpdateRebate(trx, order, set, {}, now);
  if (!ok) throw new Error('settlement platform restore: R12 CAS matched no row');
  return { to, restoredFen: 0n, detail: { beneficiaries: [], platform_fen: '0' } };
}

function userPosting(
  appId: string,
  key: string,
  adminId: string,
  reconDiffId: string,
  beneficiary: { readonly userId: string; readonly role: PlatformRestoreRole } | null,
  accountId: string | null,
  built: BuiltVoucher,
): PostingVoucher {
  const entries: PostingEntry[] = built.entries.map((entry) => {
    if (entry.account.owner_type === 'user') {
      if (accountId === null) throw new Error('settlement platform restore: no locked balance');
      return {
        account: { ownerType: 'user', accountId },
        sub_account: entry.sub_account ?? 'available',
        amount_fen: entry.amount_fen,
        ledger_type: entry.ledger_type,
        sub_type: entry.sub_type,
        income_type: null,
      };
    }
    return {
      account: { ownerType: 'platform', subject: entry.account.subject },
      sub_account: entry.sub_account ?? 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    };
  });
  return {
    appId,
    uniqKey: built.uniq_key,
    bizType: BIZ_TYPE,
    bizId: reconDiffId,
    operator: `admin:${adminId}`,
    memo: null,
    orderKey: key,
    beneficiaryUserId: beneficiary?.userId ?? null,
    role: beneficiary?.role ?? null,
    voucherKind: VOUCHER_KIND,
    entries,
  };
}

/** One row of resolution.restore.beneficiaries (and of the audit). */
function recordOf(row: R13Row): Record<string, string> {
  return {
    user_id: row.userId,
    role: row.role,
    restored_fen: row.amountFen.toString(),
    outcome: row.outcome,
    ...(row.differenceFen < 0n ? { negative_fen: row.differenceFen.toString() } : {}),
  };
}

function detailOf(plan: R13Plan): Record<string, unknown> {
  return {
    beneficiaries: plan.rows.map(recordOf),
    platform_fen: plan.platformPostFen.toString(),
    ...(plan.platformDifferenceFen < 0n
      ? { platform_negative_fen: plan.platformDifferenceFen.toString() }
      : {}),
    booked_base_fen: plan.baseFen.toString(),
    booked_n_fen: plan.nFen.toString(),
  };
}

/** R13: recalculation on the effective commission, the vouchers, obligations and the booked pair. */
async function restoreClawedBack(
  deps: PlatformRestoreDeps,
  trx: Transaction<DB>,
  located: Located,
  input: PlatformRestoreInput,
  n: bigint,
): Promise<Outcome> {
  const { order, ref, row } = located;
  const { appId, adminId } = input;
  stepOf('CLAWED_BACK', 'R13');
  const snapshot = await deps.readRestoreSnapshot(trx, { appId, orderId: order.order_id });
  const userIds = [...new Set(snapshot.beneficiaries.map((b) => b.userId))].sort();
  const locked = await deps.gate.lockUsers(trx, { appId, userIds });
  const states = await deps.gate.readStates(trx, { appId, userIds });
  for (const id of userIds) {
    if (!locked.has(id) || !states.has(id)) {
      throw new Error('settlement platform restore: a beneficiary is not in the app');
    }
  }
  const nets = await getOrderNets(trx, { appId, orderKey: ref.orderKey });
  const netOf = new Map(
    nets.beneficiaries.map((b) => [identity(b.beneficiary_user_id, b.role), b.net_fen]),
  );
  const plan = planR13({
    nFen: n,
    reserveBp: snapshot.reserveBp,
    platformNetFen: nets.platform_net_fen,
    beneficiaries: snapshot.beneficiaries.map((b) => {
      const state = states.get(b.userId);
      if (state === undefined) throw new Error('settlement platform restore: state missing');
      return {
        userId: b.userId,
        role: b.role,
        ratioBp: b.ratioBp,
        // D10-481 ②: the one judgement of a forfeited share.
        forfeited: isForfeitedShare(b, snapshot.forfeitedEvents),
        state,
        netFen: netOf.get(identity(b.userId, b.role)) ?? 0n,
      };
    }),
  });

  // Step 3 of the lock flow: the balances of the members paid, after their users rows.
  const payees = [
    ...new Set(plan.rows.filter((r) => r.outcome === 'credited').map((r) => r.userId)),
  ].sort();
  for (const userId of payees) await deps.ledger.openUserAccount(trx, { appId, userId });
  const balances =
    payees.length === 0 ? [] : await deps.ledger.lockBalances(trx, { appId, userIds: payees });
  const accounts = new Map(balances.map((b) => [b.user_id, b.account_id]));
  const open = await readOpenObligations(trx, appId, order.order_id);
  const now = deps.clock.now();
  const log = {
    alert: ALERT_NEGATIVE,
    app_id: appId,
    order_key: ref.orderKey,
    recon_diff_id: row.id,
  };

  for (const r of plan.rows) {
    if (r.differenceFen < 0n) {
      deps.logger.warn(
        { ...log, role: r.role, difference_fen: r.differenceFen.toString() },
        'platform restore: negative beneficiary difference left unposted',
      );
    }
    if (r.forfeitReason !== null) {
      await deps.appendBeneficiaryEvent(
        trx,
        {
          appId,
          orderId: order.order_id,
          userId: r.userId,
          role: r.role,
          status: 'forfeited',
          reason: r.forfeitReason,
        },
        { clock: deps.clock },
      );
    }
    if (r.outcome === 'credited') {
      const accountId = accounts.get(r.userId);
      if (accountId === undefined)
        throw new Error('settlement platform restore: no locked balance');
      const built = buildVouchers(USER_TEMPLATE, {
        order_key: ref.orderKey,
        platform: ref.platform,
        user_id: r.userId,
        role: r.role,
        '差错单 id': row.id,
        restore_fen: r.amountFen,
      });
      for (const voucher of built) {
        await deps.ledger.post(
          trx,
          userPosting(appId, ref.orderKey, adminId, row.id, r, accountId, voucher),
        );
      }
    } else if (r.outcome === 'deferred') {
      if (open.some((o) => o.user_id === r.userId && o.role === r.role)) {
        // R8 voided every open obligation; one still open means the order is not as R13 expects.
        throw new Error('settlement platform restore: an obligation is still open');
      }
      await insertDeferredObligation(trx, {
        beneficiary_credit_id: randomUUID(),
        app_id: appId,
        order_id: order.order_id,
        user_id: r.userId,
        role: r.role,
        opened_ref: `RESTORE:${row.id}`,
        split_ref: `commission_version:${String(order.commission_version)}`,
        opened_at: now,
        opened_by: 'R13',
        origin: { ledger_type: 'ADMIN_ADJUST', sub_type: 'RESTORE' },
      });
    }
  }
  if (plan.platformPostFen > 0n) {
    const built = buildVouchers(PLATFORM_TEMPLATE, {
      order_key: ref.orderKey,
      platform: ref.platform,
      '差错单 id': row.id,
      restore_fen: plan.platformPostFen,
    });
    for (const voucher of built) {
      await deps.ledger.post(
        trx,
        userPosting(appId, ref.orderKey, adminId, row.id, null, null, voucher),
      );
    }
  } else if (plan.platformDifferenceFen < 0n) {
    deps.logger.warn(
      { ...log, role: 'platform', difference_fen: plan.platformDifferenceFen.toString() },
      'platform restore: negative platform difference left unposted',
    );
  }

  const ok = await casClawbackOrder(trx, order, {
    to: 'CREDITED',
    booked_base_fen: plan.baseFen,
    booked_n_fen: plan.nFen,
    at: now,
  });
  if (!ok) throw new Error('settlement platform restore: R13 CAS matched no row');
  return { to: 'CREDITED', restoredFen: plan.restoredFen, detail: detailOf(plan) };
}
