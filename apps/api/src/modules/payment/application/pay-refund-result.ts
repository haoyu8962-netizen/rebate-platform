// B2-15e: what a refund notification and a refund query share once the adapter has verified or
// answered (08 BR-PAY-06 ④ ⑤, BR-PAY-07 退款凭证; specs/ledger-rules.md §10; D10-349, D10-351 ①).
//
// handleRefundReport — the one result handler of BR-PAY-06 ④ (「两者走同一个处理器」), on the
//   caller's transaction: our refund of the reported out_refund_no is looked up, its target's
//   business object lock taken (the pay order's biz object, or the anomaly receipt itself) and the
//   refund re-read (BR-PAY-02 CAS 口径, payment/AGENTS.md rule 3), then the fixed checks of
//   domain/pay-refund.ts decide:
//     succeed       RF2 on this transaction: the status CAS (0 rows → PayRefundConflict, the caller
//                   rolls back), the target's refunded_fen, the PAY_REFUND voucher (借 PAY_RECEIPTS:
//                   {biz_type} / 贷 CASH_PAY:{pay_channel}) or, for an anomaly receipt, the reverse
//                   PAY_ANOMALY voucher (借 PAY_SUSPENSE / 贷 CASH_PAY:{pay_channel}), the business
//                   object's biz.reconcile job (a pay order's only: an anomaly receipt never
//                   fulfilled anything, D10-351 ①) and the pay_refund.succeeded event — all on the
//                   one transaction, so a failure anywhere leaves nothing behind;
//     fail          RF3: the status CAS; the held amount is free again; nothing is booked;
//     already_final nothing (a repeat of a decided refund);
//     mismatch      nothing moves, the amount stays held; the caller keeps the record and alerts;
//     rejected      the identity is not ours (the notification path never reaches this; the query
//                   path passes `ours: false` for an answer without, or with someone else's, identity).
// Amounts stay bigint fen; the only yuan conversion lives in the real adapters (B2-15k). No user
// account is touched anywhere here (payment/AGENTS.md rule 1).
// Also compiled by the `test` project (through jobs/pay-jobs.ts): erasable syntax only.
import type { DB } from '@couli/db';
import { transitionPayRefund, type PayRefundState } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import type { Transaction } from 'kysely';
import type { PostingVoucher } from '../../ledger/index.ts';
import {
  judgeRefundResult,
  refundStatesOf,
  type RefundResultVerdict,
} from '../domain/pay-refund.ts';
import type { PayChannelCode, PayRefundTargetType } from '../domain/types.ts';
import { findOrderById, lockBizObject, type PayOrderRow } from '../infra/pay-order-store.ts';
import {
  addAnomalyRefundedFen,
  addOrderRefundedFen,
  findAnomalyById,
  findRefundById,
  findRefundByOutRefundNo,
  lockAnomaly,
  markRefundFailed,
  markRefundSucceeded,
  type PayAnomalyRow,
  type PayRefundRow,
} from '../infra/pay-refund-store.ts';
import {
  BIZ_RECONCILE_JOB,
  PAY_QUEUE,
  bizReconcileKey,
  type BizReconcilePayload,
} from '../jobs/names.ts';
import {
  PAY_OPERATOR,
  rawConfigValue,
  type PayResultSource,
  type PaySettlementDeps,
} from './pay-settlement.ts';

/** platform/events EVENT_NAMES entry published on RF2 (02 §11, D10-349). */
export const PAY_REFUND_SUCCEEDED_EVENT = 'pay_refund.succeeded';

/** The payload of pay_refund.succeeded: ids, the enum and the integer amount only (02 §12.3). */
export interface PayRefundSucceededPayload {
  readonly pay_refund_id: string;
  readonly target_type: PayRefundTargetType;
  readonly target_id: string;
  readonly pay_channel: PayChannelCode;
  readonly amount_fen: number;
}

export function refundSuccessStatesKey(channel: PayChannelCode): string {
  return `pay.${channel}.refund_success_states`;
}
export function refundFailStatesKey(channel: PayChannelCode): string {
  return `pay.${channel}.refund_fail_states`;
}

/** The CAS of RF2 / RF3 changed no row: another judgement moved the refund first. */
export class PayRefundConflict extends Error {
  readonly payRefundId: string;

  constructor(payRefundId: string) {
    super('payment: the refund left PROCESSING before this result');
    this.name = 'PayRefundConflict';
    this.payRefundId = payRefundId;
  }
}

/** Both state lists in effect; a broken value alerts once and falls back (BR-PAY-06 细则). */
export async function refundStatesFor(
  deps: Pick<PaySettlementDeps, 'config' | 'logger'>,
  appId: string,
  channel: PayChannelCode,
): Promise<{ readonly success: readonly string[]; readonly fail: readonly string[] }> {
  const [successRaw, failRaw] = await Promise.all([
    rawConfigValue(deps.config, appId, refundSuccessStatesKey(channel)),
    rawConfigValue(deps.config, appId, refundFailStatesKey(channel)),
  ]);
  const success = refundStatesOf(channel, 'success', successRaw);
  const fail = refundStatesOf(channel, 'fail', failRaw);
  for (const [list, key] of [
    [success, refundSuccessStatesKey(channel)],
    [fail, refundFailStatesKey(channel)],
  ] as const) {
    if (list.fallback) {
      deps.logger.warn({ app_id: appId, pay_channel: channel, key }, 'pay_refund_states_invalid');
    }
  }
  return { success: success.states, fail: fail.states };
}

/** The PAY_REFUND voucher of a succeeded refund of a pay order (specs/ledger-rules.md §10). */
export function refundVoucher(order: PayOrderRow, refund: PayRefundRow): PostingVoucher {
  return {
    appId: refund.app_id,
    uniqKey: `PAY_REFUND:${refund.id}`,
    bizType: 'pay_refund',
    bizId: refund.id,
    operator: PAY_OPERATOR,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'PAY_REFUND',
    entries: [
      {
        account: { ownerType: 'platform', subject: `PAY_RECEIPTS:${order.biz_type}` },
        sub_account: 'available',
        amount_fen: refund.amount_fen,
        ledger_type: 'PAY_REFUND',
        sub_type: order.pay_channel,
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: `CASH_PAY:${order.pay_channel}` },
        sub_account: 'available',
        amount_fen: -refund.amount_fen,
        ledger_type: 'PAY_REFUND',
        sub_type: order.pay_channel,
        income_type: null,
      },
    ],
  };
}

/**
 * The reverse PAY_ANOMALY voucher of a succeeded refund of an anomaly receipt (BR-PAY-07: 对异常收款
 * 的退款成功时写相反方向; one per refund, so PAY_SUSPENSE ends at the unrefunded remainder).
 */
export function anomalyRefundVoucher(anomaly: PayAnomalyRow, refund: PayRefundRow): PostingVoucher {
  return {
    appId: refund.app_id,
    uniqKey: `PAY_ANOMALY_REFUND:${refund.id}`,
    bizType: 'pay_refund',
    bizId: refund.id,
    operator: PAY_OPERATOR,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'PAY_ANOMALY',
    entries: [
      {
        account: { ownerType: 'platform', subject: 'PAY_SUSPENSE' },
        sub_account: 'available',
        amount_fen: refund.amount_fen,
        ledger_type: 'PAY_ANOMALY',
        sub_type: anomaly.pay_channel,
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: `CASH_PAY:${anomaly.pay_channel}` },
        sub_account: 'available',
        amount_fen: -refund.amount_fen,
        ledger_type: 'PAY_ANOMALY',
        sub_type: anomaly.pay_channel,
        income_type: null,
      },
    ],
  };
}

/** What a verified refund notification or a refund query answer reports, as the handler needs it. */
export interface PayRefundReport {
  readonly source: PayResultSource;
  /** The channel that reported: the notification route's, or the queried adapter's. */
  readonly channel: PayChannelCode;
  /** Our app the identity resolved to (the notification path), or the queried refund's app. */
  readonly appId: string;
  /** ① the reported merchant / application identity resolves to `appId`. */
  readonly ours: boolean;
  readonly outRefundNo: string;
  readonly outTradeNo: string | null;
  readonly channelTradeNo: string | null;
  readonly refundFen: bigint | null;
  readonly channelState: string | null;
  readonly channelRefundNo: string | null;
}

export interface PayRefundOutcome {
  readonly verdict: RefundResultVerdict;
  /** Our refund of the reported number, when there is one. */
  readonly payRefundId: string | null;
  readonly targetType: PayRefundTargetType | null;
  readonly targetId: string | null;
}

/** The refund's target as re-read under its lock. */
type Target =
  | { readonly type: 'pay_order'; readonly order: PayOrderRow }
  | { readonly type: 'pay_anomaly'; readonly anomaly: PayAnomalyRow };

/** Takes the target's lock and re-reads the refund and its target (BR-PAY-06 ③ ④ 先锁再重读). */
async function lockTarget(
  trx: Transaction<DB>,
  refund: PayRefundRow,
): Promise<{ readonly refund: PayRefundRow; readonly target: Target }> {
  const appId = refund.app_id;
  if (refund.target_type === 'pay_order') {
    const order = await findOrderById(trx, appId, refund.target_id);
    if (order === undefined) throw new Error('payment: the refund target pay order vanished');
    await lockBizObject(trx, { appId, bizType: order.biz_type, bizRef: order.biz_ref });
    const fresh = await findRefundById(trx, appId, refund.id);
    const freshOrder = await findOrderById(trx, appId, order.id);
    if (fresh === undefined || freshOrder === undefined) {
      throw new Error('payment: the refund or its pay order vanished under the lock');
    }
    return { refund: fresh, target: { type: 'pay_order', order: freshOrder } };
  }
  await lockAnomaly(trx, appId, refund.target_id);
  const fresh = await findRefundById(trx, appId, refund.id);
  const anomaly = await findAnomalyById(trx, appId, refund.target_id);
  if (fresh === undefined || anomaly === undefined) {
    throw new Error('payment: the refund or its anomaly receipt vanished under the lock');
  }
  return { refund: fresh, target: { type: 'pay_anomaly', anomaly } };
}

function targetFacts(target: Target): {
  readonly payChannel: PayChannelCode;
  readonly outTradeNo: string | null;
  readonly channelTradeNo: string | null;
} {
  if (target.type === 'pay_order') {
    return {
      payChannel: target.order.pay_channel as PayChannelCode,
      outTradeNo: target.order.out_trade_no,
      channelTradeNo: target.order.channel_trade_no,
    };
  }
  return {
    payChannel: target.anomaly.pay_channel as PayChannelCode,
    outTradeNo: target.anomaly.out_trade_no,
    channelTradeNo: target.anomaly.channel_trade_no,
  };
}

/**
 * RF2 and everything BR-PAY-06 ⑤ puts in the same transaction, for a refund re-read as PROCESSING
 * under its target's lock.
 */
async function succeedRefund(
  deps: PaySettlementDeps,
  trx: Transaction<DB>,
  refund: PayRefundRow,
  target: Target,
  report: PayRefundReport,
): Promise<void> {
  const move = transitionPayRefund(refund.status as PayRefundState, 'REFUND_SUCCESS');
  if (!move.ok || move.to !== 'SUCCESS') throw new PayRefundConflict(refund.id);
  const now = deps.clock.now();
  const succeeded = await markRefundSucceeded(
    trx,
    refund.app_id,
    refund.id,
    report.channelRefundNo,
    now,
  );
  if (succeeded === undefined) throw new PayRefundConflict(refund.id);
  if (target.type === 'pay_order') {
    const order = await addOrderRefundedFen(
      trx,
      refund.app_id,
      target.order.id,
      refund.amount_fen,
      now,
    );
    if (order === undefined) throw new PayRefundConflict(refund.id);
    // duplicate: the voucher exists already (excluded by the lock and the CAS; a replay only).
    await deps.ledger.post(trx, refundVoucher(order, succeeded));
    // 入队业务类型的回收任务: biz.reconcile recomputes the entitlement from the paid and refunded
    // facts (application/pay-fulfillment.ts), serial per object.
    const payload: BizReconcilePayload = {
      app_id: order.app_id,
      biz_type: order.biz_type,
      biz_ref: order.biz_ref,
      pay_order_id: order.id,
    };
    await deps.queue.send(PAY_QUEUE, BIZ_RECONCILE_JOB, payload, {
      trx,
      singletonKey: bizReconcileKey(order.app_id, order.biz_type, order.biz_ref),
    });
  } else {
    const anomaly = await addAnomalyRefundedFen(
      trx,
      refund.app_id,
      target.anomaly.id,
      refund.amount_fen,
    );
    if (anomaly === undefined) throw new PayRefundConflict(refund.id);
    await deps.ledger.post(trx, anomalyRefundVoucher(anomaly, succeeded));
    // D10-351 ①: no recovery job — an anomaly receipt (money on a CLOSED order or on no order of
    // ours) never fulfilled a business object, so there is nothing to recompute.
  }
  const facts = targetFacts(target);
  const payload: PayRefundSucceededPayload = {
    pay_refund_id: succeeded.id,
    target_type: succeeded.target_type as PayRefundTargetType,
    target_id: succeeded.target_id,
    pay_channel: facts.payChannel,
    amount_fen: fenToJsonNumber(succeeded.amount_fen),
  };
  await deps.events.publish(trx, {
    appId: succeeded.app_id,
    name: PAY_REFUND_SUCCEEDED_EVENT,
    payload: { ...payload },
  });
  deps.logger.info(
    {
      app_id: succeeded.app_id,
      pay_refund_id: succeeded.id,
      out_refund_no: succeeded.out_refund_no,
      target_type: succeeded.target_type,
      target_id: succeeded.target_id,
      pay_channel: facts.payChannel,
      amount_fen: succeeded.amount_fen.toString(),
      source: report.source,
    },
    'pay_refund_succeeded',
  );
}

/** RF3: the status CAS only; the held amount is free again (BR-PAY-06 ⑤ FAILED 时释放占用的额度). */
async function failRefund(
  deps: PaySettlementDeps,
  trx: Transaction<DB>,
  refund: PayRefundRow,
  report: PayRefundReport,
): Promise<void> {
  const move = transitionPayRefund(refund.status as PayRefundState, 'REFUND_FAILED');
  if (!move.ok || move.to !== 'FAILED') throw new PayRefundConflict(refund.id);
  const failed = await markRefundFailed(
    trx,
    refund.app_id,
    refund.id,
    report.channelRefundNo,
    deps.clock.now(),
  );
  if (failed === undefined) throw new PayRefundConflict(refund.id);
  deps.logger.warn(
    {
      app_id: failed.app_id,
      pay_refund_id: failed.id,
      out_refund_no: failed.out_refund_no,
      channel_state: report.channelState,
      source: report.source,
    },
    'pay_refund_failed',
  );
}

/**
 * The one result handler (BR-PAY-06 ④ ⑤) on the caller's transaction: see the header. Throws
 * PayRefundConflict when the CAS changed no row (the caller rolls back and answers «not success» /
 * fails the job, so the channel re-sends or the next query comes); the other errors are our own.
 */
export async function handleRefundReport(
  deps: PaySettlementDeps,
  trx: Transaction<DB>,
  report: PayRefundReport,
): Promise<PayRefundOutcome> {
  const none: PayRefundOutcome = {
    verdict: { kind: 'rejected' },
    payRefundId: null,
    targetType: null,
    targetId: null,
  };
  if (!report.ours) return none;
  const states = await refundStatesFor(deps, report.appId, report.channel);
  const found = await findRefundByOutRefundNo(trx, report.appId, report.outRefundNo);
  if (found === undefined) {
    return { ...none, verdict: { kind: 'mismatch', reason: 'refund_not_found' } };
  }
  const { refund, target } = await lockTarget(trx, found);
  const facts = targetFacts(target);
  const verdict = judgeRefundResult({
    ours: true,
    refund: {
      status: refund.status as PayRefundState,
      payChannel: facts.payChannel,
      amountFen: refund.amount_fen,
      targetOutTradeNo: facts.outTradeNo,
      targetChannelTradeNo: facts.channelTradeNo,
    },
    channel: report.channel,
    outTradeNo: report.outTradeNo,
    channelTradeNo: report.channelTradeNo,
    refundFen: report.refundFen,
    channelState: report.channelState,
    successStates: states.success,
    failStates: states.fail,
  });
  switch (verdict.kind) {
    case 'succeed':
      await succeedRefund(deps, trx, refund, target, report);
      break;
    case 'fail':
      await failRefund(deps, trx, refund, report);
      break;
    case 'already_final':
    case 'mismatch':
    case 'rejected':
      break;
  }
  return {
    verdict,
    payRefundId: refund.id,
    targetType: refund.target_type as PayRefundTargetType,
    targetId: refund.target_id,
  };
}
