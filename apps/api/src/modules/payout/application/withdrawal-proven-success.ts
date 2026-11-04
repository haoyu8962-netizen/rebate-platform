// B2-07e: W11 — a withdrawal returned by W9 (APPROVED, hold_reason payer_side_after_transfer) is
// settled as PAID_API on the channel's proof of success (规划/08 BR-WDR-08 W11, BR-WDR-09,
// BR-WDR-23 ③ 决-08 A; contracts/openapi.yaml writeOffAdminReconDiff). Here the proof is the bill
// line the R2 reconciliation stored with the difference; the caller (ledger's write-off of that
// difference, through the port app.module hands in) owns the transaction.
// proveChannelSuccess(trx, input), in order:
//   switch payout.proven_success_writeoff.enabled (content's config, default on) off → refused
//   writeoff_disabled; lock order BR-WDR-07: identity's users row → ledger.lockBalances; the row
//   reread under the lock: status not APPROVED → WithdrawalConflictError (20902 withdrawal);
//   hold_reason not payer_side_after_transfer → refused withdrawal_not_returned; not exactly one
//   kind=transfer attempt, or that one not result=fail → refused transfer_attempts_mismatch; the
//   bill line's out_biz_no not the withdrawal's → refused not_payer_side_case; the bill amount not
//   net_fen → refused amount_mismatch;
//   transitionWithdrawal('APPROVED', 'CHANNEL_SUCCESS_PROVEN') as one CAS (PAID_API, paid_at the
//   bill line's booked time else `now`, channel_order_id from the bill line, hold_reason / hold_at
//   cleared, executor_id the operator, executed_at, row_version + 1; 0 rows → 20902 withdrawal);
//   WITHDRAW:SUCCESS:CASH_<channel> `wd:{id}:PAID` through ledger.post (operator admin:<id>);
//   the attempt-append job on queue payout-attempt-append on the same transaction (D10-428);
//   wallet.withdrawal_changed on the same transaction.
// A refusal writes nothing. Logs carry ids and codes only, never the payee.
import type { DB } from '@couli/db';
import { buildVouchers, chinaDayRange, transitionWithdrawal } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Ledger, PostingEntry } from '../../ledger/index.ts';
import type { EventBus, JobQueue } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';
import { instant } from './payout-landing.ts';
import {
  createTaxYtdAccumulator,
  type TaxYtdIdentityKeyReader,
  type TaxYtdLogger,
} from './tax-ytd.ts';
import {
  PROVEN_SUCCESS_SWITCH,
  WithdrawalConflictError,
  provenSuccessSwitchOn,
} from './withdrawal-commands.ts';

/** The guard conditions of W11 a call may be refused on (contract data.reason). */
export type ProvenSuccessRefusal =
  | 'writeoff_disabled'
  | 'withdrawal_not_returned'
  | 'transfer_attempts_mismatch'
  | 'not_payer_side_case'
  | 'amount_mismatch';

/** The bill line stored with the difference, as the proof of the channel's success. */
export interface ProvenBillLine {
  /** YYYY-MM-DD, the +08:00 accounting day of the bill. */
  readonly billDate: string;
  /** The out_biz_no the line names (null when it names none). */
  readonly outBizNo: string | null;
  /** The channel's order id of the line (null when it has none). */
  readonly channelOrderId: string | null;
  /** 入账时间, ISO with an explicit offset (null when the stored line has none). */
  readonly bookedAt: string | null;
}

export interface ProveChannelSuccessInput {
  readonly appId: string;
  readonly withdrawalId: string;
  /** The difference the proof comes from (the attempt record's idempotency key with the withdrawal). */
  readonly reconDiffId: string;
  readonly billLine: ProvenBillLine;
  /** The bill line's amount (the difference's actual_fen), compared with net_fen. */
  readonly expectedFen: bigint;
  /** admin_users.id of the operator (executor_id; voucher operator admin:<id>). */
  readonly operatorId: string;
  /** The server's time of the write-off (the injected Clock, read by the caller). */
  readonly now: Date;
}

export type ProveChannelSuccessResult =
  | {
      readonly kind: 'proven';
      readonly status: 'PAID_API';
      readonly paidAt: Date;
      readonly channelOrderId: string | null;
    }
  | { readonly kind: 'refused'; readonly reason: ProvenSuccessRefusal };

export interface WithdrawalProvenSuccess {
  /**
   * W11 on the caller's transaction. Throws WithdrawalConflictError (20902 withdrawal) when the
   * withdrawal is not APPROVED (or not the app's) or the CAS matched no row.
   */
  proveChannelSuccess(
    trx: Transaction<DB>,
    input: ProveChannelSuccessInput,
  ): Promise<ProveChannelSuccessResult>;
}

export interface WithdrawalProvenSuccessOptions {
  readonly ledger: Ledger;
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  /** content's configuration reader (payout.proven_success_writeoff.enabled). */
  readonly config: PayoutConfigPort;
  /** The job queue (same-transaction enqueue of the attempt-append job). */
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  /**
   * B2-08b (BR-WDR-20): identity's realname-identity-key port. A proven W11 adds the withdrawal
   * to tax_ytd on the caller's transaction, after the voucher (application/tax-ytd.ts); a member
   * without a verified real name throws, so the write-off rolls back. A refusal adds nothing.
   * app.module's write-off factory always passes it (createRealnameIdentityKeyReader).
   */
  readonly identityKey?: TaxYtdIdentityKeyReader;
  /** B2-08b: the warn line tax_ytd_identity_missing (ids only). */
  readonly logger?: TaxYtdLogger;
}

/** content's switch of W11 (08 BR-WDR-08 细则, BR-WDR-17): default on. */
export { PROVEN_SUCCESS_SWITCH };
/** The payout process's queue and job of the W11 attempt records (D10-428). */
export const PAYOUT_ATTEMPT_APPEND_QUEUE = 'payout-attempt-append';
export const PAYOUT_ATTEMPT_APPEND_JOB = 'append';
/** BR-WDR-08 W11: the hold W9 leaves on the returned withdrawal. */
export const PAYER_SIDE_HOLD = 'payer_side_after_transfer';
const APPROVED = 'APPROVED';
/** BR-WDR-09: the cash subject of the success voucher by channel (specs/ledger-templates.csv). */
export const CASH_SUBJECT: Readonly<Record<string, string>> = {
  alipay: 'CASH_ALIPAY',
  bank_card: 'CASH_BANK',
  wechat: 'CASH_WECHAT',
};

/** The job W11 queues for the payout process (jobs/attempt-append-job.ts reads it). */
export interface AttemptAppendPayload {
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly recon_diff_id: string;
  readonly bill_date: string;
  readonly out_biz_no: string;
  readonly channel_order_id: string | null;
  readonly amount_fen: string;
  readonly booked_at: string | null;
  readonly operator: string;
  readonly at: string;
}

interface ProvenRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
  readonly hold_reason: string | null;
  readonly out_biz_no: string;
  readonly net_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
  readonly payout_channel: string;
  readonly row_version: number;
  readonly amount_fen: bigint;
  readonly created_at: Date;
}

type BuiltEntry = {
  account: { owner_type: string; subject: string };
  sub_account: 'available' | 'frozen' | null;
  amount_fen: bigint;
  ledger_type: string;
  sub_type: string | null;
};

export function postingEntries(built: readonly BuiltEntry[], accountId: string): PostingEntry[] {
  return built.map((entry) => ({
    account:
      entry.account.owner_type === 'user'
        ? { ownerType: 'user', accountId }
        : { ownerType: 'platform', subject: entry.account.subject },
    sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
    amount_fen: entry.amount_fen,
    ledger_type: entry.ledger_type,
    sub_type: entry.sub_type,
    income_type: null,
  }));
}

/**
 * paid_at of W11 (orchestrator ruling D10-431): the bill line's 入账时间 when it carries a readable
 * one, else 00:00 +08:00 of the bill day (so a later R2 run and the BR-WDR-21 quarter both see
 * the day the channel paid, not the day of the write-off). An unreadable booked time counts as
 * none; only a bill day that is not a date falls back to the server's time.
 */
function paidAtOf(line: ProvenBillLine, now: Date): Date {
  if (line.bookedAt !== null) {
    const booked = Date.parse(line.bookedAt);
    if (!Number.isNaN(booked)) return instant(now, booked);
  }
  try {
    const start = Date.parse(chinaDayRange(line.billDate).start);
    return Number.isNaN(start) ? now : instant(now, start);
  } catch {
    return now;
  }
}

/** The switch value as the registry stores it (boolean, or its JSON text); unreadable → default on. */
export function createWithdrawalProvenSuccess(
  options: WithdrawalProvenSuccessOptions,
): WithdrawalProvenSuccess {
  const { ledger, config, queue, eventBus } = options;
  // B2-08b: without identity's port (older kits) nothing is added; without a logger the warn line
  // of a missing real name is not written (the throw still rolls the write-off back).
  const taxYtd =
    options.identityKey === undefined
      ? undefined
      : createTaxYtdAccumulator({
          identity: options.identityKey,
          logger: options.logger ?? { warn: () => undefined },
        });

  async function readRow(
    trx: Transaction<DB>,
    appId: string,
    withdrawalId: string,
  ): Promise<ProvenRow | null> {
    const row = await trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'user_id',
        'status',
        'hold_reason',
        'out_biz_no',
        'net_fen',
        'fee_fen',
        'tax_fen',
        'payout_channel',
        'row_version',
        'amount_fen',
        'created_at',
      ])
      .where('app_id', '=', appId)
      .where('id', '=', withdrawalId)
      .executeTakeFirst();
    return row ?? null;
  }

  /** The transfer attempts of the withdrawal (kind=transfer only; query rows never count). */
  async function transferResults(
    trx: Transaction<DB>,
    appId: string,
    withdrawalId: string,
  ): Promise<string[]> {
    const rows = await trx
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select('result')
      .where('app_id', '=', appId)
      .where('withdrawal_id', '=', withdrawalId)
      .where('kind', '=', 'transfer')
      .execute();
    return rows.map((row) => row.result);
  }

  return {
    async proveChannelSuccess(trx, input) {
      const { appId, withdrawalId, billLine, now } = input;
      const setting = await config.configValue(appId, PROVEN_SUCCESS_SWITCH, trx);
      if (setting !== null && !provenSuccessSwitchOn(setting.value)) {
        return { kind: 'refused', reason: 'writeoff_disabled' };
      }
      // The user id for the users lock comes from a first read; everything is judged on the
      // reread under the locks (BR-WDR-07: users row → balance row), and the CAS below guards
      // the status and row_version again.
      const first = await readRow(trx, appId, withdrawalId);
      if (first === null || first.status !== APPROVED) throw new WithdrawalConflictError();
      await options.lockUsersForUpdate(trx, { appId, userIds: [first.user_id] });
      const balances = await ledger.lockBalances(trx, { appId, userIds: [first.user_id] });
      const balance = balances.find((row) => row.user_id === first.user_id);
      const row = await readRow(trx, appId, withdrawalId);
      if (row === null || row.status !== APPROVED || balance === undefined) {
        throw new WithdrawalConflictError();
      }
      if (row.hold_reason !== PAYER_SIDE_HOLD) {
        return { kind: 'refused', reason: 'withdrawal_not_returned' };
      }
      const transfers = await transferResults(trx, appId, withdrawalId);
      if (transfers.length !== 1 || transfers[0] !== 'fail') {
        return { kind: 'refused', reason: 'transfer_attempts_mismatch' };
      }
      if (billLine.outBizNo === null || billLine.outBizNo !== row.out_biz_no) {
        return { kind: 'refused', reason: 'not_payer_side_case' };
      }
      if (input.expectedFen !== row.net_fen) return { kind: 'refused', reason: 'amount_mismatch' };
      const subject = CASH_SUBJECT[row.payout_channel];
      if (subject === undefined)
        throw new Error(`payout: no cash subject for ${row.payout_channel}`);
      const transition = transitionWithdrawal(APPROVED, 'CHANNEL_SUCCESS_PROVEN');
      if (!transition.ok || transition.noop) throw new WithdrawalConflictError();
      const paidAt = paidAtOf(billLine, now);
      const updated = await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({
          status: transition.to,
          paid_at: paidAt,
          channel_order_id: billLine.channelOrderId,
          hold_reason: null,
          hold_at: null,
          executor_id: input.operatorId,
          executed_at: now,
          row_version: row.row_version + 1,
          updated_at: now,
        })
        .where('app_id', '=', appId)
        .where('id', '=', withdrawalId)
        .where('status', '=', APPROVED)
        .where('row_version', '=', row.row_version)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new WithdrawalConflictError();
      const [voucher] = buildVouchers(`WITHDRAW:SUCCESS:${subject}`, {
        withdrawal_id: row.id,
        user_id: row.user_id,
        net_fen: row.net_fen,
        fee_fen: row.fee_fen,
        tax_fen: row.tax_fen,
      });
      if (voucher === undefined) throw new Error('payout: WITHDRAW:SUCCESS built no voucher');
      await ledger.post(trx, {
        appId,
        uniqKey: voucher.uniq_key,
        bizType: 'withdrawal',
        bizId: row.id,
        operator: `admin:${input.operatorId}`,
        memo: null,
        orderKey: null,
        beneficiaryUserId: null,
        role: null,
        voucherKind: null,
        entries: postingEntries(voucher.entries, balance.account_id),
      });
      if (taxYtd !== undefined) {
        await taxYtd.accumulate(trx, {
          appId,
          userId: row.user_id,
          withdrawalId: row.id,
          createdAt: row.created_at,
          amountFen: row.amount_fen,
          taxFen: row.tax_fen,
          now,
        });
      }
      const payload: AttemptAppendPayload = {
        app_id: appId,
        withdrawal_id: row.id,
        recon_diff_id: input.reconDiffId,
        bill_date: billLine.billDate,
        out_biz_no: row.out_biz_no,
        channel_order_id: billLine.channelOrderId,
        amount_fen: row.net_fen.toString(),
        booked_at: billLine.bookedAt,
        operator: `admin:${input.operatorId}`,
        at: now.toISOString(),
      };
      await queue.send(
        PAYOUT_ATTEMPT_APPEND_QUEUE,
        PAYOUT_ATTEMPT_APPEND_JOB,
        { ...payload },
        {
          trx,
          singletonKey: `${row.id}:${input.reconDiffId}:attempt-append`,
        },
      );
      await eventBus.publish(trx, {
        appId,
        name: 'wallet.withdrawal_changed',
        payload: { withdrawal_id: row.id, user_id: row.user_id, status: transition.to },
      });
      return {
        kind: 'proven',
        status: 'PAID_API',
        paidAt,
        channelOrderId: billLine.channelOrderId,
      };
    },
  };
}
