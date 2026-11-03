// B2-05e: the withdrawal state commands of the review stage (规划/08 BR-WDR-08 迁移表 W2 / W3,
// BR-WDR-05 (a) 负余额, BR-WDR-09 W3 分录). Every transition goes through the generated
// transitionWithdrawal() and lands as one CAS UPDATE … WHERE id AND app_id AND status AND
// row_version; 0 rows is a concurrent change (WithdrawalConflictError, 20902, resource withdrawal)
// and nothing else is written. The caller owns the transaction (admin HTTP in B2-09, the negative
// balance consumer here).
//   W2 APPROVE   locks identity's users row → ledger.lockBalances; refuses while available < 0 or
//                blocked_reason is set (BR-WDR-05 (a)); risk freezes and withdraw_holds do not
//                touch W2 (they gate the application, BR-WDR-03 ⑦). No voucher.
//   W3 REJECT    from PENDING_REVIEW or APPROVED; a reason code is required; from APPROVED only
//                while no transfer attempt exists (BR-WDR-08 W3; a definite failure still counts
//                for the system path); same transaction: WITHDRAW:RETURN `wd:{id}:RETURN`
//                (frozen −amount / available +amount) through ledger.post under the balance lock.
//                B2-09k (BR-WDR-08 W3, BR-WDR-17, 决-08 A): hold_reason payer_side_after_transfer with
//                the switch on: the channel reported a failure but may have paid, so the latest
//                kind=query attempt must be fail. None, pending or unknown refuses query_required
//                (「订单不存在」 is recorded as unknown and has no verified code yet); success refuses
//                query_success (W11 ends it). Rejecting it anyway would pay twice.
//   system W3    NEGATIVE_BALANCE, reviewer null, note 'system:went_negative'; refused when any
//                transfer attempt exists (even a failed one).
// Each change publishes wallet.withdrawal_changed on the same transaction (ids and status only).
import type { DB } from '@couli/db';
import { buildVouchers, transitionWithdrawal, type WithdrawalState } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Ledger, PostingEntry } from '../../ledger/index.ts';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

export type WithdrawalAttemptResult = 'pending' | 'success' | 'unknown' | 'fail';
export interface WithdrawalAttemptsPort {
  /** Omitted results means ANY transfer attempt, including a definite failure. */
  hasAttempt(
    trx: Transaction<DB>,
    withdrawalId: string,
    kinds: readonly ('transfer' | 'query')[],
    results?: readonly WithdrawalAttemptResult[],
  ): Promise<boolean>;
}
export interface WithdrawalCommandsOptions {
  clock: Clock;
  ledger: Ledger;
  lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  attempts: WithdrawalAttemptsPort;
  eventBus: EventBus;
  /**
   * B2-09k: content's reader of payout.proven_success_writeoff.enabled for the manual W3's query
   * guard (BR-WDR-08 W3, BR-WDR-17). Omitted, or no row: the switch's default, on.
   */
  config?: PayoutConfigPort;
}
export interface WithdrawalCommand {
  appId: string;
  withdrawalId: string;
  expectedStatus: WithdrawalState;
  expectedRowVersion: number;
  reviewerId: string | null;
}
export type WithdrawalRejectReason =
  | 'RISK_SUSPECT'
  | 'ORDER_ABNORMAL'
  | 'PAYEE_INFO_INVALID'
  | 'USER_REQUEST'
  | 'OTHER'
  | 'NEGATIVE_BALANCE';
export interface RejectWithdrawalCommand extends WithdrawalCommand {
  reasonCode: WithdrawalRejectReason;
  note: string | null;
}
export type WithdrawalCommandResult =
  | { kind: 'changed'; status: WithdrawalState }
  | {
      kind: 'refused';
      reason:
        | 'negative_balance'
        | 'blocked'
        | 'reason_required'
        | 'attempt_exists'
        | 'invalid_state'
        // B2-09k: the manual W3 of hold_reason=payer_side_after_transfer against its latest query.
        | 'query_required'
        | 'query_success';
    };
export interface WithdrawalCommands {
  approve(trx: Transaction<DB>, input: WithdrawalCommand): Promise<WithdrawalCommandResult>;
  reject(trx: Transaction<DB>, input: RejectWithdrawalCommand): Promise<WithdrawalCommandResult>;
  systemRejectNegative(
    trx: Transaction<DB>,
    input: WithdrawalCommand,
  ): Promise<WithdrawalCommandResult>;
}

/** 20902 data.resource=withdrawal: the CAS matched no row (status or row_version moved, or another app). */
export class WithdrawalConflictError extends Error {
  readonly code = 20902 as const;
  readonly data = { resource: 'withdrawal' } as const;
  constructor() {
    super('withdrawal changed concurrently');
    this.name = 'WithdrawalConflictError';
  }
}

/** The manual reason codes of the contract (NEGATIVE_BALANCE is the system path's own). */
const MANUAL_REASONS: readonly string[] = [
  'RISK_SUSPECT',
  'ORDER_ABNORMAL',
  'PAYEE_INFO_INVALID',
  'USER_REQUEST',
  'OTHER',
];
const SYSTEM_NOTE = 'system:went_negative';
/** Only the member's own balance row is locked and posted to; platform accounts never move here. */
const RETURN_TEMPLATE = 'WITHDRAW:RETURN';

interface LockedWithdrawal {
  readonly id: string;
  readonly user_id: string;
  readonly amount_fen: bigint;
  readonly status: string;
  readonly row_version: number;
  readonly blocked_reason: string | null;
  readonly hold_reason: string | null;
}

/** BR-WDR-17: the switch of W11 and of the query guard of W3 and W8; no row means on. */
export const PROVEN_SUCCESS_SWITCH = 'payout.proven_success_writeoff.enabled';
const PAYER_SIDE_HOLD = 'payer_side_after_transfer';

/** The switch's value as stored; anything unreadable counts as on, the safe side. */
export function provenSuccessSwitchOn(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'false' || value === 'off' || value === 0) return false;
  return true;
}

export function createWithdrawalCommands(options: WithdrawalCommandsOptions): WithdrawalCommands {
  const { clock, ledger, attempts, eventBus } = options;

  /** The row under the users lock (same app only); null = no such row for this app. */
  async function readLocked(
    trx: Transaction<DB>,
    input: WithdrawalCommand,
  ): Promise<LockedWithdrawal | null> {
    const row = await trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'user_id',
        'amount_fen',
        'status',
        'row_version',
        'blocked_reason',
        'hold_reason',
      ])
      .where('app_id', '=', input.appId)
      .where('id', '=', input.withdrawalId)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Users row first (BR-WDR-07 lock order), then the balance row; the user owning the row. */
  async function lockUserAndBalance(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
  ): Promise<{ account_id: string; available_fen: bigint } | null> {
    await options.lockUsersForUpdate(trx, { appId, userIds: [userId] });
    const balances = await ledger.lockBalances(trx, { appId, userIds: [userId] });
    const own = balances.find((row) => row.user_id === userId);
    return own === undefined
      ? null
      : { account_id: own.account_id, available_fen: own.available_fen };
  }

  /** The one CAS write of a transition; 0 rows → 20902. */
  async function cas(
    trx: Transaction<DB>,
    input: WithdrawalCommand,
    to: WithdrawalState,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const now = clock.now();
    const result = await trx
      .withSchema('app')
      .updateTable('withdrawals')
      .set({
        ...patch,
        status: to,
        row_version: input.expectedRowVersion + 1,
        updated_at: now,
      })
      .where('app_id', '=', input.appId)
      .where('id', '=', input.withdrawalId)
      .where('status', '=', input.expectedStatus)
      .where('row_version', '=', input.expectedRowVersion)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new WithdrawalConflictError();
  }

  async function publishChanged(
    trx: Transaction<DB>,
    appId: string,
    withdrawalId: string,
    userId: string,
    status: WithdrawalState,
  ): Promise<void> {
    await eventBus.publish(trx, {
      appId,
      name: 'wallet.withdrawal_changed',
      payload: { withdrawal_id: withdrawalId, user_id: userId, status },
    });
  }

  /** W3's voucher: frozen −amount back to available, keyed wd:{id}:RETURN (BR-WDR-09). */
  async function postReturn(
    trx: Transaction<DB>,
    appId: string,
    row: LockedWithdrawal,
    accountId: string,
    operator: string,
  ): Promise<void> {
    const [voucher] = buildVouchers(RETURN_TEMPLATE, {
      withdrawal_id: row.id,
      user_id: row.user_id,
      withdraw_fen: row.amount_fen,
    });
    if (voucher === undefined) throw new Error('payout: WITHDRAW:RETURN built no voucher');
    const entries: PostingEntry[] = voucher.entries.map((entry) => ({
      account: { ownerType: 'user', accountId },
      sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    }));
    await ledger.post(trx, {
      appId,
      uniqKey: voucher.uniq_key,
      bizType: 'withdrawal',
      bizId: row.id,
      operator,
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries,
    });
  }

  /** The query guard of a payer-side hold: the refusal, or null when W3 may go on. */
  async function queryGuardRefusal(
    trx: Transaction<DB>,
    appId: string,
    withdrawalId: string,
  ): Promise<'query_required' | 'query_success' | null> {
    const setting = await options.config?.configValue(appId, PROVEN_SUCCESS_SWITCH, trx);
    if (setting !== undefined && setting !== null && !provenSuccessSwitchOn(setting.value)) {
      return null;
    }
    const latest = await trx
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select('result')
      .where('app_id', '=', appId)
      .where('withdrawal_id', '=', withdrawalId)
      .where('kind', '=', 'query')
      .orderBy('at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (latest?.result === 'success') return 'query_success';
    return latest?.result === 'fail' ? null : 'query_required';
  }

  /**
   * The shared W3: reason already judged by the caller. Locks, reads, checks the attempts rule,
   * CAS, voucher, event.
   */
  async function rejectWith(
    trx: Transaction<DB>,
    input: WithdrawalCommand,
    reasonCode: WithdrawalRejectReason,
    note: string | null,
    reviewerId: string | null,
    attemptsRule: 'manual' | 'system',
  ): Promise<WithdrawalCommandResult> {
    const transition = transitionWithdrawal(input.expectedStatus, 'REJECT');
    if (!transition.ok || transition.noop) return { kind: 'refused', reason: 'invalid_state' };
    const row = await readLocked(trx, input);
    if (row === null) throw new WithdrawalConflictError();
    const locked = await lockUserAndBalance(trx, input.appId, row.user_id);
    if (locked === null) throw new WithdrawalConflictError();
    // Re-read under the lock: the row may have moved while we waited.
    const current = await readLocked(trx, input);
    if (current === null) throw new WithdrawalConflictError();
    if (
      current.status !== input.expectedStatus ||
      current.row_version !== input.expectedRowVersion
    ) {
      throw new WithdrawalConflictError();
    }
    // BR-WDR-08 W3: from APPROVED only without a transfer attempt (manual: a definite failure or a
    // query does not block); the system path refuses any transfer attempt at all.
    if (current.status === 'APPROVED' || attemptsRule === 'system') {
      const blocked =
        attemptsRule === 'manual'
          ? await attempts.hasAttempt(
              trx,
              current.id,
              ['transfer'],
              ['pending', 'success', 'unknown'],
            )
          : await attempts.hasAttempt(trx, current.id, ['transfer']);
      if (blocked) return { kind: 'refused', reason: 'attempt_exists' };
    }
    if (attemptsRule === 'manual' && current.hold_reason === PAYER_SIDE_HOLD) {
      const refusal = await queryGuardRefusal(trx, input.appId, current.id);
      if (refusal !== null) return { kind: 'refused', reason: refusal };
    }
    const now = clock.now();
    await cas(trx, input, transition.to, {
      reject_reason_code: reasonCode,
      reject_note: note,
      reviewer_id: reviewerId,
      reviewed_at: now,
    });
    await postReturn(
      trx,
      input.appId,
      current,
      locked.account_id,
      reviewerId === null ? 'system' : `admin:${reviewerId}`,
    );
    await publishChanged(trx, input.appId, current.id, current.user_id, transition.to);
    return { kind: 'changed', status: transition.to };
  }

  return {
    async approve(trx, input) {
      const transition = transitionWithdrawal(input.expectedStatus, 'APPROVE');
      if (!transition.ok || transition.noop) return { kind: 'refused', reason: 'invalid_state' };
      const row = await readLocked(trx, input);
      if (row === null) throw new WithdrawalConflictError();
      const locked = await lockUserAndBalance(trx, input.appId, row.user_id);
      if (locked === null) throw new WithdrawalConflictError();
      const current = await readLocked(trx, input);
      if (current === null) throw new WithdrawalConflictError();
      if (
        current.status !== input.expectedStatus ||
        current.row_version !== input.expectedRowVersion
      ) {
        throw new WithdrawalConflictError();
      }
      // BR-WDR-05 (a): judged on the balance read under this transaction's lock.
      if (locked.available_fen < 0n) return { kind: 'refused', reason: 'negative_balance' };
      if (current.blocked_reason !== null) return { kind: 'refused', reason: 'blocked' };
      await cas(trx, input, transition.to, {
        reviewer_id: input.reviewerId,
        reviewed_at: clock.now(),
      });
      await publishChanged(trx, input.appId, current.id, current.user_id, transition.to);
      return { kind: 'changed', status: transition.to };
    },
    async reject(trx, input) {
      const reason: unknown = input.reasonCode;
      if (typeof reason !== 'string' || !MANUAL_REASONS.includes(reason)) {
        return { kind: 'refused', reason: 'reason_required' };
      }
      return rejectWith(
        trx,
        input,
        reason as WithdrawalRejectReason,
        input.note,
        input.reviewerId,
        'manual',
      );
    },
    async systemRejectNegative(trx, input) {
      return rejectWith(trx, input, 'NEGATIVE_BALANCE', SYSTEM_NOTE, null, 'system');
    },
  };
}
