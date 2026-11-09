// APPEAL_RESULT inbox message (BR-TEXT-23, BR-ID-36, B1-12p): notification consumes appeal.resolved
// and writes one inbox message plus one notify_logs row in the consumer's transaction. Service
// category, inbox only: never a push or an SMS. The payload is the resolution's snapshot, including
// need_reauth; nothing else is read (no appeals, user_risk_state or union_bindings). A blocked
// request's appeal sends nothing and logs nothing (BR-ID-36 细则「被拦截请求申诉」).
import type { AppealStatus, AppealTargetType } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { newUuidV7, type Clock, type EventHandler, type JobPayload } from '../../platform/index.ts';
import { NEED_REAUTH_TEXT } from './risk-state-message.ts';

/** B1-12p / BR-ID-36: resolved event snapshot, including the reauthorization decision. */
export interface AppealResultMessagePayload extends JobPayload {
  readonly app_id: string;
  readonly appeal_id: string;
  readonly user_id: string | null;
  readonly target_type: AppealTargetType;
  readonly target_id: string;
  readonly status: Extract<AppealStatus, 'revoked' | 'upheld'>;
  readonly need_reauth: boolean;
}

export type AppealResultVariant = 'account_revoked' | 'order_revoked' | 'upheld';

export interface AppealResultOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

/** B1-12ze (D10-1183): an order appeal's result lands on that order's detail. */
export interface AppealResultRoute {
  readonly route: 'OrderDetail';
  readonly params: { readonly order_id: string };
}

export interface AppealResultMessage {
  readonly code: 'APPEAL_RESULT';
  readonly variant: AppealResultVariant;
  readonly category: 'service';
  readonly channels: readonly ['inbox'];
  readonly title: string;
  readonly body: string;
  /** OrderDetail for an order appeal; an account appeal has no landing. */
  readonly route: AppealResultRoute | null;
}

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.notification-appeal-result`. */
export const APPEAL_RESULT_MESSAGE_CONSUMER = 'notification-appeal-result';

const CODE = 'APPEAL_RESULT';
/** inbox.title.APPEAL_RESULT. */
const DEFAULT_TITLE = '申诉结果';

/** BR-TEXT-23 细则表, verbatim. */
const DEFAULT_BODIES: Readonly<Record<AppealResultVariant, string>> = Object.freeze({
  account_revoked: '你的申诉已通过，相关限制已解除。',
  order_revoked: '你对一笔订单的申诉已通过，返利将在复核后恢复。',
  upheld: '你的申诉已处理，维持原处理结果。如有疑问请联系客服。',
});

const TARGET_TYPES: ReadonlySet<string> = new Set(['account', 'order', 'blocked_request']);
const STATUSES: ReadonlySet<string> = new Set(['revoked', 'upheld']);

/** Variant by target and outcome; a blocked request's appeal has none (nothing is sent). */
function variantOf(payload: AppealResultMessagePayload): AppealResultVariant | null {
  if (payload.target_type === 'blocked_request') return null;
  if (payload.status === 'upheld') return 'upheld';
  return payload.target_type === 'account' ? 'account_revoked' : 'order_revoked';
}

/** BR-TEXT-23 defaults and independent overrides; blocked_request yields no message. */
export function renderAppealResultMessage(
  payload: AppealResultMessagePayload,
  override: AppealResultOverride | null,
): AppealResultMessage | null {
  const variant = variantOf(payload);
  if (variant === null) return null;
  const title = override?.title_override ?? DEFAULT_TITLE;
  const base = override?.body_override ?? DEFAULT_BODIES[variant];
  // The reauthorization sentence follows the body directly, default or override alike.
  const body =
    variant === 'account_revoked' && payload.need_reauth ? `${base}${NEED_REAUTH_TEXT}` : base;
  return {
    code: CODE,
    variant,
    category: 'service',
    channels: ['inbox'],
    title,
    body,
    // The landing comes from the payload only; a template never overrides it (B1-12ze, D10-1183).
    route:
      payload.target_type === 'order'
        ? { route: 'OrderDetail', params: { order_id: payload.target_id } }
        : null,
  };
}

/** Checks the event data shape; a malformed event fails the job (retries, then dead letter). */
function readPayload(appId: string, data: JobPayload): AppealResultMessagePayload {
  const value = data as Partial<Record<keyof AppealResultMessagePayload, unknown>>;
  if (
    value.app_id !== appId ||
    typeof value.appeal_id !== 'string' ||
    !(value.user_id === null || typeof value.user_id === 'string') ||
    typeof value.target_type !== 'string' ||
    !TARGET_TYPES.has(value.target_type) ||
    typeof value.target_id !== 'string' ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status) ||
    typeof value.need_reauth !== 'boolean'
  ) {
    throw new Error('notification: invalid appeal.resolved payload');
  }
  return value as AppealResultMessagePayload;
}

async function deliver(
  trx: Transaction<DB>,
  eventId: string,
  payload: AppealResultMessagePayload,
  clock: Clock,
): Promise<void> {
  const variant = variantOf(payload);
  if (variant === null) return;
  const userId = payload.user_id;
  // An account or order appeal always belongs to a user; a missing one is a malformed event.
  if (userId === null) throw new Error('notification: appeal.resolved lacks a user');
  const db = trx.withSchema('app');
  const now = clock.now();
  // The dedupe boundary first: ON CONFLICT DO NOTHING keeps the transaction usable, and a
  // concurrent delivery of the same event waits on the unique key until the first one ends.
  const logged = await db
    .insertInto('notify_logs')
    .values({
      id: newUuidV7(now),
      app_id: payload.app_id,
      user_id: userId,
      code: CODE,
      channel: 'inbox',
      dedupe_key: `appeal.resolved:${eventId}`,
      planned_at: now,
      sent_at: now,
      status: 'success',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (logged === undefined) return;
  const override = await db
    .selectFrom('notify_templates')
    .select(['title_override', 'body_override'])
    .where('app_id', '=', payload.app_id)
    .where('code', '=', CODE)
    .where('variant', '=', variant)
    .executeTakeFirst();
  const message = renderAppealResultMessage(payload, override ?? null);
  if (message === null) return;
  await db
    .insertInto('inbox_messages')
    .values({
      message_id: newUuidV7(now),
      app_id: payload.app_id,
      user_id: userId,
      code: CODE,
      title: message.title,
      body: message.body,
      route: message.route === null ? null : JSON.stringify(message.route),
      created_at: now,
      updated_at: now,
    })
    .execute();
}

/** Uses the consumer transaction for both inserts, deduplicated by app_id and event_id. */
export function createAppealResultMessageHandler(options: { readonly clock: Clock }): EventHandler {
  const { clock } = options;
  return async (event, trx) => {
    if (event.name !== 'appeal.resolved') {
      throw new Error('notification: unexpected event for the appeal result message');
    }
    await deliver(trx, event.eventId, readPayload(event.appId, event.payload), clock);
  };
}
