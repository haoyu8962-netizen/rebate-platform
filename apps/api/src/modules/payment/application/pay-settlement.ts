// B2-15c: what a notification and a query share once the checks of BR-PAY-04 passed (task §9.3
// ～ §9.6; 08 BR-PAY-04, BR-PAY-05 ④, BR-PAY-07; D10-168, D-PAY-11).
//
// settlePendingOrder — PO2 on the caller's transaction, which holds the business object lock and
//   has just re-read the order: the generated transition() names the move, the store's CAS makes
//   it (0 rows → PaySettlementConflict, the caller rolls back and answers «not success» so the
//   channel re-sends or the next query comes), then the PAY_RECEIPT voucher through ledger's post
//   (借 CASH_PAY:{pay_channel} / 贷 PAY_RECEIPTS:{biz_type}, platform subjects only, uniq key
//   PAY_RECEIPT:<pay_order_id>: at most one per order, BR-PAY-07), the business object's
//   fulfilment job (queue pay, biz.reconcile, singletonKey biz:<app_id>:<biz_type>:<biz_ref>: serial per
//   object) and the pay_order.paid event — all on that one transaction, so a failure anywhere
//   leaves nothing behind (BR-PAY-04 细则 应答表 last row).
// registerAnomalyReceipt — BR-PAY-05 ④: one pay_anomalies row per (channel, channel trade
//   number), its PAY_ANOMALY voucher (借 CASH_PAY:{pay_channel} / 贷 PAY_SUSPENSE, uniq key
//   PAY_ANOMALY:<pay_anomaly_id>) and the R4 pay_anomaly recon diff of the accounting day; never a
//   PO2, never a fulfilment. Repeats find the row, post a duplicate and register nothing more.
// Amounts stay bigint fen; the only yuan conversion lives in the real adapters (B2-15k). No user
// account is touched anywhere here (payment/AGENTS.md rule 1).
// Also compiled by the `test` project (through jobs/pay-jobs.ts): erasable syntax only.
import type { DB } from '@couli/db';
import { accountingDate, transitionPayOrder, type PayOrderState } from '@couli/domain';
import { subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { PostingResult, PostingVoucher, RegisterReconDiffInput } from '../../ledger/index.ts';
import {
  newUuidV7,
  type Clock,
  type EventBus,
  type JobQueue,
  type RootLogger,
} from '../../platform/index.ts';
import { successStatesOf } from '../domain/pay-result.ts';
import type { PayChannelCode } from '../domain/types.ts';
import {
  markPaid,
  registerAnomalyRow,
  type PayAnomalyRow,
  type PayOrderRow,
} from '../infra/pay-order-store.ts';
import {
  BIZ_RECONCILE_JOB,
  PAY_QUEUE,
  bizReconcileKey,
  type BizReconcilePayload,
} from '../jobs/names.ts';

/** ledger's posting and recon diff registration, on the caller's transaction (BR-PAY-07). */
export interface PayLedgerPort {
  post(trx: Transaction<DB>, voucher: PostingVoucher): Promise<PostingResult>;
  registerReconDiff(
    trx: Transaction<DB>,
    input: RegisterReconDiffInput,
  ): Promise<{ readonly id: string }>;
  /**
   * B2-15n: the same registration (ledger registerReconDiffOnce), telling whether this call
   * inserted the diff (the reconciliation alerts pay_recon_mismatch only then). Optional: a port
   * without it (an older wiring) registers through registerReconDiff and every registration counts
   * as new, as before B2-15n. The worker's port (payment.module.ts) always has it.
   */
  registerReconDiffOnce?(
    trx: Transaction<DB>,
    input: RegisterReconDiffInput,
  ): Promise<{ readonly row: { readonly id: string }; readonly inserted: boolean }>;
}

export interface PaySettlementDeps {
  readonly clock: Clock;
  /** content's configuration reader (pay.<pay_channel>.success_states, pay.query_schedule). */
  readonly config: Pick<ContentReader, 'configValue'>;
  readonly queue: JobQueue;
  readonly events: EventBus;
  readonly ledger: PayLedgerPort;
  readonly logger: RootLogger;
}

/** platform/events EVENT_NAMES entry published on PO2 (02 §11 addition of B2-15c). */
export const PAY_ORDER_PAID_EVENT = 'pay_order.paid';
/** The operator of every voucher payment posts. */
export const PAY_OPERATOR = 'system:payment';
export const QUERY_SCHEDULE_KEY = 'pay.query_schedule';
export function successStatesKey(channel: PayChannelCode): string {
  return `pay.${channel}.success_states`;
}

/** Where the judged facts came from (logged, kept as anomaly evidence). */
export type PayResultSource = 'notify' | 'query';

/** The CAS of PO2 changed no row: another judgement moved the order first (BR-PAY-02). */
export class PaySettlementConflict extends Error {
  readonly payOrderId: string;

  constructor(payOrderId: string) {
    super('payment: the pay order left PENDING before this settlement');
    this.name = 'PaySettlementConflict';
    this.payOrderId = payOrderId;
  }
}

/** The raw config_items value of a key; null when the key does not exist. */
export async function rawConfigValue(
  config: Pick<ContentReader, 'configValue'>,
  appId: string,
  key: string,
): Promise<unknown> {
  const item = await config.configValue(appId, key);
  return item === null ? null : item.value;
}

/** `pay.<pay_channel>.success_states` in effect; a broken value alerts once and falls back. */
export async function successStatesFor(
  deps: Pick<PaySettlementDeps, 'config' | 'logger'>,
  appId: string,
  channel: PayChannelCode,
): Promise<readonly string[]> {
  const states = successStatesOf(
    channel,
    await rawConfigValue(deps.config, appId, successStatesKey(channel)),
  );
  if (states.fallback) {
    deps.logger.warn(
      { app_id: appId, pay_channel: channel, key: successStatesKey(channel) },
      'pay_success_states_invalid',
    );
  }
  return states.states;
}

/** The PAY_RECEIPT voucher of a paid order (BR-PAY-07; specs/ledger-rules.md 第 10 节). */
export function receiptVoucher(order: PayOrderRow): PostingVoucher {
  return {
    appId: order.app_id,
    uniqKey: `PAY_RECEIPT:${order.id}`,
    bizType: 'pay_order',
    bizId: order.id,
    operator: PAY_OPERATOR,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'PAY_RECEIPT',
    entries: [
      {
        account: { ownerType: 'platform', subject: `CASH_PAY:${order.pay_channel}` },
        sub_account: 'available',
        amount_fen: order.amount_fen,
        ledger_type: 'PAY_RECEIPT',
        sub_type: order.pay_channel,
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: `PAY_RECEIPTS:${order.biz_type}` },
        sub_account: 'available',
        amount_fen: -order.amount_fen,
        ledger_type: 'PAY_RECEIPT',
        sub_type: order.pay_channel,
        income_type: null,
      },
    ],
  };
}

/** The PAY_ANOMALY voucher of an anomaly receipt (BR-PAY-07; specs/ledger-rules.md 第 10 节). */
export function anomalyVoucher(anomaly: PayAnomalyRow): PostingVoucher {
  return {
    appId: anomaly.app_id,
    uniqKey: `PAY_ANOMALY:${anomaly.id}`,
    bizType: 'pay_anomaly',
    bizId: anomaly.id,
    operator: PAY_OPERATOR,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'PAY_ANOMALY',
    entries: [
      {
        account: { ownerType: 'platform', subject: `CASH_PAY:${anomaly.pay_channel}` },
        sub_account: 'available',
        amount_fen: anomaly.amount_fen,
        ledger_type: 'PAY_ANOMALY',
        sub_type: anomaly.pay_channel,
        income_type: null,
      },
      {
        account: { ownerType: 'platform', subject: 'PAY_SUSPENSE' },
        sub_account: 'available',
        amount_fen: -anomaly.amount_fen,
        ledger_type: 'PAY_ANOMALY',
        sub_type: anomaly.pay_channel,
        income_type: null,
      },
    ],
  };
}

export interface SettlementInput {
  /** The channel's trade number of the payment (WeChat transaction_id, Alipay trade_no). */
  readonly channelTradeNo: string;
  readonly source: PayResultSource;
}

/**
 * PO2 and everything BR-PAY-04 puts in the same transaction, for an order the caller re-read as
 * PENDING under the business object lock. Returns the order as PAID.
 */
export async function settlePendingOrder(
  deps: PaySettlementDeps,
  trx: Transaction<DB>,
  order: PayOrderRow,
  input: SettlementInput,
): Promise<PayOrderRow> {
  const move = transitionPayOrder(order.status as PayOrderState, 'PAY_SUCCESS');
  if (!move.ok || move.to !== 'PAID') throw new PaySettlementConflict(order.id);
  const now = deps.clock.now();
  const paid = await markPaid(trx, order.app_id, order.id, input.channelTradeNo, now);
  if (paid === undefined) throw new PaySettlementConflict(order.id);
  // duplicate: the voucher exists already (a settlement that committed concurrently is excluded
  // by the lock and the CAS, so this is only a replay of this very order's receipt).
  await deps.ledger.post(trx, receiptVoucher(paid));
  const payload: BizReconcilePayload = {
    app_id: paid.app_id,
    biz_type: paid.biz_type,
    biz_ref: paid.biz_ref,
    pay_order_id: paid.id,
  };
  await deps.queue.send(PAY_QUEUE, BIZ_RECONCILE_JOB, payload, {
    trx,
    singletonKey: bizReconcileKey(paid.app_id, paid.biz_type, paid.biz_ref),
  });
  await deps.events.publish(trx, {
    appId: paid.app_id,
    name: PAY_ORDER_PAID_EVENT,
    payload: {
      pay_order_id: paid.id,
      biz_type: paid.biz_type,
      biz_ref: paid.biz_ref,
      pay_channel: paid.pay_channel,
    },
  });
  deps.logger.info(
    {
      app_id: paid.app_id,
      pay_order_id: paid.id,
      pay_channel: paid.pay_channel,
      biz_type: paid.biz_type,
      source: input.source,
    },
    'pay_order_paid',
  );
  return paid;
}

export interface AnomalyReceiptInput {
  readonly appId: string;
  readonly payChannel: PayChannelCode;
  readonly channelTradeNo: string;
  readonly outTradeNo: string;
  /** The CLOSED order the money names, or null when no order of ours has the number. */
  readonly payOrderId: string | null;
  /** The channel's reported total (the amount received, BR-PAY-05 ④ 「金额以通知为准」). */
  readonly amountFen: bigint;
  readonly channelState: string;
  readonly source: PayResultSource;
  /** The kept notification's id or the query attempt's id: the evidence pointer. */
  readonly evidenceRef: string;
}

/**
 * BR-PAY-05 ④ on the caller's transaction: the anomaly row (once per channel trade number), its
 * PAY_ANOMALY voucher, the R4 pay_anomaly recon diff and the alert. The recon diff and the alert
 * belong to the first registration only: a repeat (the channel re-sending the notification, a
 * later query of the same CLOSED order, on any later accounting day) finds the row, posts a
 * duplicate and registers nothing more — the recon diff's period is the anomaly row's own
 * accounting date and its dedupe key names the anomaly, so even a replay that reached it would
 * get the existing diff back. No fulfilment, no event, no PO2.
 */
export async function registerAnomalyReceipt(
  deps: PaySettlementDeps,
  trx: Transaction<DB>,
  input: AnomalyReceiptInput,
): Promise<{ readonly anomaly: PayAnomalyRow; readonly created: boolean }> {
  const now = deps.clock.now();
  const { anomaly, created } = await registerAnomalyRow(trx, {
    id: newUuidV7(now),
    appId: input.appId,
    payChannel: input.payChannel,
    channelTradeNo: input.channelTradeNo,
    outTradeNo: input.outTradeNo,
    payOrderId: input.payOrderId,
    amountFen: input.amountFen,
    evidence: {
      source: input.source,
      evidence_ref: input.evidenceRef,
      out_trade_no: input.outTradeNo,
      channel_trade_no: input.channelTradeNo,
      channel_state: input.channelState,
      amount_fen: input.amountFen.toString(),
      pay_order_id: input.payOrderId,
      observed_at: now.toISOString(),
    },
    createdAt: now,
  });
  await deps.ledger.post(trx, anomalyVoucher(anomaly));
  const fields = {
    app_id: anomaly.app_id,
    pay_channel: anomaly.pay_channel,
    pay_anomaly_id: anomaly.id,
    pay_order_id: anomaly.pay_order_id,
    out_trade_no: anomaly.out_trade_no,
    amount_fen: anomaly.amount_fen.toString(),
    source: input.source,
  };
  if (!created) {
    // Registered before: nothing more to book or to alert (ids only, never the original).
    deps.logger.info(fields, 'pay_anomaly_receipt_repeat');
    return { anomaly, created };
  }
  await deps.ledger.registerReconDiff(trx, {
    appId: anomaly.app_id,
    type: 'pay_anomaly',
    source: 'R4',
    period: accountingDate(anomaly.created_at),
    refType: 'pay_anomaly',
    refId: anomaly.id,
    expectedFen: 0n,
    actualFen: anomaly.amount_fen,
    // diff_fen = expected − actual (contract AdminPayReconDiff; D10-358 ①, D10-360): −received.
    diffFen: subFen(0n, anomaly.amount_fen),
    dedupeKey: `pay_anomaly:${anomaly.id}`,
    resolution: null,
  });
  // The alert (BR-PAY-05 ④ 告警): ids and our merchant number only, never the original.
  deps.logger.warn(fields, 'pay_anomaly_receipt');
  return { anomaly, created };
}
