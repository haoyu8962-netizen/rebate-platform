import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../clock/clock.ts';
import type { RootLogger } from '../logging/logger.ts';
import type { JobPayload, JobQueue, QueueSpec } from '../queue/types.ts';

/** Upper bound of UTF-8 bytes of JSON.stringify(payload) (section 2). */
export const MAX_EVENT_PAYLOAD_BYTES = 4_096;
/** Upper bound of UTF-16 code units of a string value of a payload (section 2). */
export const MAX_EVENT_STRING_LENGTH = 128;
/** Most levels of nesting of a payload, the payload itself being level 1 (section 2). */
export const MAX_EVENT_PAYLOAD_DEPTH = 3;
/** Version range (section 2). */
export const MAX_EVENT_VERSION = 999;

/**
 * Event names of 规划/02 §11 (section 1), in its order. A name 02 §11 adds later is registered, at
 * its 02 position, by the task that publishes it.
 */
export const EVENT_NAMES: readonly string[] = Object.freeze([
  'order.created',
  'order.updated',
  'order.credited',
  'order.invalidated',
  'order.clawed_back',
  'order.settle_adjusted',
  // Unattributed order assigned by an admin (B1-10f; BR-ATTR-31; 02 §11, after order.settle_adjusted).
  'order.reassigned',
  'claim.resolved',
  'binding.changed',
  'member.registered',
  'member.bound_parent',
  'member.level_changed',
  'wallet.withdrawal_changed',
  'withdrawal.created',
  'account.went_negative',
  'settle.batch_done',
  // Settle run event (B2-04zf; D10-467 ③ / D10-477; BR-TEXT-09): published by settlement on the batch
  // transition that brings a settle run to rest, one per (settle_run_id, part); 02 §11 after
  // settle.batch_done (couli #228).
  'settle.run_done',
  'risk.state_changed',
  'appeal.resolved',
  'agent.run_finished',
  // Alert events of the order sync (B1-08i; BR-ATTR-01, BR-ATTR-07, BR-FUND-01 P10; D10-48).
  'order.attr_param_changed',
  'order.illegal_transition',
  'order.attr_binding_conflict',
  // A credited order hitting the order-side blacklist: no automatic clawback, enqueued in the sync
  // transaction for manual review (B1-09b; BR-ATTR-26; 02 §11, D10-48).
  'order.blacklist_hit_after_credit',
  // Alert of the commission snapshot compensation retry still failing after 24 hours, enqueued with
  // the manual hand-off mark (B1-08u; last in 02 §11, after order.blacklist_hit_after_credit;
  // D10-81, D10-105).
  'order.snapshot_retry_exhausted',
  // A real-name correction by customer service, published by identity on the overwrite's
  // transaction: user_id with the old and the new id_no_hmac, never plaintext (B1-27a; BR-ID-25
  // 细则「实名更正」个税; 02 §11 after order.snapshot_created; D10-181 ②).
  'user.realname_corrected',
  // Finance alerts of the asset daily snapshot, published by ledger on the snapshot's transaction
  // (B2-04wa; BR-FUND-18, BR-FUND-20; last in 02 §11, after user.realname_corrected; D10-188).
  'asset_snapshot.timed_out',
  'union_receivable.exposure_exceeded',
  // Payment (B2-15c; 08 BR-PAY-04 PO2): published by payment on the settlement transaction.
  // Two segments per the event name rule (D10-340, couli #206: 02 §11 lists it as pay_order.paid).
  'pay_order.paid',
  // Payment (B2-15e; 08 BR-PAY-06 ⑤ RF2): published by payment on the refund success transaction
  // (02 §11 lists it after pay_order.paid, D10-349, couli #208).
  'pay_refund.succeeded',
  // 02 §11 提现审核超时（BR-WDR-26；D10-475 ②(a)，B2-05n）: the worker's review-overdue check, last in
  // the list; notification's WD_OVERDUE consumer subscribes when identity's task lands.
  'withdrawal.review_overdue',
]);

export interface EventSubscription {
  readonly consumer: string;
  readonly events: readonly string[];
}

/**
 * Production routing table (section 6). notification-risk-state: the RISK_STATE_CHANGED inbox
 * message of notification (B1-12g, BR-TEXT-23). notification-appeal-result: the APPEAL_RESULT
 * inbox message of notification (B1-12p, BR-TEXT-23 / BR-ID-36). notification-claim-result: the
 * CLAIM_RESULT inbox message of notification (B1-12r, BR-TEXT-09). notification-withdrawal-result:
 * the WD_SUCCESS / WD_REJECTED / WD_FAILED messages of notification (B1-12u, BR-TEXT-09, BR-WDR-26).
 * notification-clawback: the CLAWBACK / SETTLE_ADJUSTED messages of notification on order.clawed_back
 * and order.settle_adjusted (B1-12zc, BR-TEXT-09, D10-773 ①).
 * risk-appeal-restore: risk's appeal restore differences of revoked ban appeals (B1-03z,
 * BR-FUND-22 / BR-CALC-13 细则「申诉恢复」).
 * payout-went-negative: the negative balance handling of withdrawals (B2-05e, BR-WDR-05 (a)).
 * payout-auto-payout: the automatic payout decision of withdrawals (B2-11c, BR-WDR-30).
 */
export const EVENT_SUBSCRIPTIONS: readonly EventSubscription[] = Object.freeze([
  Object.freeze({
    consumer: 'notification-risk-state',
    events: Object.freeze(['risk.state_changed']),
  }),
  Object.freeze({
    consumer: 'notification-appeal-result',
    events: Object.freeze(['appeal.resolved']),
  }),
  Object.freeze({
    consumer: 'notification-claim-result',
    events: Object.freeze(['claim.resolved']),
  }),
  // notification-withdrawal-result: withdrawal result messages (B1-12u, BR-TEXT-09, BR-WDR-26).
  Object.freeze({
    consumer: 'notification-withdrawal-result',
    events: Object.freeze(['wallet.withdrawal_changed']),
  }),
  // notification-clawback: the CLAWBACK and SETTLE_ADJUSTED messages, one consumer for both
  // events (B1-12zc, BR-TEXT-09, D10-773 ①).
  Object.freeze({
    consumer: 'notification-clawback',
    events: Object.freeze(['order.clawed_back', 'order.settle_adjusted']),
  }),
  // risk-appeal-restore: appeal_restore differences of revoked ban appeals (B1-03z, BR-FUND-22).
  Object.freeze({
    consumer: 'risk-appeal-restore',
    events: Object.freeze(['appeal.resolved']),
  }),
  // payout-went-negative: the negative balance handling of withdrawals (B2-05e, BR-WDR-05 (a)).
  Object.freeze({
    consumer: 'payout-went-negative',
    events: Object.freeze(['account.went_negative']),
  }),
  // payout-auto-payout: the automatic payout decision of withdrawals (B2-11c, BR-WDR-30).
  Object.freeze({
    consumer: 'payout-auto-payout',
    events: Object.freeze(['withdrawal.created']),
  }),
]);

export interface DomainEvent {
  readonly appId: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly version?: number;
  readonly eventId?: string;
}

export interface PublishResult {
  readonly eventId: string;
  readonly duplicate: boolean;
}

export interface EventBus {
  publish(trx: Transaction<DB>, event: DomainEvent): Promise<PublishResult>;
}

export interface EventBusOptions {
  readonly queue: JobQueue;
  readonly clock: Clock;
  readonly subscriptions?: readonly EventSubscription[];
  readonly catalog?: readonly QueueSpec[];
}

export interface ReceivedEvent {
  readonly eventId: string;
  readonly appId: string;
  readonly name: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: JobPayload;
  readonly consumer: string;
  readonly attempt: number;
}

export type EventHandler = (event: ReceivedEvent, trx: Transaction<DB>) => Promise<void>;

export interface EventConsumerOptions {
  readonly consumer: string;
  readonly db: Kysely<DB>;
  readonly logger: RootLogger;
  readonly handler: EventHandler;
  readonly subscriptions?: readonly EventSubscription[];
}

export type EventErrorCode =
  | 'invalid_option'
  | 'invalid_subscriptions'
  | 'invalid_transaction'
  | 'invalid_event'
  | 'invalid_app_id'
  | 'unknown_event'
  | 'invalid_version'
  | 'invalid_event_id'
  | 'invalid_payload'
  | 'personal_data'
  | 'payload_too_large'
  | 'event_conflict'
  | 'unknown_consumer';

/** The fixed message of each code (section 9). */
export const EVENT_ERROR_MESSAGES: Readonly<Record<EventErrorCode, string>> = Object.freeze({
  invalid_option: 'invalid event bus option',
  invalid_subscriptions: 'the event subscriptions are invalid',
  invalid_transaction: 'an event must be published inside a business transaction',
  invalid_event: 'invalid domain event',
  invalid_app_id: 'invalid app id of the event',
  unknown_event: 'the event name is not in the event list',
  invalid_version: 'the event version must be an integer from 1 to 999',
  invalid_event_id: 'the event id must be a lower-case canonical UUID',
  invalid_payload: 'the event payload must be a small JSON object of ids',
  personal_data: 'the event payload must not carry personal data',
  payload_too_large: 'the event payload exceeds 4096 bytes',
  event_conflict: 'an event with this id was published with other content',
  unknown_consumer: 'the consumer has no subscription',
});

export class EventError extends Error {
  readonly code: EventErrorCode;

  constructor(code: EventErrorCode) {
    super(EVENT_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'EventError';
  }
}
