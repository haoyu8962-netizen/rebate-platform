// B1-28p: the use case of POST /v1/products/{product_key}/feedback (contract CT-26q
// submitProductFeedback; 08 BR-ID-02 细则「商品反馈与进店」, BR-ID-30 细则「商品反馈记录」; brief §9.2 ③).
// Runs as the handler of platform idempotency's transactional mode, so a replay of an accepted
// Idempotency-Key never gets here, and the insert commits together with the idempotency record.
// Order inside the handler:
//   1. feedback.enabled off → 30145 (before anything about the link);
//   2. link_id unknown or of another app (linking's read port, on the same transaction) → 30144;
//   3. logged in: the user's app.users row FOR SHARE (conflicts with identity's deletion cleanup,
//      which locks that row first), then identity's deletion status of the account on this
//      transaction; an account in the deletion flow is recorded as a guest (money r1 S1, BR-ID-28);
//   4. pg_advisory_xact_lock(app, device), then the device's count in the +08:00 natural day of
//      the Clock's instant; count ≥ feedback.daily_limit_per_device → 42901, nothing written;
//   5. insert: the device always, user_id when logged in and not in the deletion flow,
//      created_at = the Clock's instant.
// The two configuration values are read by the caller before the idempotency transaction holds a
// pool connection (the reader may need another one from the same pool) and passed in.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { InvalidAmount, parseFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, HandlerResult } from '../../platform/index.ts';
import { fieldsErrorEnvelope, newUuidV7 } from '../../platform/index.ts';
import {
  chinaDayOf,
  instantAt,
  isUuid,
  recordedUserId,
  retryAfterSeconds,
  type AccountDeletionStatus,
} from '../domain/rules.ts';
import {
  countDeviceFeedback,
  insertFeedback,
  lockDeviceFeedback,
  lockUserForShare,
} from '../infra/feedback-store.ts';

/** linking's read port: whether the link exists in the app (app.links), on the given handle. */
export interface FeedbackLinkReader {
  linkInApp(handle: Kysely<DB>, appId: string, linkId: string): Promise<boolean>;
}

/**
 * identity's read of an account's deletion status (users.status), on the given transaction after
 * the row is locked; undefined when the user is not in the app.
 */
export interface FeedbackAccountReader {
  deletionStatus(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
  ): Promise<AccountDeletionStatus | undefined>;
}

/** The configuration as read before the transaction (defaults already applied). */
export interface FeedbackSettings {
  readonly enabled: boolean;
  readonly dailyLimit: number;
}

export interface FeedbackSubmission {
  readonly appId: string;
  /** The device verified by the request signature (stage ①). */
  readonly deviceId: string;
  /** The token's user; null for a guest. */
  readonly userId: string | null;
  readonly productKey: string;
  readonly body: Schema<'ProductFeedbackRequest'>;
  readonly traceId: string;
}

/** The handler's answer plus Retry-After for a 42901. */
export interface FeedbackOutcome {
  readonly result: HandlerResult;
  readonly retryAfterSec?: number;
}

export interface SubmitFeedbackDeps {
  readonly clock: Clock;
  readonly links: FeedbackLinkReader;
  readonly accounts: FeedbackAccountReader;
}

/** BR-TEXT-14 fallback texts (clients show error.<code>); error-codes.yaml meaning. */
const DISABLED_MSG = '商品反馈暂未开放';
const NO_LINK_MSG = '购买链接不存在';
const LIMITED_MSG = '请求过于频繁';
const INVALID_MSG = '参数校验失败';

function refusal(status: number, code: number, msg: string, traceId: string): HandlerResult {
  return { status, envelope: { code, msg, trace_id: traceId } };
}

function invalid(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: { ...refused.body, msg: INVALID_MSG } };
}

/** A shown amount as fen; undefined when it is not a non-negative int64 the money package takes. */
function shownFen(value: unknown): bigint | undefined {
  try {
    const fen = parseFen(value);
    return fen < 0n ? undefined : fen;
  } catch (error: unknown) {
    if (error instanceof InvalidAmount) return undefined;
    throw error;
  }
}

/** One submission on the idempotency transaction `trx`. */
export async function submitFeedback(
  trx: Transaction<DB>,
  input: FeedbackSubmission,
  settings: FeedbackSettings,
  deps: SubmitFeedbackDeps,
): Promise<FeedbackOutcome> {
  const { body, traceId } = input;
  if (!settings.enabled) return { result: refusal(422, 30145, DISABLED_MSG, traceId) };

  // The route schema has checked the shape; the amounts still go through @couli/money.
  const finalFen = shownFen(body.shown_final_price_fen);
  const rebateFen = body.shown_rebate_fen === null ? null : shownFen(body.shown_rebate_fen);
  const fields = [
    ...(finalFen === undefined ? ['shown_final_price_fen'] : []),
    ...(rebateFen === undefined ? ['shown_rebate_fen'] : []),
  ];
  const now = deps.clock.now();
  const quotedMs = Date.parse(body.quoted_at);
  if (!Number.isFinite(quotedMs)) fields.push('quoted_at');
  if (fields.length > 0 || finalFen === undefined || rebateFen === undefined) {
    return { result: invalid(fields, traceId) };
  }

  if (!isUuid(body.link_id) || !(await deps.links.linkInApp(trx, input.appId, body.link_id))) {
    return { result: refusal(404, 30144, NO_LINK_MSG, traceId) };
  }

  // Lock order users row → device advisory lock: the users row first, as identity's deletion
  // cleanup takes it first; a submission waiting behind a cleanup then holds no device lock, so the
  // same device's guest submissions are not queued behind the cleanup.
  let userId: string | null = null;
  if (input.userId !== null) {
    const present = await lockUserForShare(trx, input.appId, input.userId);
    const status = present
      ? await deps.accounts.deletionStatus(trx, input.appId, input.userId)
      : undefined;
    userId = recordedUserId(input.userId, status);
  }

  await lockDeviceFeedback(trx, input.appId, input.deviceId);
  const day = chinaDayOf(now);
  const count = await countDeviceFeedback(trx, input.appId, input.deviceId, day.start, day.end);
  if (count >= settings.dailyLimit) {
    return {
      result: refusal(429, 42901, LIMITED_MSG, traceId),
      retryAfterSec: retryAfterSeconds(now),
    };
  }

  const id = newUuidV7(now);
  await insertFeedback(trx, {
    id,
    appId: input.appId,
    deviceId: input.deviceId,
    userId,
    platform: body.platform,
    productKey: input.productKey,
    itemRef: body.item_ref ?? null,
    linkId: body.link_id.toLowerCase(),
    shownFinalPriceFen: finalFen,
    shownRebateFen: rebateFen,
    quotedAt: instantAt(now, quotedMs),
    reason: body.reason,
    note: body.note ?? null,
    createdAt: now,
  });
  return {
    result: {
      status: 200,
      envelope: { code: 0, msg: '', data: { feedback_id: id }, trace_id: traceId },
    },
  };
}
