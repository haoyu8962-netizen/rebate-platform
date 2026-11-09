// B2-15b: the four user-side pay order use cases (contract createPayOrder, getPayOrder,
// payOrderReturned, cancelPayOrder; 08 BR-PAY-01 ～ 05; task §9.4 ～ §9.9; rulings D10-236 ④,
// D10-245; review §12.1 / §12.2). The controllers (http/public/) only authenticate, take the
// parameters and call these; request-level idempotency (x-idempotent, subject u:<user_id>) is
// platform's and wraps createPayOrder in the controller.
//
// createPayOrder, in order:
//   switches and sellability (domain/sellability.ts) → 30901 data.reason; nothing is written;
//   transaction ①: pg_advisory_xact_lock(hashtextextended('payment.biz:' || app_id || ':' ||
//   biz_type || ':' || biz_ref, 0)), then re-read the object's PENDING / PAID orders:
//     a PAID or PENDING order of another user → 20902 data.resource=pay_order, nothing of that
//     order is returned, no channel call (§12.1); the caller's PAID → 30902 data.pay_order_id;
//     the caller's PENDING on another channel, with closing=true, or past its expire_at (now >=
//     expire_at counts as closing: BR-PAY-03, no launch for an expired order) → 20902; the
//     caller's PENDING on the same channel → that order again; none → INSERT PENDING (out_trade_no from
//     domain/out-trade-no.ts, amount and title from the registry, expire_at = now + ttl) with the
//     first scheduled query of `pay.query_schedule` enqueued on the same transaction (B2-15c,
//     BR-PAY-04: queue pay, order.query, singletonKey order.query:<id>:t<seconds>, delaySeconds to
//     the first slot; the payload names the order by out_trade_no, jobs/names.ts) and commit: the
//     row exists before the channel is called (外部写先落单);
//   the channel call, outside any transaction (ok / unknown only; a throwing adapter is unknown);
//   transaction ②: the same lock, one pay_query_attempts row (kind 'query', result 'prepay' /
//   'unknown'); unknown → 50306 data.pay_channel, the order stays PENDING; ok → launch_issued_at
//   = now by a CAS on «PENDING, closing=false and expire_at > now» (markLaunchIssued): 0 rows
//   (cancel won the race, or the order expired during the channel call) → 20902 and the launch
//   parameters are dropped, so once closing or expired no launch is ever returned (BR-PAY-03,
//   §12.2). cancelPayOrder's CAS (markClosing) checks only «PENDING and closing=false»: an
//   expired PENDING order can still be cancelled, which is how a user frees the business object
//   for another channel before B2-15d's expiry job runs.
// Launch parameters never reach a log line or a row of payment's tables (pay_query_attempts keeps
// summaries only); they are part of the response, which platform idempotency's standard mode
// stores in idempotency_keys with the first answer and replays byte for byte to the same
// Idempotency-Key for its retention (30 days) — so a replay needs no channel call and touches no
// payment row. B2-15y (BR-PAY-03): those stored launch parameters are replayed only while the order
// can still be launched; replayRefusal reads the order under the business object lock, the one
// closing takes. The order never carries a channel-side user id; no ledger posting happens here
// (payment/AGENTS.md rules 1, 6).
import type { DB } from '@couli/db';
import type { Schema } from '@couli/contracts-ts';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import { newUuidV7, type Clock, type JobQueue, type RootLogger } from '../../platform/index.ts';
import { isPayOrderExpired, orderTtlMinutes, payOrderExpireAt } from '../domain/order-ttl.ts';
import { generateOutTradeNo } from '../domain/out-trade-no.ts';
import {
  delaySecondsUntil,
  nextQueryInstant,
  queryInstants,
  queryScheduleOf,
  querySlotSeconds,
} from '../domain/pay-result.ts';
import { payUnavailableReason, platformsOverrideOf } from '../domain/sellability.ts';
import type { PayChannelCode, PayOrderStatus, PayUnavailableReason } from '../domain/types.ts';
import {
  bizObjectLockKey,
  findOpenOrders,
  findOrderById,
  findOwnOrder,
  insertPendingOrder,
  insertQueryAttempt,
  lockBizObject,
  markClosing,
  markLaunchIssued,
  type BizObjectKey,
  type PayOrderRow,
} from '../infra/pay-order-store.ts';
import {
  ORDER_CLOSE_JOB,
  ORDER_QUERY_JOB,
  PAY_QUEUE,
  orderCloseKey,
  orderQueryReturnedKey,
  orderQueryScheduledKey,
  type OrderClosePayload,
  type OrderQueryPayload,
  type OrderQueryScheduledPayload,
} from '../jobs/names.ts';
import type { BizTypeRegistry } from './biz-registry.ts';
import type { PayChannelSet, PayCreateOrderInput, PayCreateOrderResult } from './pay-channel.ts';
import { NOTIFY_ROUTES } from './notify-routes.ts';
import { QUERY_SCHEDULE_KEY } from './pay-settlement.ts';

/** The caller: from the access token, and the request's X-Platform. */
export interface PaySubject {
  readonly app_id: string;
  readonly user_id: string;
  readonly platform: string;
}

export interface PayOrderDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: Pick<ContentReader, 'configValue'>;
  readonly queue: JobQueue;
  readonly channels: Pick<PayChannelSet, 'of'>;
  readonly registry: BizTypeRegistry;
  readonly logger: RootLogger;
}

export type PayFailure =
  | { readonly code: 30901; readonly data: { readonly reason: PayUnavailableReason } }
  | { readonly code: 30902; readonly data: { readonly pay_order_id: string } }
  | { readonly code: 20902; readonly data: { readonly resource: 'pay_order' } }
  | { readonly code: 50306; readonly data: { readonly pay_channel: PayChannelCode } }
  | { readonly code: 30701 };

export type PayResult<T> = { readonly code: 0; readonly data: T } | PayFailure;

/** Config keys of BR-PAY-01 ④ and BR-PAY-03 (content's config_items, read through ContentReader). */
export const PAY_ENABLED_KEY = 'pay.enabled';
export const ORDER_TTL_KEY = 'pay.order_ttl_minutes';
export function channelEnabledKey(channel: PayChannelCode): string {
  return `pay.channel_enabled.${channel}`;
}
export function bizPlatformsKey(bizType: string): string {
  return `pay.biz.${bizType}.platforms`;
}

/** The notification path of a channel (specs/pay-notify.md); the public base URL joins in B2-15k. */
export function notifyPathOf(channel: PayChannelCode): string {
  return NOTIFY_ROUTES[channel];
}

const CONFLICT: PayFailure = Object.freeze({
  code: 20902,
  data: Object.freeze({ resource: 'pay_order' as const }),
});
const NOT_FOUND: PayFailure = Object.freeze({ code: 30701 });

/** The contract PayOrder of a row: instants as ISO strings, fen as JSON integers, no channel-side ids. */
export function payOrderView(row: PayOrderRow): Schema<'PayOrder'> {
  return {
    pay_order_id: row.id,
    biz_type: row.biz_type,
    biz_ref: row.biz_ref,
    pay_channel: row.pay_channel as PayChannelCode,
    amount_fen: fenToJsonNumber(row.amount_fen),
    refunded_fen: fenToJsonNumber(row.refunded_fen),
    status: row.status as PayOrderStatus,
    expire_at: row.expire_at.toISOString(),
    paid_at: row.paid_at === null ? null : row.paid_at.toISOString(),
    closed_at: row.closed_at === null ? null : row.closed_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

function bizKeyOf(row: Pick<PayOrderRow, 'app_id' | 'biz_type' | 'biz_ref'>): BizObjectKey {
  return { appId: row.app_id, bizType: row.biz_type, bizRef: row.biz_ref };
}

/** The raw config_items value of a key; null when the key does not exist. */
async function rawConfig(deps: PayOrderDeps, appId: string, key: string): Promise<unknown> {
  const config = await deps.config.configValue(appId, key);
  return config === null ? null : config.value;
}

type Placement =
  | { readonly kind: 'failed'; readonly failure: PayFailure }
  | { readonly kind: 'placed'; readonly order: PayOrderRow; readonly created: boolean };

/** POST /v1/pay/orders. */
export async function createPayOrder(
  deps: PayOrderDeps,
  subject: PaySubject,
  input: Schema<'CreatePayOrderRequest'>,
): Promise<PayResult<Schema<'CreatePayOrderData'>>> {
  const appId = subject.app_id;
  const userId = subject.user_id;
  const channel = input.pay_channel;
  const bizType = input.biz_type;
  const entry = deps.registry.get(bizType);
  const [payEnabled, channelEnabled, platformsRaw] = await Promise.all([
    rawConfig(deps, appId, PAY_ENABLED_KEY),
    rawConfig(deps, appId, channelEnabledKey(channel)),
    entry === undefined ? Promise.resolve(null) : rawConfig(deps, appId, bizPlatformsKey(bizType)),
  ]);
  if (entry !== undefined && platformsOverrideOf(platformsRaw).fallback) {
    // §12.5: a bad `pay.biz.<biz_type>.platforms` falls back to the registered platforms, once alerted.
    deps.logger.warn(
      { app_id: appId, biz_type: bizType, key: bizPlatformsKey(bizType) },
      'pay_biz_platforms_invalid',
    );
  }
  const reason = payUnavailableReason({
    payEnabled,
    channelEnabled,
    platform: subject.platform,
    registeredPlatforms: entry === undefined ? null : entry.platforms,
    platformsOverride: platformsRaw,
  });
  if (reason !== null || entry === undefined) {
    return { code: 30901, data: { reason: reason ?? 'biz_not_sellable' } };
  }
  // B2-15z (D10-1030 ②): the object must be the caller's, before its price and before any write.
  // Not told apart from an unsellable object, so the answer does not reveal who owns what; a hook
  // that throws fails closed (50001, no order).
  if (!(await entry.ownedBy({ appId, userId, bizRef: input.biz_ref }))) {
    return { code: 30901, data: { reason: 'biz_not_sellable' } };
  }
  // The adapter of the channel: resolved before anything is written, so a process without it
  // fails closed without an order (payment/AGENTS.md rule 6).
  const payChannel = deps.channels.of(channel);
  const price = await entry.price({ appId, userId, bizRef: input.biz_ref });
  const ttl = orderTtlMinutes(await rawConfig(deps, appId, ORDER_TTL_KEY));
  if (ttl.fallback)
    deps.logger.warn({ app_id: appId, key: ORDER_TTL_KEY }, 'pay_order_ttl_invalid');
  const schedule = queryScheduleOf(await rawConfig(deps, appId, QUERY_SCHEDULE_KEY));
  if (schedule.fallback)
    deps.logger.warn({ app_id: appId, key: QUERY_SCHEDULE_KEY }, 'pay_query_schedule_invalid');
  const key: BizObjectKey = { appId, bizType, bizRef: input.biz_ref };

  const placement = await deps.db.transaction().execute(async (trx): Promise<Placement> => {
    await lockBizObject(trx, key);
    const now = deps.clock.now();
    const open = await findOpenOrders(trx, key);
    const paid = open.find((row) => row.status === 'PAID');
    if (paid !== undefined) {
      // Another user's order is never described to the caller (§12.1: 20902, no field of it).
      if (paid.user_id !== userId) return { kind: 'failed', failure: CONFLICT };
      return { kind: 'failed', failure: { code: 30902, data: { pay_order_id: paid.id } } };
    }
    const pending = open.find((row) => row.status === 'PENDING');
    if (pending !== undefined) {
      if (
        pending.user_id !== userId ||
        pending.closing ||
        isPayOrderExpired(now, pending.expire_at) ||
        pending.pay_channel !== channel
      ) {
        // Someone else's order; the close flow or an expired order (BR-PAY-03: no launch once
        // closing or past expire_at; the close job of B2-15d catches up); another channel
        // (BR-PAY-02 细则: cancel and close the original first; D10-236 ④).
        return { kind: 'failed', failure: CONFLICT };
      }
      return { kind: 'placed', order: pending, created: false };
    }
    const order = await insertPendingOrder(trx, {
      id: newUuidV7(now),
      appId,
      userId,
      bizType,
      bizRef: input.biz_ref,
      payChannel: channel,
      amountFen: price.amountFen,
      outTradeNo: generateOutTradeNo(),
      expireAt: payOrderExpireAt(now, ttl.minutes),
      now,
    });
    // BR-PAY-04 查询节奏: the first slot is queued with the order, persistent from the start
    // (没有收到通知时按 pay.query_schedule 查询; the client-return query is payOrderReturned's).
    const first = nextQueryInstant(
      queryInstants(order.created_at, order.expire_at, schedule.seconds),
      now,
    );
    if (first !== null) {
      const payload: OrderQueryScheduledPayload = {
        app_id: order.app_id,
        out_trade_no: order.out_trade_no,
        trigger: 'scheduled',
      };
      await deps.queue.send(PAY_QUEUE, ORDER_QUERY_JOB, payload, {
        trx,
        singletonKey: orderQueryScheduledKey(order.id, querySlotSeconds(order.created_at, first)),
        delaySeconds: delaySecondsUntil(now, first),
      });
    }
    return { kind: 'placed', order, created: true };
  });
  if (placement.kind === 'failed') return placement.failure;
  const order = placement.order;
  deps.logger.info(
    {
      app_id: appId,
      pay_order_id: order.id,
      biz_type: bizType,
      pay_channel: channel,
      created: placement.created,
    },
    'pay_order_placed',
  );

  // The channel is asked for this order's launch parameters: fresh ones on every call (WeChat
  // prepay_id and the Alipay order string are per request). The deadline given is the order's
  // expire_at itself, never later (BR-PAY-03). The amount is the stored one (server priced).
  const request: PayCreateOrderInput = {
    outTradeNo: order.out_trade_no,
    amountFen: order.amount_fen,
    description: price.title,
    expireAt: order.expire_at,
    notifyUrl: notifyPathOf(channel),
    appId: order.app_id,
  };
  let result: PayCreateOrderResult;
  try {
    result = await payChannel.createOrder(request);
  } catch (error: unknown) {
    // A throwing adapter is an unknown answer (payment/AGENTS.md rule 7): only the class is logged.
    deps.logger.warn(
      {
        app_id: appId,
        pay_order_id: order.id,
        pay_channel: channel,
        error_class: error instanceof Error ? error.name : typeof error,
      },
      'pay_channel_create_threw',
    );
    result = { kind: 'unknown', reason: 'adapter_error' };
  }

  const now = deps.clock.now();
  const issued = await deps.db
    .transaction()
    .execute(
      async (
        trx,
      ): Promise<
        { kind: 'unknown' } | { kind: 'closing' } | { kind: 'issued'; order: PayOrderRow }
      > => {
        await lockBizObject(trx, key);
        await insertQueryAttempt(trx, {
          id: newUuidV7(now),
          appId,
          payOrderId: order.id,
          kind: 'query',
          // Summaries only: the launch parameters stay out of the row (BR-PAY-08 ④, rule 6).
          request: {
            op: 'create_order',
            pay_channel: channel,
            out_trade_no: request.outTradeNo,
            amount_fen: request.amountFen.toString(),
            expire_at: request.expireAt.toISOString(),
            notify_url: request.notifyUrl,
          },
          response:
            result.kind === 'ok'
              ? { kind: 'ok', channel_ref: result.channelRef }
              : { kind: 'unknown', reason: result.reason },
          result: result.kind === 'ok' ? 'prepay' : 'unknown',
          at: now,
        });
        if (result.kind !== 'ok') return { kind: 'unknown' };
        const updated = await markLaunchIssued(trx, appId, order.id, now);
        return updated === undefined ? { kind: 'closing' } : { kind: 'issued', order: updated };
      },
    );
  if (issued.kind === 'unknown') {
    deps.logger.warn(
      { app_id: appId, pay_order_id: order.id, pay_channel: channel },
      'pay_channel_create_unknown',
    );
    return { code: 50306, data: { pay_channel: channel } };
  }
  if (issued.kind === 'closing' || result.kind !== 'ok') return CONFLICT;
  return { code: 0, data: { ...payOrderView(issued.order), launch: result.launch } };
}

/** GET /v1/pay/orders/{pay_order_id}: the owner's order only, else 30701 (unknown and foreign alike). */
/**
 * B2-15y (BR-PAY-03, D10-1067): what a replayed create answers instead of its stored bytes, or null
 * to replay them. Only a stored success carries launch parameters; for one, the order is read under
 * the business object lock (取参数与关单互斥), with the same test as a first create: PENDING,
 * closing=false and before expire_at can still be launched. PAID → 30902, anything else → 20902, as
 * another create for the object would answer. Writes nothing: a replay is not a new issue of the
 * parameters, so launch_issued_at stays. A failed read throws (50001), never the stored bytes.
 */
export async function replayRefusal(
  deps: PayOrderDeps,
  subject: PaySubject,
  storedBody: string,
): Promise<PayFailure | null> {
  const stored = JSON.parse(storedBody) as {
    readonly code: number;
    readonly data?: Schema<'CreatePayOrderData'>;
  };
  const data = stored.data;
  if (stored.code !== 0 || data === undefined) return null;
  return deps.db.transaction().execute(async (trx) => {
    await lockBizObject(trx, {
      appId: subject.app_id,
      bizType: data.biz_type,
      bizRef: data.biz_ref,
    });
    const order = await findOwnOrder(trx, subject.app_id, subject.user_id, data.pay_order_id);
    if (order === undefined) return CONFLICT;
    if (order.status === 'PAID') return { code: 30902, data: { pay_order_id: order.id } };
    const launchable =
      order.status === 'PENDING' &&
      !order.closing &&
      !isPayOrderExpired(deps.clock.now(), order.expire_at);
    return launchable ? null : CONFLICT;
  });
}

export async function getPayOrder(
  deps: PayOrderDeps,
  subject: PaySubject,
  payOrderId: string,
): Promise<PayResult<Schema<'PayOrder'>>> {
  const order = await findOwnOrder(deps.db, subject.app_id, subject.user_id, payOrderId);
  if (order === undefined) return NOT_FOUND;
  return { code: 0, data: payOrderView(order) };
}

/**
 * POST …/returned: a PENDING order gets one immediate query job (queue pay, name order.query,
 * singletonKey order.query:<pay_order_id>:returned, same transaction; a second call while that
 * job is queued or active inserts nothing); any other status answers success without a job.
 * The SDK's result is never read (BR-PAY-04). Data {}.
 */
export async function payOrderReturned(
  deps: PayOrderDeps,
  subject: PaySubject,
  payOrderId: string,
): Promise<PayResult<Record<string, never>>> {
  return deps.db.transaction().execute(async (trx): Promise<PayResult<Record<string, never>>> => {
    const order = await findOwnOrder(trx, subject.app_id, subject.user_id, payOrderId);
    if (order === undefined) return NOT_FOUND;
    if (order.status === 'PENDING') {
      const payload: OrderQueryPayload = {
        app_id: order.app_id,
        pay_order_id: order.id,
        trigger: 'returned',
      };
      const jobId = await deps.queue.send(PAY_QUEUE, ORDER_QUERY_JOB, payload, {
        trx,
        singletonKey: orderQueryReturnedKey(order.id),
      });
      deps.logger.info(
        { app_id: order.app_id, pay_order_id: order.id, queued: jobId !== null },
        'pay_order_returned',
      );
    }
    return { code: 0, data: {} };
  });
}

/**
 * POST …/cancel: under the business object lock, a PENDING order with closing=false gets
 * closing=true, close_reason='user_cancel' and one close job (queue pay, name order.close,
 * singletonKey order.close:<pay_order_id>); not PENDING, or already closing → 20902 resource
 * pay_order. The channel query and close are the job's (B2-15d); the switches do not apply
 * (BR-PAY-01 ④: 开关关闭只影响新下单).
 */
export async function cancelPayOrder(
  deps: PayOrderDeps,
  subject: PaySubject,
  payOrderId: string,
): Promise<PayResult<Schema<'PayOrder'>>> {
  return deps.db.transaction().execute(async (trx): Promise<PayResult<Schema<'PayOrder'>>> => {
    const own = await findOwnOrder(trx, subject.app_id, subject.user_id, payOrderId);
    if (own === undefined) return NOT_FOUND;
    await lockBizObject(trx, bizKeyOf(own));
    const order = await findOrderById(trx, subject.app_id, payOrderId);
    if (order === undefined || order.status !== 'PENDING' || order.closing) return CONFLICT;
    const now = deps.clock.now();
    const updated = await markClosing(trx, subject.app_id, order.id, 'user_cancel', now);
    if (updated === undefined) return CONFLICT;
    const payload: OrderClosePayload = {
      app_id: order.app_id,
      pay_order_id: order.id,
      close_reason: 'user_cancel',
    };
    await deps.queue.send(PAY_QUEUE, ORDER_CLOSE_JOB, payload, {
      trx,
      singletonKey: orderCloseKey(order.id),
    });
    deps.logger.info(
      { app_id: order.app_id, pay_order_id: order.id, lock_key: bizObjectLockKey(bizKeyOf(order)) },
      'pay_order_cancel_requested',
    );
    return { code: 0, data: payOrderView(updated) };
  });
}
