// User appeals (规划/08 BR-ID-36; 04 §3.2 appeals, §6.1; task B1-03i): POST /v1/me/appeals
// (submitAppeal) and GET /v1/me/appeals (listAppeals). Risk is the single writer of app.appeals;
// app.user_risk_state is written only through the risk state service (setRiskState).
//
// submit runs entirely on the caller's transaction (the platform idempotency claim's): never a
// pooled connection.
// - target_type=account: the appeal is always on the caller's own account (a target_id sent is
//   ignored; stored and returned target_id = user_id). The caller's user_risk_state row is read
//   from the database with a row lock (FOR UPDATE: never the cache), which serialises concurrent
//   submissions of one account: the later one waits for the earlier and then sees its appeal.
//   · banned / frozen without a processing account appeal → insert the appeal (processing,
//     prev_risk_state = the current state, penalty_started_at copied from the risk row,
//     deadline_at by the working-day calendar), then
//     setRiskState → appealing (reason, reason_category, frozen_until kept; changed_by
//     `user:<user_id>`; risk.state_changed published on the same transaction);
//   · banned / frozen / appealing with a processing account appeal → that appeal, nothing written;
//   · anything else (normal, no row, appealing without a processing appeal) → 20001, nothing written.
//   · banned / frozen, no processing account appeal, and the appeals of the current penalty used
//     up (nextAppealAttempt above MAX_APPEAL_ATTEMPTS, the same rule as can_resubmit) → 30418,
//     nothing written (after "return the processing appeal", before the insert; CT-26e).
// - target_type=order (BR-ID-36 ②, B1-03zl; 编排 D10-1181 ②): target_id = the order_id. The order
//   is read through the AppealOrderReader port (orders is not risk's; app.module builds it) on the
//   caller's transaction, scoped to the subject's app. In the contract's order:
//   · no target_id → 20001; an order_id that is not a UUID, unknown in this app, or not the
//     caller's → 30701; the caller's own order whose rebate risk control did not void (anything
//     but rebate_status VOID with reason BLACKLIST, the voidedOrderOwner rule) → 20001;
//   · a transaction-level advisory lock on (app_id, order_id) is taken before anything about the
//     order's appeals is read (see submitOrder);
//   · a processing appeal on the order → that appeal, nothing written;
//   · the order's appeals used up (MAX_APPEAL_ATTEMPTS appeals already on the order, whatever
//     their outcome, revoked included; counted per order, never restarted) → 30418;
//   · else insert the appeal (processing, prev_risk_state and penalty_started_at null, deadline_at
//     by the same working-day calendar). The account's risk state is never touched (拍板第二批
//     OPS-07): no setRiskState, no event. Concurrent submissions on one order queue on the
//     advisory lock; the unique index on the processing target (ON CONFLICT DO NOTHING) stays as
//     the backstop: losing it returns the earlier one's appeal.
//   Without the port (an entry or fixture that does not wire it) an order cannot be judged: 20001,
//   nothing written.
//
// attempt_no / can_resubmit (BR-ID-36 细则; CT-26e, B1-03v) are computed from the caller's own
// appeal history on the same target (account: target_id = user_id; order: the order_id), oldest
// first. Order appeals (B1-03zl; Codex money r1) are counted per order and never restart: the
// N-th appeal on an order (app_id, target_type=order, target_id), whatever the earlier ones'
// outcomes (revoked included), has attempt_no N; BR-ID-36 restarts the count only for a new
// penalty on the account. Account appeals are grouped by penalty (target, penalty_started_at; D10-147): the risk
// state service stamps user_risk_state.penalty_started_at when a penalty begins (normal → frozen /
// banned, frozen → banned) and an account appeal copies it at insert, so an appeal continues the
// count of the previous one on the target only when both carry the same instant; a different
// instant, or a previous appeal created before the penalty began, starts again at 1. The next
// appeal (30418, can_resubmit) is judged the same way against the account's current
// penalty_started_at. Where an instant is missing (account rows from before the column) the
// CT-26e approximation stays: a new penalty starts at the first appeal on the account, after a
// revoked appeal (the penalty was lifted), for the account when a freeze was escalated to a ban
// (banned → frozen is not, and the console cannot make it: freeze is only from normal or frozen,
// admin-risk-state.ts), and, for the next appeal, when user_risk_state.changed_at is later than
// the latest appeal's closed_at (this relies on the appeal closer putting the state back no later
// than closed_at). None of this applies to an order.
// can_resubmit and the 30418 check share one rule: the attempt number the next appeal on the
// target would get (account: nextAppealAttempt; order: the order's appeal count + 1).
// can_resubmit is true only for the latest appeal on its target, upheld, the target still
// restricted (account frozen with no past frozen_until, or banned), and that next attempt ≤ 3; so
// after the third upheld appeal of one penalty it is false. An order
// appeal (编排 D10-1192 ②) is true only when it is the latest on its order, upheld, the order is
// still voided by risk control (VOID + BLACKLIST, read through the port; without it: false) and
// its attempt_no + 1 ≤ 3; the account's own state plays no part.
//
// list reads the caller's own account and order appeals (never blocked_request), newest first
// (created_at, then id, descending), keyset-paginated by an opaque cursor; deadline_at,
// handler_id, prev_risk_state and request_type are never returned.
//
// Logging: content, reason and calendar values are never logged.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type RootLogger } from '../../platform/index.ts';
import { resolveAppealDeadline } from './appeal-calendar.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';
import type { RiskReasonCategory, RiskStateService, RiskSubject } from './risk-state.ts';

export interface AppealsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly riskState: RiskStateService;
  readonly config: RateLimitConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
  /**
   * The configuration port over a given handle. When present, submit reads the calendar on the
   * caller's transaction (inside a savepoint, so a failed read never aborts it) instead of
   * through `config`, so a submission never borrows a second pooled connection while holding one.
   */
  readonly configOn?: (handle: Kysely<DB>) => RateLimitConfigReader;
  /**
   * The orders port over a given handle (BR-ID-36 ②, B1-03zl), built by app.module: submit reads
   * on the caller's transaction, list on the pool. Absent: order appeals are refused (20001) and
   * never offer a resubmission.
   */
  readonly ordersOn?: (handle: Kysely<DB>) => AppealOrderReader;
}

/** One sub-order of the app as an order appeal sees it. */
export interface AppealOrderTarget {
  /** orders.user_id: the order's owner; null when the order is not attributed to anyone. */
  readonly user_id: string | null;
  /** Whether risk control voided the order's rebate (rebate_status VOID, reason BLACKLIST). */
  readonly risk_voided: boolean;
}

/** Reads of app.orders for order appeals (risk imports no orders module; app.module builds it). */
export interface AppealOrderReader {
  /** This app's sub-order `orderId` (a lowercase UUID), or null when there is none. */
  orderTarget(appId: string, orderId: string): Promise<AppealOrderTarget | null>;
  /** Those of `orderIds` that are the user's orders of this app voided by risk control. */
  riskVoidedOrderIds(
    appId: string,
    userId: string,
    orderIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

export type SubmitAppealResult =
  | { readonly code: 0; readonly data: Schema<'Appeal'> }
  | { readonly code: 20001; readonly fields?: readonly string[] }
  | { readonly code: 30418 }
  | { readonly code: 30701 };

export interface AppealsService {
  /** The caller supplies the platform idempotency claim transaction. */
  submit(
    trx: Transaction<DB>,
    subject: RiskSubject,
    body: Schema<'SubmitAppealRequest'>,
  ): Promise<SubmitAppealResult>;
  list(
    subject: RiskSubject,
    query: { readonly cursor?: string; readonly limit?: number },
  ): Promise<Schema<'AppealListData'>>;
}

/** A list query outside the contract (cursor or limit): the HTTP layer answers 20001. */
export class AppealQueryError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`appeals: invalid ${fields.join(', ')}`);
    this.name = 'AppealQueryError';
    this.fields = fields;
  }
}

/** Contract Limit: default 20, at most 50 (04 §5). */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const REFUSED: SubmitAppealResult = Object.freeze({ code: 20001 });
const USED_UP: SubmitAppealResult = Object.freeze({ code: 30418 });
/** No order_id, or the caller's order is not one risk control voided (D10-1181 ②). */
const TARGET_REFUSED: SubmitAppealResult = Object.freeze({
  code: 20001,
  fields: Object.freeze(['target_id']),
});
const UNKNOWN_ORDER: SubmitAppealResult = Object.freeze({ code: 30701 });
const NO_ATTEMPT: AppealAttempt = Object.freeze({ attempt_no: 1, can_resubmit: false });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Microsecond UTC instant as the cursor carries it (timestamptz keeps microseconds). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/**
 * BR-ID-36: at most three appeals per penalty on the account, per order on an order; the first
 * included.
 */
export const MAX_APPEAL_ATTEMPTS = 3;

interface AppealRow {
  readonly id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly status: string;
  readonly content: string;
  readonly created_at: Date;
  readonly closed_at: Date | null;
}

/** One appeal of the history used for attempt_no / can_resubmit. */
export interface AppealHistoryRow {
  readonly id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly status: string;
  readonly prev_risk_state: string | null;
  readonly created_at: Date;
  readonly closed_at: Date | null;
  /** Account appeals: the penalty it was filed against (copied at insert); null when unknown. */
  readonly penalty_started_at?: Date | null;
}

/** The account's current restriction (app.user_risk_state), for account appeals. */
export interface AccountRestriction {
  readonly state: 'normal' | 'frozen' | 'appealing' | 'banned';
  readonly frozen_until: Date | null;
  /** user_risk_state.changed_at: when the state last changed. */
  readonly changed_at: Date;
  /** user_risk_state.penalty_started_at: when the current penalty began; null when unknown. */
  readonly penalty_started_at?: Date | null;
}

export interface AppealAttempt {
  readonly attempt_no: number;
  readonly can_resubmit: boolean;
}

/** frozen → banned is a new penalty (D10-147); any other pair is the same penalty. */
function escalated(before: string | null, after: string | null): boolean {
  return before === 'frozen' && after === 'banned';
}

/**
 * Whether `earlier` (an older appeal on the target) is on the penalty that began at `started`:
 * decided by the instants when they can decide (same instant → yes; another instant, or the appeal
 * created before the penalty began → no), undefined when they cannot (an instant is missing).
 */
function onPenalty(
  earlier: { readonly penalty_started_at?: Date | null; readonly created_at?: Date },
  started: Date | null | undefined,
): boolean | undefined {
  if (started === null || started === undefined) return undefined;
  const own = earlier.penalty_started_at;
  if (own !== null && own !== undefined) return own.getTime() === started.getTime();
  if (earlier.created_at !== undefined && earlier.created_at.getTime() < started.getTime()) {
    return false;
  }
  return undefined;
}

/**
 * The attempt number the next appeal on a target would get (BR-ID-36; the 30418 rule: above
 * MAX_APPEAL_ATTEMPTS means used up). `latest` is the target's latest appeal with its attempt_no;
 * `penalty` is the penalty the new appeal would be on (for the account, its current risk state;
 * null for an order); `penaltySince` is when that state was last set (user_risk_state.changed_at;
 * undefined when unknown); `penaltyStartedAt` is when that penalty began (the account's
 * penalty_started_at, or the new appeal's own; null / undefined when unknown).
 * With both instants known the grouping (target, penalty_started_at) decides alone. Otherwise
 * (CT-26e approximation) a state set after the latest appeal was closed is a new penalty: an
 * upheld appeal puts the state back no later than it closes, so a later change means the
 * penalty ended (expiry, unfreeze, unban) and another was imposed, or it was re-imposed.
 */
export function nextAppealAttempt(
  latest:
    | {
        readonly status: string;
        readonly prev_risk_state: string | null;
        readonly closed_at: Date | null;
        readonly created_at?: Date;
        readonly penalty_started_at?: Date | null;
      }
    | undefined,
  latestAttempt: number,
  penalty: string | null,
  penaltySince?: Date,
  penaltyStartedAt?: Date | null,
): number {
  if (latest === undefined) return 1;
  const same = onPenalty(latest, penaltyStartedAt);
  if (same !== undefined) return same ? latestAttempt + 1 : 1;
  if (latest.status === 'revoked') return 1;
  if (escalated(latest.prev_risk_state, penalty)) return 1;
  if (
    penaltySince !== undefined &&
    latest.closed_at !== null &&
    penaltySince.getTime() > latest.closed_at.getTime()
  ) {
    return 1;
  }
  return latestAttempt + 1;
}

function targetKey(row: { readonly target_type: string; readonly target_id: string }): string {
  return `${row.target_type}:${row.target_id}`;
}

/**
 * attempt_no and can_resubmit for every appeal in `history` (BR-ID-36 细则), keyed by appeal id.
 * `account` is the caller's current risk state, read only when an account appeal needs it;
 * `voidedOrders` the order targets still voided by risk control (absent: none).
 */
export function appealAttempts(
  history: readonly AppealHistoryRow[],
  account: AccountRestriction | null,
  now: Date,
  voidedOrders?: ReadonlySet<string>,
): ReadonlyMap<string, AppealAttempt> {
  const sorted = [...history].sort(
    (a, b) =>
      a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const previous = new Map<string, { row: AppealHistoryRow; attempt: number }>();
  const attempts = new Map<string, number>();
  for (const row of sorted) {
    const key = targetKey(row);
    const before = previous.get(key);
    // An order counts every appeal on it (revoked included); only the account restarts.
    const attempt =
      row.target_type === 'order'
        ? (before?.attempt ?? 0) + 1
        : nextAppealAttempt(
            before?.row,
            before?.attempt ?? 0,
            row.prev_risk_state,
            undefined,
            row.target_type === 'account' ? row.penalty_started_at : null,
          );
    attempts.set(row.id, attempt);
    previous.set(key, { row, attempt });
  }
  const result = new Map<string, AppealAttempt>();
  for (const row of sorted) {
    const attempt = attempts.get(row.id)!;
    const latest = previous.get(targetKey(row))!.row.id === row.id;
    let canResubmit = false;
    if (latest && row.status === 'upheld' && row.target_type === 'account' && account !== null) {
      const restricted =
        account.state === 'banned' ||
        (account.state === 'frozen' &&
          (account.frozen_until === null || account.frozen_until.getTime() > now.getTime()));
      // Same rule as 30418: the next appeal on the current penalty must still be within the cap.
      canResubmit =
        restricted &&
        nextAppealAttempt(
          row,
          attempt,
          account.state,
          account.changed_at,
          account.penalty_started_at,
        ) <= MAX_APPEAL_ATTEMPTS;
    } else if (
      latest &&
      row.status === 'upheld' &&
      row.target_type === 'order' &&
      voidedOrders !== undefined &&
      voidedOrders.has(row.target_id)
    ) {
      // Same rule as 30418 on an order: the next appeal is the order's attempt + 1, never restarted.
      canResubmit = attempt + 1 <= MAX_APPEAL_ATTEMPTS;
    }
    result.set(row.id, { attempt_no: attempt, can_resubmit: canResubmit });
  }
  return result;
}

function publicAppeal(row: AppealRow, attempt: AppealAttempt): Schema<'Appeal'> {
  return {
    appeal_id: row.id,
    target_type: row.target_type as Schema<'Appeal'>['target_type'],
    target_id: row.target_id,
    status: row.status as Schema<'Appeal'>['status'],
    content: row.content,
    created_at: row.created_at.toISOString(),
    closed_at: row.closed_at === null ? null : row.closed_at.toISOString(),
    attempt_no: attempt.attempt_no,
    can_resubmit: attempt.can_resubmit,
  };
}

const HISTORY_COLUMNS = [
  'id',
  'target_type',
  'target_id',
  'status',
  'prev_risk_state',
  'created_at',
  'closed_at',
  'penalty_started_at',
] as const;

const APPEAL_COLUMNS = [
  'id',
  'target_type',
  'target_id',
  'status',
  'content',
  'created_at',
  'closed_at',
] as const;

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { readonly at: string; readonly id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppealQueryError(['cursor']);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !INSTANT.test(parsed[0]) ||
    Number.isNaN(Date.parse(parsed[0])) ||
    !UUID.test(parsed[1])
  ) {
    throw new AppealQueryError(['cursor']);
  }
  return { at: parsed[0], id: parsed[1] };
}

// TODO(规划/11 §3.2): 申诉提交写 audit_logs — blocked on audit_logs 只记后台操作人（规格同步任务）
export function createAppealsService(options: AppealsOptions): AppealsService {
  const { db, clock, riskState, config, logger, configOn, ordersOn } = options;

  /** The deadline, reading the calendar on `trx` inside a savepoint when configOn is wired. */
  async function deadlineOn(trx: Transaction<DB>, appId: string): Promise<Date> {
    if (configOn === undefined) return resolveAppealDeadline({ appId, clock, config, logger });
    await sql`SAVEPOINT appeal_calendar`.execute(trx);
    try {
      return await resolveAppealDeadline({ appId, clock, config: configOn(trx), logger });
    } finally {
      // The calendar only reads: undo whatever a failed read left behind, keep the transaction.
      await sql`ROLLBACK TO SAVEPOINT appeal_calendar`.execute(trx);
      await sql`RELEASE SAVEPOINT appeal_calendar`.execute(trx);
    }
  }

  /**
   * The caller's own account and order appeals (never blocked_request), on `executor`. With an
   * order `target`, every appeal on that order of the app (the count is the order's, BR-ID-36).
   */
  async function history(
    executor: Kysely<DB> | Transaction<DB>,
    subject: RiskSubject,
    target?: { readonly target_type: string; readonly target_id: string },
  ): Promise<AppealHistoryRow[]> {
    let select = executor
      .withSchema('app')
      .selectFrom('appeals')
      .select(HISTORY_COLUMNS)
      .where('app_id', '=', subject.app_id);
    if (target?.target_type !== 'order') {
      select = select
        .where('user_id', '=', subject.user_id)
        .where('target_type', 'in', ['account', 'order']);
    }
    if (target !== undefined) {
      select = select
        .where('target_type', '=', target.target_type)
        .where('target_id', '=', target.target_id);
    }
    return select.execute();
  }

  /** attempt_no / can_resubmit of `row`; a processing appeal never offers a resubmission. */
  async function attemptOf(
    trx: Transaction<DB>,
    subject: RiskSubject,
    row: AppealRow,
  ): Promise<AppealAttempt> {
    // Read on the caller's transaction, so a just-inserted appeal is part of its own history.
    const rows = await history(trx, subject, row);
    return appealAttempts(rows, null, clock.now()).get(row.id) ?? NO_ATTEMPT;
  }

  /** The caller's risk row, read from the database (never the cache); no row → null. */
  async function accountRestriction(subject: RiskSubject): Promise<AccountRestriction | null> {
    const row = await db
      .withSchema('app')
      .selectFrom('user_risk_state')
      .select(['state', 'frozen_until', 'changed_at', 'penalty_started_at'])
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      state: row.state as AccountRestriction['state'],
      frozen_until: row.frozen_until,
      changed_at: row.changed_at,
      penalty_started_at: row.penalty_started_at,
    };
  }

  /**
   * Whether a new appeal on `target` is within the cap (30418): for the account, on the current
   * penalty (`state`, set at `since`, begun at `started`); for an order, every appeal on the
   * order counts (revoked included, never restarted; `state` null).
   */
  async function attemptsLeft(
    trx: Transaction<DB>,
    subject: RiskSubject,
    target: { readonly target_type: string; readonly target_id: string },
    state: string | null,
    since?: Date,
    started?: Date | null,
  ): Promise<boolean> {
    const rows = await history(trx, subject, target);
    if (target.target_type === 'order') return rows.length + 1 <= MAX_APPEAL_ATTEMPTS;
    const attempts = appealAttempts(rows, null, clock.now());
    let latest: AppealHistoryRow | undefined;
    for (const row of rows) {
      if (
        latest === undefined ||
        row.created_at.getTime() > latest.created_at.getTime() ||
        (row.created_at.getTime() === latest.created_at.getTime() && row.id > latest.id)
      ) {
        latest = row;
      }
    }
    const latestAttempt = latest === undefined ? 0 : (attempts.get(latest.id)?.attempt_no ?? 0);
    return nextAppealAttempt(latest, latestAttempt, state, since, started) <= MAX_APPEAL_ATTEMPTS;
  }

  /** The processing appeal on `target` of the subject's app (at most one: unique index). */
  async function processingAppeal(
    trx: Transaction<DB>,
    subject: RiskSubject,
    target: { readonly target_type: string; readonly target_id: string },
  ): Promise<AppealRow | undefined> {
    return trx
      .withSchema('app')
      .selectFrom('appeals')
      .select(APPEAL_COLUMNS)
      .where('app_id', '=', subject.app_id)
      .where('target_type', '=', target.target_type)
      .where('target_id', '=', target.target_id)
      .where('status', '=', 'processing')
      .executeTakeFirst();
  }

  async function processingAccountAppeal(
    trx: Transaction<DB>,
    subject: RiskSubject,
  ): Promise<AppealRow | undefined> {
    return processingAppeal(trx, subject, { target_type: 'account', target_id: subject.user_id });
  }

  /** target_type=order (BR-ID-36 ②): see the header for the order of checks. */
  async function submitOrder(
    trx: Transaction<DB>,
    subject: RiskSubject,
    body: Schema<'SubmitAppealRequest'>,
  ): Promise<SubmitAppealResult> {
    if (body.target_id === undefined) return TARGET_REFUSED;
    if (ordersOn === undefined) return REFUSED;
    const orderId = body.target_id.toLowerCase();
    if (!UUID.test(orderId)) return UNKNOWN_ORDER;
    const order = await ordersOn(trx).orderTarget(subject.app_id, orderId);
    if (order === null || order.user_id === null) return UNKNOWN_ORDER;
    if (order.user_id.toLowerCase() !== subject.user_id.toLowerCase()) return UNKNOWN_ORDER;
    if (!order.risk_voided) return TARGET_REFUSED;

    const target = { target_type: 'order', target_id: orderId } as const;
    // Serialise submissions on this order before reading its appeals. The unique index on the
    // processing target only stops two processing appeals at once: with different idempotency
    // keys, A could insert the third appeal, the console uphold it, and B (which counted before A
    // committed) then insert a fourth, since no processing row conflicts any more. Behind this lock
    // (released at commit / rollback) B's reads, under READ COMMITTED, see A's committed row, so
    // the cap of three holds. The account branch is serialised the same way by its
    // user_risk_state row lock (FOR UPDATE).
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`risk.appeals.order:${subject.app_id}:${orderId}`}, 0))`.execute(
      trx,
    );
    const existing = await processingAppeal(trx, subject, target);
    if (existing !== undefined) {
      return { code: 0, data: publicAppeal(existing, await attemptOf(trx, subject, existing)) };
    }
    if (!(await attemptsLeft(trx, subject, target, null))) return USED_UP;

    const deadline = await deadlineOn(trx, subject.app_id);
    const now = clock.now();
    const row: AppealRow = {
      id: newUuidV7(now),
      target_type: 'order',
      target_id: orderId,
      status: 'processing',
      content: body.content,
      created_at: now,
      closed_at: null,
    };
    // A concurrent submission on the order may have inserted first: the unique index on the
    // processing target decides, and this one then returns that appeal (BR-ID-36: 不新建).
    const inserted = await trx
      .withSchema('app')
      .insertInto('appeals')
      .values({
        ...row,
        app_id: subject.app_id,
        user_id: subject.user_id,
        prev_risk_state: null,
        penalty_started_at: null,
        deadline_at: deadline,
        handler_id: null,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['app_id', 'target_type', 'target_id'])
          .where('status', '=', 'processing')
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (inserted === undefined) {
      const winner = await processingAppeal(trx, subject, target);
      if (winner === undefined) {
        throw new Error('appeals: the processing order appeal that won the insert is gone');
      }
      return { code: 0, data: publicAppeal(winner, await attemptOf(trx, subject, winner)) };
    }
    // The account's risk state is not the order appeal's (OPS-07): no setRiskState, no event.
    return { code: 0, data: publicAppeal(row, await attemptOf(trx, subject, row)) };
  }

  return {
    async submit(trx, subject, body) {
      if (body.target_type === 'order') return submitOrder(trx, subject, body);
      if (body.target_type !== 'account') return REFUSED;
      const current = await trx
        .withSchema('app')
        .selectFrom('user_risk_state')
        .select([
          'state',
          'reason',
          'reason_category',
          'frozen_until',
          'changed_at',
          'penalty_started_at',
        ])
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) return REFUSED;
      const state = current.state;
      if (state !== 'banned' && state !== 'frozen' && state !== 'appealing') return REFUSED;
      const existing = await processingAccountAppeal(trx, subject);
      if (existing !== undefined) {
        return { code: 0, data: publicAppeal(existing, await attemptOf(trx, subject, existing)) };
      }
      if (state === 'appealing') return REFUSED;
      const started = current.penalty_started_at ?? null;
      const account = { target_type: 'account', target_id: subject.user_id } as const;
      if (!(await attemptsLeft(trx, subject, account, state, current.changed_at, started))) {
        return USED_UP;
      }

      const deadline = await deadlineOn(trx, subject.app_id);
      const now = clock.now();
      const row: AppealRow = {
        id: newUuidV7(now),
        target_type: 'account',
        target_id: subject.user_id,
        status: 'processing',
        content: body.content,
        created_at: now,
        closed_at: null,
      };
      await trx
        .withSchema('app')
        .insertInto('appeals')
        .values({
          ...row,
          app_id: subject.app_id,
          user_id: subject.user_id,
          prev_risk_state: state,
          penalty_started_at: started,
          deadline_at: deadline,
          handler_id: null,
          updated_at: now,
        })
        .execute();
      // Called on the service object (not a detached function), on exactly this transaction.
      await riskState.setRiskState(trx, {
        app_id: subject.app_id,
        user_id: subject.user_id,
        state: 'appealing',
        reason: current.reason,
        reason_category: current.reason_category as RiskReasonCategory | null,
        frozen_until: current.frozen_until,
        changed_by: `user:${subject.user_id}`,
      });
      const attempt = await attemptOf(trx, subject, row);
      return { code: 0, data: publicAppeal(row, attempt) };
    },

    async list(subject, query) {
      const limit = query.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new AppealQueryError(['limit']);
      }
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      let select = db
        .withSchema('app')
        .selectFrom('appeals')
        .select(APPEAL_COLUMNS)
        .select(
          sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'cursor_at',
          ),
        )
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .where('target_type', 'in', ['account', 'order']);
      if (after !== undefined) {
        select = select.where(
          sql<boolean>`(created_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        );
      }
      const rows = await select
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const all = page.length === 0 ? [] : await history(db, subject);
      const now = clock.now();
      // The account's current state matters only to an upheld account appeal (can_resubmit).
      const needsAccount = all.some(
        (row) => row.target_type === 'account' && row.status === 'upheld',
      );
      const account = needsAccount ? await accountRestriction(subject) : null;
      // An upheld order appeal may be resubmitted only while its order is still risk-voided.
      const upheldOrders = [
        ...new Set(
          all
            .filter((row) => row.target_type === 'order' && row.status === 'upheld')
            .map((row) => row.target_id),
        ),
      ];
      const voided =
        upheldOrders.length === 0 || ordersOn === undefined
          ? undefined
          : await ordersOn(db).riskVoidedOrderIds(subject.app_id, subject.user_id, upheldOrders);
      const attempts = appealAttempts(all, account, now, voided);
      return {
        items: page.map((row) => publicAppeal(row, attempts.get(row.id) ?? NO_ATTEMPT)),
        next_cursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.cursor_at, last.id) : null,
      };
    },
  };
}
