// B2-09m: W8 — APPROVED → PAID_MANUAL for a payment finance already made from a company account
// (规划/08 BR-WDR-16, BR-WDR-08 W8, BR-WDR-09, BR-WDR-17, BR-WDR-33 ⑧; 编排裁定 D10-595, D10-596).
// record(trx, input) runs on the caller's transaction, one withdrawal:
//   locks        users row → balance row → withdrawal row, the module's fixed order, so the
//                BR-WDR-05 (a) guard reads available_fen under the lock a clawback holds.
//   refusals     in the order of the contract, the first that fails, nothing written:
//                not_found, not_approved, channel_not_allowed (wechat), amount_mismatch,
//                paid_at_invalid, has_transfer_attempt (pending, success or unknown: that money may
//                be out, BR-WDR-15), query_required / query_success (a payer-side hold, as the
//                manual W3), member_blocked, channel_order_id_taken.
//   effects      CAS to PAID_MANUAL with paid_at as given, channel_order_id, both manual_*_by the
//                operator and the hold cleared; WITHDRAW:SUCCESS:CASH_<subject> `wd:{id}:PAID`, the
//                same voucher as W5; tax_ytd (BR-WDR-20); wallet.withdrawal_changed; for Alipay
//                the late_paid_check of this paid_at, whose bill day may have run (B2-09t, BR-WDR-23).
// EXECUTE and W8 both require APPROVED under the row lock and a CAS: the first to commit wins.
//
// Two refusals only surface as a throw that must roll the transaction back, so they are the
// caller's to turn into results: a serial number another transaction committed first
// (isChannelOrderIdCollision, the unique index) and a member without a verified real name
// (TaxYtdIdentityMissingError). `payout.enabled`, `queue_paused`, the channel switches and the
// watermark gate EXECUTE, not W8.
import type { DB } from '@couli/db';
import { buildVouchers, transitionWithdrawal } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { EventBus, JobQueue } from '../../platform/index.ts';
import type { AppealPrevStateReader, RiskStateBatchReader } from '../../risk/index.ts';
import { memberWithdrawalBlocked } from './payout-execute.ts';
import { PAYOUT_RECON_CHANNEL, sendLatePaidCheck } from './recon-schedule.ts';
import {
  createTaxYtdAccumulator,
  type TaxYtdIdentityKeyReader,
  type TaxYtdLogger,
} from './tax-ytd.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';
import { CASH_SUBJECT, PAYER_SIDE_HOLD, postingEntries } from './withdrawal-proven-success.ts';
import { readPayerSideQueryRefusal, type WithdrawalAttemptsPort } from './withdrawal-commands.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

const APPROVED = 'APPROVED';
const UNIQUE_VIOLATION = '23505';
const CHANNEL_ORDER_ID_KEY = 'withdrawals_channel_order_id_key';
/** 代理补全的默认 (contract): how far after the Clock a paid time may lie. */
const PAID_AT_TOLERANCE_MS = 5 * 60 * 1000;

export type ManualPaidRefusal =
  | 'not_found'
  | 'not_approved'
  | 'channel_not_allowed'
  | 'amount_mismatch'
  | 'paid_at_invalid'
  | 'has_transfer_attempt'
  | 'query_required'
  | 'query_success'
  | 'member_blocked'
  | 'channel_order_id_taken';

export interface ManualPaidInput {
  readonly appId: string;
  readonly withdrawalId: string;
  readonly channelOrderId: string;
  readonly paidAt: Date;
  readonly paidFen: bigint;
  /** The admin who enters and confirms it in one submission (BR-WDR-16, ADD-05). */
  readonly operatorId: string;
  readonly now: Date;
}

export type ManualPaidResult =
  | { readonly kind: 'paid'; readonly netFen: bigint }
  | { readonly kind: 'refused'; readonly reason: ManualPaidRefusal };

export interface WithdrawalManualPaid {
  record(trx: Transaction<DB>, input: ManualPaidInput): Promise<ManualPaidResult>;
}

export interface WithdrawalManualPaidOptions {
  readonly ledger: Ledger;
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly config: PayoutConfigPort;
  readonly risk: RiskStateBatchReader;
  readonly appeal: AppealPrevStateReader;
  readonly attempts: WithdrawalAttemptsPort;
  readonly eventBus: EventBus;
  readonly queue: Pick<JobQueue, 'send'>;
  readonly identityKey: TaxYtdIdentityKeyReader;
  readonly logger: TaxYtdLogger;
}

/** A serial number another transaction committed first (or holds, and then committed). */
export function isChannelOrderIdCollision(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: unknown }).constraint === CHANNEL_ORDER_ID_KEY
  );
}

export function createWithdrawalManualPaid(
  options: WithdrawalManualPaidOptions,
): WithdrawalManualPaid {
  const { ledger, config, risk, appeal, attempts, eventBus, queue } = options;
  const taxYtd = createTaxYtdAccumulator({
    identity: options.identityKey,
    logger: options.logger,
  });

  return {
    async record(trx, input) {
      const { appId, withdrawalId, now } = input;
      const refused = (reason: ManualPaidRefusal): ManualPaidResult => ({
        kind: 'refused',
        reason,
      });

      // The owner for the locks comes from a first read; everything is judged on the reread.
      const first = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select(['user_id', 'status'])
        .where('app_id', '=', appId)
        .where('id', '=', withdrawalId)
        .executeTakeFirst();
      if (first === undefined) return refused('not_found');
      if (first.status !== APPROVED) return refused('not_approved');
      await options.lockUsersForUpdate(trx, { appId, userIds: [first.user_id] });
      const balances = await ledger.lockBalances(trx, { appId, userIds: [first.user_id] });
      const balance = balances.find((row) => row.user_id === first.user_id);
      if (balance === undefined) throw new Error('payout: W8 without a balance row');
      const row = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select([
          'id',
          'user_id',
          'status',
          'hold_reason',
          'blocked_reason',
          'net_fen',
          'fee_fen',
          'tax_fen',
          'amount_fen',
          'payout_channel',
          'row_version',
          'created_at',
        ])
        .where('app_id', '=', appId)
        .where('id', '=', withdrawalId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const transition = transitionWithdrawal(row.status as 'APPROVED', 'MANUAL_PAID');
      if (row.status !== APPROVED || !transition.ok || transition.noop) {
        return refused('not_approved');
      }

      if (row.payout_channel === 'wechat') return refused('channel_not_allowed');
      if (input.paidFen !== row.net_fen) return refused('amount_mismatch');
      const paidAtMs = input.paidAt.getTime();
      if (
        Number.isNaN(paidAtMs) ||
        paidAtMs > now.getTime() + PAID_AT_TOLERANCE_MS ||
        paidAtMs < row.created_at.getTime()
      ) {
        return refused('paid_at_invalid');
      }
      if (await attempts.hasAttempt(trx, row.id, ['transfer'], ['pending', 'success', 'unknown'])) {
        return refused('has_transfer_attempt');
      }
      if (row.hold_reason === PAYER_SIDE_HOLD) {
        const refusal = await readPayerSideQueryRefusal(trx, config, appId, row.id);
        if (refusal !== null) return refused(refusal);
      }
      const riskRows = await risk.read(trx, { appId, userIds: [row.user_id] });
      if (
        row.blocked_reason !== null ||
        (await memberWithdrawalBlocked(trx, appeal, {
          appId,
          userId: row.user_id,
          now,
          riskRows,
          available: new Map([[row.user_id, balance.available_fen]]),
        }))
      ) {
        return refused('member_blocked');
      }
      const taken = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select('id')
        .where('app_id', '=', appId)
        .where('channel_order_id', '=', input.channelOrderId)
        .limit(1)
        .executeTakeFirst();
      if (taken !== undefined) return refused('channel_order_id_taken');

      const subject = CASH_SUBJECT[row.payout_channel];
      if (subject === undefined) {
        throw new Error(`payout: no cash subject for ${row.payout_channel}`);
      }
      const updated = await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({
          status: transition.to,
          paid_at: input.paidAt,
          channel_order_id: input.channelOrderId,
          manual_entry_by: input.operatorId,
          manual_confirm_by: input.operatorId,
          hold_reason: null,
          hold_at: null,
          row_version: row.row_version + 1,
          updated_at: now,
        })
        .where('app_id', '=', appId)
        .where('id', '=', row.id)
        .where('status', '=', APPROVED)
        .where('row_version', '=', row.row_version)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) return refused('not_approved');

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
      await taxYtd.accumulate(trx, {
        appId,
        userId: row.user_id,
        withdrawalId: row.id,
        createdAt: row.created_at,
        amountFen: row.amount_fen,
        taxFen: row.tax_fen,
        now,
      });
      await eventBus.publish(trx, {
        appId,
        name: 'wallet.withdrawal_changed',
        payload: { withdrawal_id: row.id, user_id: row.user_id, status: transition.to },
      });
      if (row.payout_channel === PAYOUT_RECON_CHANNEL) {
        await sendLatePaidCheck(queue, trx, { app_id: appId, withdrawal_id: row.id, round: 0 });
      }
      return { kind: 'paid', netFen: row.net_fen };
    },
  };
}
