// B2-15b: the collection channel port (08 BR-PAY-03 / 04 / 05; task §9.6). Unrelated to payout's
// PayoutChannel. Every channel answer is ok or unknown, never «failed»: an unknown result is only
// queried, never resubmitted under another number (payment/AGENTS.md rule 7). Only createOrder,
// query and close are used by this task; the rest is typed here for B2-15c / B2-15f / B2-15k.
// Field names of the launch parameters follow the official SDK documentation and are 待实测
// (WeChat Pay CAP-X-16, Alipay CAP-X-17; contracts/openapi.yaml PayLaunch).
// Also compiled by the `test` project: erasable syntax only (no parameter properties).
import type { PayChannelCode } from '../domain/types.ts';

/** B2-15k: every call of a channel without complete credentials (BR-PAY-08 ②; 下单 50306). */
export const PAY_REASON_CHANNEL_UNCONFIGURED = 'channel_unconfigured';
/**
 * B2-15k: a bill downloaded whose file format no document gives (task §9.7): nothing parsed until a
 * real sample arrives, so the reconciliation of that bill day does not run (application/pay-recon.ts).
 */
export const PAY_REASON_BILL_FORMAT_UNVERIFIED = 'bill_format_unverified';
/**
 * B2-15k, ruling D10-554: prod reads no key file (BR-PAY-08 ②: KMS only). B1-30a: a prod channel
 * whose keys cannot be read from KMS, or any channel when KMS is not configured, answers this on
 * every call. 下单 50306.
 */
export const PAY_REASON_KMS_UNAVAILABLE = 'kms_unavailable';
/**
 * B2-15k: the channel's verified answer that the day has no bill, only as its document writes it:
 * WeChat Pay HTTP 400 NO_STATEMENT_EXIST, Alipay 40004 NO_BILL_DATA. No bill, never an empty bill:
 * the reconciliation of that day does not run (application/pay-recon.ts).
 */
export const PAY_REASON_BILL_NOT_AVAILABLE = 'bill_not_available';
/**
 * B2-15r: every call FakePayChannel does not support. For a bill it means no bill now and no bill an
 * hour later (staging, D10-549 ⑥), so the reconciliation skips that channel (application/pay-recon.ts).
 */
export const PAY_REASON_FAKE_NOT_SUPPORTED = 'fake_not_supported';
/** B2-15k: an order of another App than the one this channel's merchant identity belongs to. */
export const PAY_REASON_APP_NOT_CONFIGURED = 'app_not_configured';

/** WeChat Pay APP payment: the SDK's PayReq fields, signed by the server (contract PayLaunchWechatPay). */
export interface WechatLaunch {
  readonly appid: string;
  readonly partnerid: string;
  readonly prepayid: string;
  readonly package: string;
  readonly noncestr: string;
  readonly timestamp: string;
  readonly sign: string;
}

/** Alipay App payment: the complete signed order string (contract PayLaunchAlipay). */
export interface AlipayLaunch {
  readonly order_str: string;
}

export type PayLaunch = WechatLaunch | AlipayLaunch;

/** What is sent to the channel when an order is placed (外部写先落单: the row exists first). */
export interface PayCreateOrderInput {
  readonly outTradeNo: string;
  /** Integer fen; the adapter converts to yuan through @couli/money only. */
  readonly amountFen: bigint;
  /** The business type's title. */
  readonly description: string;
  /** The pay deadline given to the channel: never later than the order's expire_at. */
  readonly expireAt: Date;
  readonly notifyUrl: string;
  /**
   * B2-15k: the order's app_id. A real adapter answers unknown / app_not_configured without calling
   * the channel when it is not the app of its merchant identity: another App's money never lands
   * in this merchant account. Optional, so that direct callers of a fake channel stand.
   */
  readonly appId?: string;
}

export type PayCreateOrderResult =
  | { readonly kind: 'ok'; readonly launch: PayLaunch; readonly channelRef: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** Trade state as the channel reports it (orchestrator ruling D10-236 ③ adds unknown as a kind). */
export type PayTradeState = 'paid' | 'not_paid' | 'closed' | 'not_exist';

export type PayQueryResult =
  | {
      readonly kind: 'ok';
      readonly state: PayTradeState;
      readonly channelTradeNo: string | null;
      readonly amountFen: bigint | null;
      /**
       * B2-15c: the channel's own trade state as reported (WeChat trade_state, Alipay
       * trade_status), judged against `pay.<pay_channel>.success_states` (BR-PAY-04). A result
       * without it, or without merchantRef / appRef, never counts as paid (fail closed).
       */
      readonly channelState?: string;
      /** B2-15c: the merchant identity the channel reports (WeChat mchid, Alipay seller_id). */
      readonly merchantRef?: string;
      /** B2-15c: the application identity the channel reports (WeChat appid, Alipay app_id). */
      readonly appRef?: string;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * B2-15c: the merchant and application identity a notification or query carries (BR-PAY-04 核对
 * ①). Which app of ours it belongs to comes from the channel configuration only
 * (PayChannel.ownerAppOf); a notification never names our app_id itself.
 */
export interface PayChannelIdentity {
  readonly merchantRef: string;
  readonly appRef: string;
}

export type PayCloseResult =
  | { readonly kind: 'ok'; readonly state: 'closed' | 'paid' | 'not_exist' }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * B2-15e: one original-route refund as sent to the channel (BR-PAY-06). The refund goes back the
 * way the money came: the original is named by our merchant number and / or the channel's trade
 * number (an anomaly receipt may have no merchant number of ours, BR-PAY-05 ④).
 */
export interface PayRefundInput {
  /** The original's out_trade_no; null for an anomaly receipt without one. */
  readonly outTradeNo: string | null;
  /** The original's channel trade number (pay_orders / pay_anomalies channel_trade_no). */
  readonly channelTradeNo: string | null;
  /** pay_refunds.out_refund_no: generated at creation, never changed, never reused. */
  readonly outRefundNo: string;
  /** This refund's amount, integer fen. */
  readonly refundFen: bigint;
  /** The original's total: the pay order's amount_fen, or the anomaly's received amount_fen. */
  readonly totalFen: bigint;
  /** pay_refunds.reason_code. */
  readonly reason: string;
}

/**
 * B2-15k: the original of a refund, as the refund row knows it. Alipay's refund query needs it
 * (docs-mirror/alipay/app-pay/01dcc0.md: trade_no, out_trade_no and out_request_no must agree with
 * the refund); WeChat Pay's does not. Optional, so that the fake channel and earlier tests stand.
 */
export interface PayRefundOriginal {
  readonly outTradeNo: string | null;
  readonly channelTradeNo: string | null;
}

/** ok: the channel accepted the request (the result comes later); never «failed» (rule 7). */
export type PayRefundResult =
  { readonly kind: 'ok' } | { readonly kind: 'unknown'; readonly reason: string };

export type PayRefundQueryResult =
  | {
      readonly kind: 'ok';
      readonly state: 'success' | 'processing' | 'failed' | 'not_exist';
      readonly refundFen: bigint | null;
      /**
       * B2-15e: the channel's own refund state as reported (WeChat status / refund_status, Alipay
       * refund_status), judged against `pay.<pay_channel>.refund_success_states` and
       * `refund_fail_states` (BR-PAY-06 ④). `state` above is the adapter's summary only and never
       * decides. A result without channelState, merchantRef or appRef is never a result (fail closed).
       */
      readonly channelState?: string;
      /** B2-15e: the original's merchant number as the channel reports it. */
      readonly outTradeNo?: string | null;
      /** B2-15e: the original's channel trade number as the channel reports it. */
      readonly channelTradeNo?: string | null;
      /** B2-15e: the channel's refund number (pay_refunds.channel_refund_no). */
      readonly channelRefundNo?: string | null;
      /** B2-15e: the merchant identity the channel reports (WeChat mchid, Alipay seller_id). */
      readonly merchantRef?: string;
      /** B2-15e: the application identity the channel reports (WeChat appid, Alipay app_id). */
      readonly appRef?: string;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

/** A notification as received on /notify/pay/<pay_channel> (B2-15c). */
export interface PayRawNotification {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * B2-15c (task §9.1): a notification after the adapter verified it (WeChat: APIv3 signature, then
 * AES-256-GCM decryption of resource; Alipay: the form signature) and read its fields. Nothing of
 * a rejected notification is trusted or kept. amountFen is the channel's order total, converted
 * without floating point (Alipay total_amount is yuan text). state is the channel's own value.
 */
export type PayNotificationResult =
  | {
      readonly kind: 'ok';
      /** The channel's notification id (WeChat id, Alipay notify_id): the dedupe key. */
      readonly notifyId: string;
      readonly outTradeNo: string | null;
      readonly outRefundNo: string | null;
      readonly channelTradeNo: string;
      readonly amountFen: bigint;
      readonly state: string;
      readonly merchantRef: string;
      readonly appRef: string;
      /**
       * B2-15e: a refund notification (outRefundNo set) also carries the refunded amount (WeChat
       * amount.refund, Alipay refund_fee) — amountFen stays the original's total — and the
       * channel's refund number; `state` is then the channel's refund state. A refund
       * notification without refundFen is never a result (fail closed).
       */
      readonly refundFen?: bigint;
      readonly channelRefundNo?: string;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

export type PayBillResult =
  | { readonly kind: 'ok'; readonly rows: readonly Readonly<Record<string, string>>[] }
  | { readonly kind: 'unknown'; readonly reason: string };

/** One collection channel (BR-PAY-03 PayChannel 接口; real adapters B2-15k, fake for tests). */
export interface PayChannel {
  readonly channel: PayChannelCode;
  createOrder(input: PayCreateOrderInput): Promise<PayCreateOrderResult>;
  query(outTradeNo: string): Promise<PayQueryResult>;
  close(outTradeNo: string): Promise<PayCloseResult>;
  refund(input: PayRefundInput): Promise<PayRefundResult>;
  refundQuery(outRefundNo: string, original?: PayRefundOriginal): Promise<PayRefundQueryResult>;
  verifyNotification(raw: PayRawNotification): Promise<PayNotificationResult>;
  /**
   * B2-15c: our app_id of a merchant / application identity, from this channel's configuration;
   * null when the identity is not ours (BR-PAY-04 核对 ①: reject, count, alert, no trace).
   */
  ownerAppOf(identity: PayChannelIdentity): string | null;
  /**
   * The channel's bill of one accounting day (YYYY-MM-DD, +08:00) for one app of ours (B2-15j):
   * the bill of the merchant / application identity this channel's configuration holds for
   * `appId`, never the bill of another app's identity. Rows are normalised to domain/pay-recon.ts
   * PayBillRow; a row may also carry the identity it belongs to (merchant_ref / app_ref), and the
   * reconciliation then keeps it only when ownerAppOf(identity) is `appId`.
   */
  downloadBill(date: string, appId: string): Promise<PayBillResult>;
}

/** Thrown by PayChannelSet.of for a channel the process has no adapter for (fail closed). */
export class PayChannelUnavailable extends Error {
  readonly channel: PayChannelCode;

  constructor(channel: PayChannelCode) {
    super(`payment: no ${channel} channel adapter in this process`);
    this.name = 'PayChannelUnavailable';
    this.channel = channel;
  }
}

/**
 * The channels of the process, and the Nest injection token of them (a class token, so that the
 * rule tests can override it: `overrideProvider(PayChannelSet).useValue({ of })`). The payment
 * module provides it (`provide: PayChannelSet`) through infra/channels createPayChannelSet (B2-15k):
 * fake channels, real adapters, or unavailable channels that fail closed (payment/AGENTS.md rule 6).
 */
export class PayChannelSet {
  readonly #channels: ReadonlyMap<PayChannelCode, PayChannel>;

  constructor(channels: readonly PayChannel[] = []) {
    this.#channels = new Map(channels.map((channel) => [channel.channel, channel]));
  }

  of(channel: PayChannelCode): PayChannel {
    const found = this.#channels.get(channel);
    if (found === undefined) throw new PayChannelUnavailable(channel);
    return found;
  }
}
