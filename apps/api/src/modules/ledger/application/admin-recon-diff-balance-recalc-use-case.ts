// B2-02x: POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc (contracts/openapi.yaml
// recalcBalanceAdminReconDiff, CT-24zzn + CT-24zzna; 08 BR-FUND-19 细则「差异以分录为准修正」,
// BR-FUND-16 细则「加锁流程」, BR-FUND-12 negative_since, BR-WDR-05 (a) 跨零; D10-2017 ①,
// D10-2032, D10-2033, D10-2041, D10-2064 ③, D10-2084, D10-2092 ⑤, D10-2097). The controller
// (http/admin/) only authorises through the AdminOperationGuard (fund.recon, operation
// fund.recon.balance_recalc: sms-tier step-up), takes the parameters and calls
// recalcBalanceAdminReconDiff. No Idempotency-Key (04 §6.6).
//
// recalcBalanceAdminReconDiff, in order:
//   the reason, trimmed, 1–200 characters, else 20001 [reason];
//   recon_diff_id not a uuid → 20001 [recon_diff_id];
//   one transaction:
//     the app's R1–R3 recon_diffs row FOR UPDATE (unknown / another app / R4 → 20001
//     [recon_diff_id]); anything but an open / processing ledger_mismatch of source R3 registered
//     on a ledger_account `{invariant}:{account_id}` → 20001 [recon_diff_id]; the account must be a
//     USER_BALANCE account of the app whose owner is a users row of the app;
//     BR-FUND-16 steps 2 and 3: the member's users row (identity's lock port), then the member's
//     account_balances row FOR UPDATE (no order, so no order_key advisory lock); no balance row →
//     20001 [recon_diff_id]. Nothing is written by any of these refusals;
//     the member-sign entry sums read under the locks; decideBalanceRecalc decides:
//       refused (frozen sum < 0, a sum or a cached value outside ±(2^53 − 1)) → the audit record
//       (cause, sums and cache) is committed, the balance row untouched, 20001 [recon_diff_id];
//       unchanged → no balance write, the audit record (changed=false);
//       write → the compare-and-set on version (as every posting; available_fen and frozen_fen
//       both set to the sums, up or down), then 跨零 as the posting path does it:
//       account.went_negative through the entry's event bus when available goes from ≥ 0 to < 0,
//       payout's balance-recovered hook (source recalc:<recon_diff_id>:<version>, D10-2084) when
//       it goes from < 0 to ≥ 0; then, when available_fen changed, notification's BALANCE_CORRECTED
//       inbox message (D10-2092 ⑤; none for a deleting / deleted member, D10-2097; inserts only);
//       then the audit record (changed=true).
// No voucher and no entry is written; no wallet push (D10-2033); the difference is not closed and
// no withdraw_holds row is released (D10-2017). Any failure rolls the whole transaction back
// (thrown, 50001 through the global error handling), so nothing is published or lifted either.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type EventBus,
  type HandlerResult,
} from '../../platform/index.ts';
import { userBalanceAccountOwner, memberEntrySums } from '../infra/balance-recalc-store.ts';
import { lockAdminReconDiff } from '../infra/recon-diffs-store.ts';
import { lockBalancesByUser, updateBalance } from '../infra/store.ts';
import {
  balanceRecalcSourceRef,
  decideBalanceRecalc,
  recalcBalanceAuditRecord,
  type BalanceRecalcCache,
  type BalanceRecalcDecision,
} from './admin-recon-diff-balance-recalc.ts';
import { UUID } from './admin-recon-diffs.ts';
import type { BalanceRecoveredPort } from './ledger.ts';

/** identity's users row lock on the caller's transaction (ascending id); the ids locked. */
export type BalanceRecalcLockUsers = (
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly userIds: readonly string[] },
) => Promise<ReadonlySet<string>>;

/** What the member notice of a recalculation is given (notification's BALANCE_CORRECTED input). */
export interface BalanceCorrectedNotice {
  readonly appId: string;
  readonly userId: string;
  readonly reconDiffId: string;
  /** The balance row's version after the recalculation wrote it. */
  readonly balanceVersion: number;
  /** available_fen as read under the lock and as written. */
  readonly facts: { readonly before_fen: bigint; readonly after_fen: bigint };
  /** The recalculation's Clock reading. */
  readonly now: Date;
}

/**
 * notification's recordBalanceCorrectedMessage on the recalculation's transaction (D10-2092 ⑤,
 * D10-2097): one inbox message and its notify log, none for a deleting / deleted member; true when
 * written.
 */
export type BalanceCorrectedPort = (
  trx: Transaction<DB>,
  input: BalanceCorrectedNotice,
) => Promise<boolean>;

export interface BalanceRecalcDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** admin's audit writer bound to the recalculation's transaction (single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** BR-FUND-16 step 2 through identity's port (the users row of the member). */
  readonly lockUsers: BalanceRecalcLockUsers;
  /** The entry's platform event bus: account.went_negative as a posting publishes it. */
  readonly eventBus: EventBus;
  /** payout's recovery port, the one the entry's postings call (BR-WDR-05 (a)). */
  readonly balanceRecovered: BalanceRecoveredPort;
  /** notification's BALANCE_CORRECTED inbox message (D10-2092 ⑤). */
  readonly balanceCorrected: BalanceCorrectedPort;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface BalanceRecalcOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface BalanceRecalcRequest {
  readonly body: Schema<'AdminReconDiffBalanceRecalcRequest'>;
  readonly traceId: string;
}

/** The audit action of the contract (success and refusal alike). */
export const RECON_DIFF_BALANCE_RECALC_AUDIT_ACTION = 'recon_diff_balance_recalc';

/** The ledger's platform event when available crosses below zero (as application/ledger.ts). */
const WENT_NEGATIVE_EVENT = 'account.went_negative';

/** Contract AdminReconDiffBalanceRecalcRequest.reason: 1–200 characters after trimming. */
const REASON_MAX = 200;

/** The only difference this operation applies to (BR-FUND-19 ①, registered by R3). */
const MISMATCH_TYPE = 'ledger_mismatch';
const MISMATCH_SOURCE = 'R3';
const OPEN_STATUSES: readonly string[] = ['open', 'processing'];
const ACCOUNT_REF_TYPE = 'ledger_account';

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

/** What the recalculation reads of the difference row. */
export interface BalanceRecalcDiffRow {
  readonly type: string;
  readonly source: string;
  readonly status: string;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
}

/**
 * The member account a difference names: an open / processing ledger_mismatch of R3 whose
 * ref_type is ledger_account and whose ref_id is exactly `{invariant}:{account_id}` (one colon,
 * a uuid after it); the account id in lower case, or undefined for any other difference.
 */
export function recalcAccountOf(row: BalanceRecalcDiffRow): string | undefined {
  if (row.type !== MISMATCH_TYPE || row.source !== MISMATCH_SOURCE) return undefined;
  if (!OPEN_STATUSES.includes(row.status)) return undefined;
  if (row.ref_type !== ACCOUNT_REF_TYPE || row.ref_id === null) return undefined;
  const parts = row.ref_id.split(':');
  if (parts.length !== 2) return undefined;
  const [invariant, accountId] = parts as [string, string];
  if (invariant === '' || !UUID.test(accountId)) return undefined;
  return accountId.toLowerCase();
}

/**
 * The cache and the sums as the response's JSON integers. decideBalanceRecalc has refused every
 * value beyond ±(2^53 − 1), so fenToJsonNumber does not throw here; were it to, nothing is written.
 */
function responseData(
  userId: string,
  cache: BalanceRecalcCache,
  plan: Exclude<BalanceRecalcDecision, { kind: 'refused' }>,
  at: Date,
): Schema<'AdminReconDiffBalanceRecalc'> {
  const written = plan.kind === 'write';
  return {
    user_id: userId,
    before: {
      available_fen: fenToJsonNumber(cache.available_fen),
      frozen_fen: fenToJsonNumber(cache.frozen_fen),
    },
    after: {
      available_fen: fenToJsonNumber(written ? plan.available_fen : cache.available_fen),
      frozen_fen: fenToJsonNumber(written ? plan.frozen_fen : cache.frozen_fen),
    },
    changed: written,
    recalculated_at: at.toISOString(),
  };
}

/** A balance row version as the notice's number (exact; beyond 2^53 − 1 fails, nothing written). */
function versionNumber(version: bigint): number {
  if (version < 0n || version > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ledger: balance version ${version.toString()} is not a safe integer`);
  }
  return Number(version);
}

/** Recalculates the cache of the member a ledger_mismatch difference names; the answer to send. */
export async function recalcBalanceAdminReconDiff(
  deps: BalanceRecalcDeps,
  operator: BalanceRecalcOperator,
  reconDiffId: string,
  request: BalanceRecalcRequest,
): Promise<HandlerResult> {
  const { appId, adminId } = operator;
  const { traceId } = request;
  const reason = request.body.reason.trim();
  const length = [...reason].length;
  if (length < 1 || length > REASON_MAX) return fieldsRefusal(['reason'], traceId);
  if (!UUID.test(reconDiffId)) return fieldsRefusal(['recon_diff_id'], traceId);
  const id = reconDiffId.toLowerCase();
  const notApplicable = (): HandlerResult => fieldsRefusal(['recon_diff_id'], traceId);

  return deps.db.transaction().execute(async (trx): Promise<HandlerResult> => {
    // One Clock read per call: the response time and the accounting day of negative_since.
    const at = deps.clock.now();
    const diff = await lockAdminReconDiff(trx, appId, id);
    if (diff === undefined) return notApplicable();
    const accountId = recalcAccountOf(diff);
    if (accountId === undefined) return notApplicable();
    const userId = await userBalanceAccountOwner(trx, appId, accountId);
    if (userId === undefined) return notApplicable();
    // BR-FUND-16 加锁流程 ② then ③: the users row, then the account_balances row.
    const locked = await deps.lockUsers(trx, { appId, userIds: [userId] });
    if (!locked.has(userId)) return notApplicable();
    const rows = await lockBalancesByUser(trx, appId, [userId]);
    const cache = rows.find((row) => row.account_id === accountId);
    if (cache === undefined) return notApplicable();

    // Read after both locks: a posting committed while this call waited is in both.
    const sums = await memberEntrySums(trx, appId, accountId);
    const plan = decideBalanceRecalc({ cache, sums, accountingDay: accountingDate(at) });
    const record = recalcBalanceAuditRecord({
      reconDiffId: id,
      userId,
      reason,
      cache,
      sums,
      decision: plan,
    });
    const audit = (): Promise<void> =>
      deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: RECON_DIFF_BALANCE_RECALC_AUDIT_ACTION,
        target: record.target,
        before: record.before,
        after: record.after,
        ip: operator.ip,
      });

    if (plan.kind === 'refused') {
      // D10-2032 ②, D10-2064 ③: the refusal is recorded and committed; the balance row is not
      // written, nothing crosses 0 and no notice is sent.
      await audit();
      return notApplicable();
    }
    // Before any write (a defence; decideBalanceRecalc refused such values already): a value the
    // response cannot carry fails (50001) and writes nothing.
    const data = responseData(userId, cache, plan, at);
    if (plan.kind === 'write') {
      const written = await updateBalance(trx, appId, {
        account_id: accountId,
        expected_version: cache.version,
        available_fen: plan.available_fen,
        frozen_fen: plan.frozen_fen,
        version: plan.version,
        negative_since: plan.negative_since,
      });
      // The row is locked above, so the compare-and-set cannot miss; fail rather than go on.
      if (!written) throw new Error(`ledger: balance row ${accountId} changed under its lock`);
      // 跨零 as the posting path (application/ledger.ts): event, then the recovery port.
      if (plan.wentNegative) {
        await deps.eventBus.publish(trx, {
          appId,
          name: WENT_NEGATIVE_EVENT,
          payload: { user_id: userId },
        });
      }
      if (plan.recovered) {
        await deps.balanceRecovered.onRecovered(trx, {
          appId,
          userId,
          accountId,
          availableBefore: cache.available_fen,
          availableAfter: plan.available_fen,
          // No voucher is written: the source of this recalculation stands in for it (D10-2084).
          voucherId: balanceRecalcSourceRef({ reconDiffId: id, version: plan.version }),
        });
      }
      // D10-2092 ⑤: the member is told when the available balance changed (up or down); a change
      // of frozen_fen only is not. notification skips a deleting / deleted member (D10-2097).
      if (plan.available_fen !== cache.available_fen) {
        await deps.balanceCorrected(trx, {
          appId,
          userId,
          reconDiffId: id,
          balanceVersion: versionNumber(plan.version),
          facts: { before_fen: cache.available_fen, after_fen: plan.available_fen },
          now: at,
        });
      }
    }
    await audit();
    return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
  });
}
