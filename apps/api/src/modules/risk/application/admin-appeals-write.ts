// Admin appeal console writes (CT-24r; 规划/08 BR-ID-36, BR-ID-31; 04 §6.6 appeals, §11.2
// risk.appeal; task B1-03ze): POST /admin/v1/appeals/{appeal_id}/claim (adminClaimAppeal), POST
// /admin/v1/appeals/{appeal_id}/resolve (adminResolveAppeal) and POST /admin/v1/appeals
// (adminRegisterAppeal). risk is the single writer of app.appeals, app.blocklist and (through the
// risk state service) app.user_risk_state; the union bindings come back through linking's
// restoreAfterUnban port and the orders read through a port app.module builds (risk imports
// neither module). Every answer is the appeal as GET /admin/v1/appeals/{appeal_id} returns it,
// read after the commit.
//
// The controller has checked the admin account and risk.appeal (no step-up) before any of this.
// - claim: the appeal row FOR UPDATE (none of this app → 20001 appeal_id; not processing or another
//   row_version → 20902), then the compare-and-set `UPDATE … WHERE app_id AND id AND status =
//   'processing' AND row_version = expected` (handler_id = caller, row_version + 1; 0 rows → 20902)
//   and one insert-only app.appeal_claims row (that version, the claimant, claimed_at = now: the
//   detail's claimed_at while the appeal stays at that version). Audit appeal_claim (handler before
//   / after) on the same transaction.
// - resolve: prepareResolve checks the note (appealConsoleText), the appeal (20001), its state and
//   version (20902) and answers what else the decision needs (appealResolveRequirement); the
//   controller checks that point and its step-up and then runs the returned closure. In one
//   transaction: the appeal row FOR UPDATE, its state and version judged again, then the CAS
//   update (status = decision, closed_at = now, handler_id = caller, row_version + 1 — which also
//   ends the claim time —, again guarded by status and row_version in SQL); account appeals take the user lock
//   (users FOR NO KEY UPDATE, the order of the console's risk state change: users → risk row) and
//   put the risk state back (upheld → prev_risk_state with the frozen_until kept; revoked →
//   normal, a ban also restoreAfterUnban); a blocked_request appeal revoked with cause blocklist
//   makes the blocklist entries that caused it inactive (each removal audited); audit
//   appeal_resolve; appeal.resolved queued on the same transaction — the six fields of the contract
//   plus need_reauth (D10-141, BR-TEXT-23, read by notification-appeal-result): true only when this
//   revocation lifted a ban and linking's read (after restoreAfterUnban, same transaction) finds
//   the user's Taobao binding invalid, else false. Any failure rolls all of it
//   back.
// - register: the reason (appealConsoleText), the target (account: banned / frozen / appealing in
//   this app; order: voided by risk control, through the port; blocked_request: a 44001 request of
//   this app with a request type) and user_id against the appellant the server derives (20001);
//   then a processing appeal on the target (a register-type request: also on its related phone) is
//   returned with nothing written; then the attempt cap (30418, every target type —
//   BR-ID-36: a registered blocked_request appeal counts too —, the rule of appeals.ts); then the insert (source admin, registered_by caller, deadline by the
//   working-day calendar) and, for an account appeal, risk state appealing; audit appeal_register.
//   A concurrent insert losing on a processing unique index answers the winner's appeal.
//
// TODO(规划/11 §4.5): 撤销 cause rule 的被拦请求申诉后的一次性放行 — blocked on 放行凭据的存放与校验位置未定（契约只说由服务端内部保存）
//
// What migration 0113 adds (appeals.source / registered_by, app.appeal_claims) is written with raw
// SQL until db.gen.ts is regenerated (pnpm db:snapshot). Notes and reasons go to the audit log only;
// nothing logged or audited carries a phone number or an HMAC.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  newUuidV7,
  type AuditPort,
  type Clock,
  type EventBus,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import type { AdminAppealsActor, AdminAppealsRead } from './admin-appeals-read.ts';
import { appealRevokePermission, blockedRequestCause } from './admin-appeals-read.ts';
import { resolveAppealDeadline } from './appeal-calendar.ts';
import {
  MAX_APPEAL_ATTEMPTS,
  appealAttempts,
  nextAppealAttempt,
  type AppealHistoryRow,
} from './appeals.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';
import {
  raiseRiskStateStamp,
  type RiskReasonCategory,
  type RiskStateService,
} from './risk-state.ts';

/** What resolving an appeal needs to know (CT-24r adminResolveAppeal; 编排裁定 D10-154). */
export interface AppealResolveRequirementInput {
  readonly decision: Schema<'AdminAppealDecision'>;
  readonly target_type: Schema<'AdminAppealTargetType'>;
  /** appeals.prev_risk_state: banned / frozen for an account appeal, else null. */
  readonly prev_risk_state: Schema<'AdminAppealPrevRiskState'> | null;
  /** The blocked request's cause for a blocked_request appeal, else null. */
  readonly cause: Schema<'AdminBlockedRequestCause'> | null;
}

/** What a resolution needs on top of risk.appeal. */
export interface AppealResolveRequirement {
  /** The extra permission point; null when risk.appeal alone is enough. */
  readonly permission: Schema<'AdminAppealRevokePermission'> | null;
  /** The step-up tier; null when no step-up is needed. */
  readonly step_up: 'totp' | null;
}

const NO_REQUIREMENT: AppealResolveRequirement = Object.freeze({ permission: null, step_up: null });
const TEXT_MAX = 200;

/**
 * The extra permission point and step-up tier of a resolution: revoking an account appeal against
 * a ban needs risk.ban, against a freeze risk.freeze, and revoking a blocked_request appeal with
 * cause blocklist risk.blocklist, each with a totp step-up; anything else needs neither.
 */
export function appealResolveRequirement(
  input: AppealResolveRequirementInput,
): AppealResolveRequirement {
  if (input.decision !== 'revoked') return NO_REQUIREMENT;
  const permission = appealRevokePermission(input);
  return permission === null ? NO_REQUIREMENT : { permission, step_up: 'totp' };
}

/**
 * The resolve note / registration reason as stored in the audit record: the value trimmed of
 * surrounding whitespace when it is a string of 1–200 characters after trimming, else null (the
 * caller answers 20001 naming the field).
 */
export function appealConsoleText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= TEXT_MAX ? trimmed : null;
}

/** The console caller of a write. */
export interface AdminAppealsWriteActor extends AdminAppealsActor {
  /** admin_users.login_name: user_risk_state.changed_by of a state the console changes. */
  readonly loginName: string;
}

/** Reads of other modules' tables, built by app.module (risk imports none of those modules). */
export interface AdminAppealsWritePorts {
  /**
   * orders: the owner (user_id) of this app's sub-order whose rebate risk control voided or clawed
   * back (rebate_status VOID or CLAWED_BACK, reason BLACKLIST; BR-ATTR-26, D10-1180), or null when
   * there is no such order.
   */
  voidedOrderOwner(appId: string, orderId: string): Promise<string | null>;
}

export interface AdminAppealsWriteOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly events: EventBus;
  readonly riskState: RiskStateService;
  /** The cross-process risk state stamp, written again after a commit that changed a state. */
  readonly redis?: RedisHandle;
  /** The working-day calendar (content's configuration reader on the pool). */
  readonly config: RateLimitConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
  /** admin's audit writer bound to the write's transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** linking's restore of the bindings blocked for ban, on the caller's transaction. */
  readonly restoreAfterUnban: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string; readonly clock: Clock },
  ) => Promise<void>;
  /**
   * linking's read of whether the user's Taobao binding is now invalid (SELECT only, on the
   * caller's transaction): the need_reauth of a revoked ban appeal's appeal.resolved.
   */
  readonly taobaoReauth: (
    trx: Transaction<DB>,
    scope: { readonly appId: string; readonly userId: string },
  ) => Promise<boolean>;
  readonly ports: AdminAppealsWritePorts;
  /** The detail read every answer is. */
  readonly reads: AdminAppealsRead;
}

/** 20001 with data.fields. */
export class AdminAppealsWriteFieldsError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`risk: admin appeal write refused (${fields.join(', ')})`);
    this.name = 'AdminAppealsWriteFieldsError';
    this.fields = fields;
  }
}

/** 20902 with data.resource=appeal: no longer processing, or another row_version. */
export class AdminAppealConflictError extends Error {
  constructor() {
    super('risk: the appeal changed');
    this.name = 'AdminAppealConflictError';
  }
}

/** 30418: the appeals of the target (and penalty) are used up. */
export class AdminAppealAttemptsUsedUpError extends Error {
  constructor() {
    super('risk: the appeal attempts are used up');
    this.name = 'AdminAppealAttemptsUsedUpError';
  }
}

/** A checked resolution: what it needs on top of risk.appeal, and the write itself. */
export interface PreparedResolution {
  readonly requirement: AppealResolveRequirement;
  readonly run: () => Promise<Schema<'AdminAppealDetail'>>;
}

type Decision = Schema<'AdminAppealDecision'>;
type TargetType = Schema<'AdminAppealTargetType'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAMP_ATTEMPTS = 3;
const BLOCKLIST_RULE_PREFIX = 'BLACKLIST_';

interface AppealRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly prev_risk_state: string | null;
  readonly status: string;
  readonly handler_id: string | null;
  readonly row_version: number;
}

const APPEAL_COLUMNS = [
  'id',
  'user_id',
  'target_type',
  'target_id',
  'prev_risk_state',
  'status',
  'handler_id',
  'row_version',
] as const;

/** A target as register found it. */
interface RegisterTarget {
  readonly target_type: TargetType;
  readonly target_id: string;
  /** The appellant the server derives (null: a register-type blocked request). */
  readonly user_id: string | null;
  readonly request_type: string | null;
  readonly related_phone_hmac: string | null;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function bodyOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

export class AdminAppealsWrite {
  readonly #db: Kysely<DB>;
  readonly #clock: Clock;
  readonly #events: EventBus;
  readonly #riskState: RiskStateService;
  readonly #redis: RedisHandle | undefined;
  readonly #config: RateLimitConfigReader;
  readonly #logger: Pick<RootLogger, 'warn'>;
  readonly #auditOn: AdminAppealsWriteOptions['auditOn'];
  readonly #restoreAfterUnban: AdminAppealsWriteOptions['restoreAfterUnban'];
  readonly #taobaoReauth: AdminAppealsWriteOptions['taobaoReauth'];
  readonly #ports: AdminAppealsWritePorts;
  readonly #reads: AdminAppealsRead;

  constructor(options: AdminAppealsWriteOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#events = options.events;
    this.#riskState = options.riskState;
    this.#redis = options.redis;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#auditOn = options.auditOn;
    this.#restoreAfterUnban = options.restoreAfterUnban;
    this.#taobaoReauth = options.taobaoReauth;
    this.#ports = options.ports;
    this.#reads = options.reads;
  }

  // ---- claim ----

  async claim(
    actor: AdminAppealsWriteActor,
    appealId: string,
    body: unknown,
  ): Promise<Schema<'AdminAppealDetail'>> {
    const expected = bodyOf(body)['expected_row_version'];
    if (!isVersion(expected)) throw new AdminAppealsWriteFieldsError(['expected_row_version']);
    if (!UUID.test(appealId)) throw new AdminAppealsWriteFieldsError(['appeal_id']);
    await this.#db.transaction().execute(async (trx) => {
      const before = await trx
        .withSchema('app')
        .selectFrom('appeals')
        .select(['status', 'handler_id', 'row_version'])
        .where('app_id', '=', actor.appId)
        .where('id', '=', appealId)
        .forUpdate()
        .executeTakeFirst();
      if (before === undefined) throw new AdminAppealsWriteFieldsError(['appeal_id']);
      if (before.status !== 'processing' || Number(before.row_version) !== expected) {
        throw new AdminAppealConflictError();
      }
      const now = this.#clock.now();
      // The compare-and-set is the statement itself: status and row_version in the WHERE.
      const updated = await sql`
        UPDATE app.appeals
           SET handler_id = ${actor.adminId},
               row_version = row_version + 1,
               updated_at = ${now}
         WHERE app_id = ${actor.appId}
           AND id = ${appealId}
           AND status = 'processing'
           AND row_version = ${expected}
        RETURNING handler_id`.execute(trx);
      if (updated.rows.length !== 1) throw new AdminAppealConflictError();
      // The claim time of this version of the appeal (insert-only; a later write raises the
      // version, so the detail then reads no claim time).
      await sql`
        INSERT INTO app.appeal_claims (id, app_id, appeal_id, row_version, handler_id, claimed_at,
                                       created_at)
        VALUES (${newUuidV7(now)}, ${actor.appId}, ${appealId}, ${expected + 1}, ${actor.adminId},
                ${now}, ${now})`.execute(trx);
      await this.#auditOn(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'appeal_claim',
        target: appealId,
        before: { appeal_id: appealId, handler_id: before.handler_id, row_version: expected },
        after: {
          appeal_id: appealId,
          handler_id: actor.adminId,
          claimed_at: now.toISOString(),
          row_version: expected + 1,
        },
        ip: actor.ip,
      });
    });
    return this.#reads.get(actor, appealId);
  }

  // ---- resolve ----

  /**
   * The checks of a resolution up to the extra permission point (contract order: body → appeal_id
   * → state / version); the returned closure writes it. The closure judges state and version again
   * under the row lock, so a change between the two answers 20902.
   */
  async prepareResolve(
    actor: AdminAppealsWriteActor,
    appealId: string,
    body: unknown,
  ): Promise<PreparedResolution> {
    const input = bodyOf(body);
    const decision = input['decision'];
    if (decision !== 'upheld' && decision !== 'revoked') {
      throw new AdminAppealsWriteFieldsError(['decision']);
    }
    const note = appealConsoleText(input['note']);
    if (note === null) throw new AdminAppealsWriteFieldsError(['note']);
    const expected = input['expected_row_version'];
    if (!isVersion(expected)) throw new AdminAppealsWriteFieldsError(['expected_row_version']);
    if (!UUID.test(appealId)) throw new AdminAppealsWriteFieldsError(['appeal_id']);
    const row: AppealRow | undefined = await this.#db
      .withSchema('app')
      .selectFrom('appeals')
      .select(APPEAL_COLUMNS)
      .where('app_id', '=', actor.appId)
      .where('id', '=', appealId)
      .executeTakeFirst();
    if (row === undefined) throw new AdminAppealsWriteFieldsError(['appeal_id']);
    if (row.status !== 'processing' || Number(row.row_version) !== expected) {
      throw new AdminAppealConflictError();
    }
    const ruleIds =
      row.target_type === 'blocked_request'
        ? await this.#blockedRuleIds(this.#db, actor.appId, row.target_id)
        : [];
    const cause = row.target_type === 'blocked_request' ? blockedRequestCause(ruleIds).cause : null;
    const requirement = appealResolveRequirement({
      decision,
      target_type: row.target_type as TargetType,
      prev_risk_state: row.prev_risk_state as Schema<'AdminAppealPrevRiskState'> | null,
      cause,
    });
    return {
      requirement,
      run: () => this.#resolve(actor, appealId, decision, note, expected),
    };
  }

  async #resolve(
    actor: AdminAppealsWriteActor,
    appealId: string,
    decision: Decision,
    note: string,
    expected: number,
  ): Promise<Schema<'AdminAppealDetail'>> {
    const stamped = await this.#db.transaction().execute(async (trx) => {
      const app = trx.withSchema('app');
      const row: AppealRow | undefined = await app
        .selectFrom('appeals')
        .select(APPEAL_COLUMNS)
        .where('app_id', '=', actor.appId)
        .where('id', '=', appealId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) throw new AdminAppealsWriteFieldsError(['appeal_id']);
      if (row.status !== 'processing' || Number(row.row_version) !== expected) {
        throw new AdminAppealConflictError();
      }
      const now = this.#clock.now();
      const updated = await sql`
        UPDATE app.appeals
           SET status = ${decision},
               closed_at = ${now},
               handler_id = ${actor.adminId},
               row_version = row_version + 1,
               updated_at = ${now}
         WHERE app_id = ${actor.appId}
           AND id = ${appealId}
           AND status = 'processing'
           AND row_version = ${expected}
        RETURNING id`.execute(trx);
      if (updated.rows.length !== 1) throw new AdminAppealConflictError();

      let riskBefore: string | null = null;
      let riskAfter: string | null = null;
      let stamp: { userId: string; version: number } | null = null;
      let needReauth = false;
      if (row.target_type === 'account' && row.user_id !== null) {
        const changed = await this.#closeAccount(trx, actor, row, decision);
        riskBefore = changed.before;
        riskAfter = changed.after;
        stamp = changed.version === null ? null : { userId: row.user_id, version: changed.version };
        needReauth = changed.unbanned
          ? await this.#taobaoReauth(trx, { appId: actor.appId, userId: row.user_id })
          : false;
      }
      const removed =
        row.target_type === 'blocked_request' && decision === 'revoked'
          ? await this.#removeBlocklistEntries(trx, actor, row)
          : [];

      await this.#auditOn(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'appeal_resolve',
        target: appealId,
        before: {
          appeal_id: appealId,
          target_type: row.target_type,
          target_id: row.target_id,
          user_id: row.user_id,
          status: row.status,
          handler_id: row.handler_id,
          risk_state: riskBefore,
          row_version: expected,
        },
        after: {
          appeal_id: appealId,
          decision,
          note,
          status: decision,
          handler_id: actor.adminId,
          closed_at: now.toISOString(),
          risk_state: riskAfter,
          removed_blocklist_ids: removed,
          row_version: expected + 1,
        },
        ip: actor.ip,
      });
      await this.#events.publish(trx, {
        appId: actor.appId,
        name: 'appeal.resolved',
        payload: {
          app_id: actor.appId,
          appeal_id: appealId,
          user_id: row.user_id,
          target_type: row.target_type,
          target_id: row.target_id,
          status: decision,
          need_reauth: needReauth,
        },
      });
      return stamp;
    });
    if (stamped !== null) await this.#stampAfterCommit(actor.appId, stamped);
    return this.#reads.get(actor, appealId);
  }

  /**
   * Puts an account back as the decision says (BR-ID-36): upheld → prev_risk_state (a freeze with
   * the frozen_until it kept while appealing), revoked → normal (a ban unbanned as BR-ID-31: the
   * bindings blocked for ban come back). Only an appealing account is changed: a state someone
   * else changed meanwhile is left as it is.
   */
  async #closeAccount(
    trx: Transaction<DB>,
    actor: AdminAppealsWriteActor,
    row: AppealRow,
    decision: Decision,
  ): Promise<{
    before: string | null;
    after: string | null;
    version: number | null;
    /** A ban lifted by this revocation (restoreAfterUnban ran). */
    unbanned: boolean;
  }> {
    const userId = row.user_id!;
    const app = trx.withSchema('app');
    // The user lock first, as the console's risk state change and linking's binding writers take
    // it (users → risk row): no lock cycle with them.
    await app
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', actor.appId)
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const current = await app
      .selectFrom('user_risk_state')
      .select(['state', 'reason', 'reason_category', 'frozen_until', 'row_version'])
      .where('app_id', '=', actor.appId)
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined || current.state !== 'appealing') {
      const state = current?.state ?? null;
      return { before: state, after: state, version: null, unbanned: false };
    }
    const prev = row.prev_risk_state;
    const version = Number(current.row_version);
    if (decision === 'upheld' && (prev === 'banned' || prev === 'frozen')) {
      await this.#riskState.setRiskState(trx, {
        app_id: actor.appId,
        user_id: userId,
        state: prev,
        reason: current.reason,
        reason_category: current.reason_category as RiskReasonCategory | null,
        frozen_until: prev === 'frozen' ? current.frozen_until : null,
        changed_by: actor.loginName,
        expected_row_version: version,
      });
      return { before: 'appealing', after: prev, version: version + 1, unbanned: false };
    }
    if (decision === 'revoked') {
      await this.#riskState.setRiskState(trx, {
        app_id: actor.appId,
        user_id: userId,
        state: 'normal',
        reason: current.reason,
        reason_category: null,
        frozen_until: null,
        changed_by: actor.loginName,
        expected_row_version: version,
      });
      if (prev === 'banned') {
        await this.#restoreAfterUnban(trx, {
          appId: actor.appId,
          userId,
          clock: this.#clock,
        });
      }
      return {
        before: 'appealing',
        after: 'normal',
        version: version + 1,
        unbanned: prev === 'banned',
      };
    }
    return { before: 'appealing', after: 'appealing', version: null, unbanned: false };
  }

  /**
   * Makes inactive the active blocklist entries that blocked the request (its BLACKLIST_<DIMENSION>
   * hits: same dimension and value HMAC; BR-ID-31, 编排裁定 D10-154), each removal audited with the
   * entry id only. Returns the ids removed.
   */
  async #removeBlocklistEntries(
    trx: Transaction<DB>,
    actor: AdminAppealsWriteActor,
    row: AppealRow,
  ): Promise<string[]> {
    const app = trx.withSchema('app');
    const hits = await app
      .selectFrom('risk_hits')
      .select(['rule_id', 'dimension', 'value_hmac'])
      .where('app_id', '=', actor.appId)
      .where('ref_type', '=', 'blocked_request')
      .where('ref_id', '=', row.target_id)
      .where('rule_id', 'like', `${BLOCKLIST_RULE_PREFIX}%`)
      .execute();
    const removed: string[] = [];
    const now = this.#clock.now();
    for (const hit of hits) {
      if (hit.dimension === null || hit.value_hmac === null) continue;
      const entries = await app
        .updateTable('blocklist')
        .set((eb) => ({
          status: 'inactive',
          row_version: eb('row_version', '+', 1),
          updated_at: now,
        }))
        .where('app_id', '=', actor.appId)
        .where('dimension', '=', hit.dimension)
        .where('value_hmac', '=', hit.value_hmac)
        .where('status', '=', 'active')
        .returning(['id', 'dimension', 'violation_type'])
        .execute();
      for (const entry of entries) {
        removed.push(entry.id);
        await this.#auditOn(trx).append({
          appId: actor.appId,
          actor: actor.adminId,
          action: 'blocklist_remove',
          target: entry.id,
          before: {
            blocklist_id: entry.id,
            dimension: entry.dimension,
            violation_type: entry.violation_type,
            status: 'active',
          },
          after: { blocklist_id: entry.id, status: 'inactive', appeal_id: row.id },
          ip: actor.ip,
        });
      }
    }
    return removed;
  }

  // ---- register ----

  async register(
    actor: AdminAppealsWriteActor,
    body: unknown,
  ): Promise<Schema<'AdminAppealDetail'>> {
    const input = bodyOf(body);
    const reason = appealConsoleText(input['reason']);
    if (reason === null) throw new AdminAppealsWriteFieldsError(['reason']);
    const content = input['content'];
    if (typeof content !== 'string' || content.length === 0) {
      throw new AdminAppealsWriteFieldsError(['content']);
    }
    const target = await this.#target(actor.appId, input['target_type'], input['target_id']);
    const userId = input['user_id'];
    if (userId !== undefined && userId !== target.user_id) {
      throw new AdminAppealsWriteFieldsError(['user_id']);
    }
    let appealId: string;
    try {
      const written = await this.#db
        .transaction()
        .execute((trx) => this.#registerOn(trx, actor, target, content, reason));
      appealId = written.id;
      if (written.riskVersion !== null) {
        await this.#stampAfterCommit(actor.appId, {
          userId: target.target_id,
          version: written.riskVersion,
        });
      }
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      // A concurrent registration (or submission) won the processing unique index: its appeal.
      const existing = await this.#processing(this.#db, actor.appId, target);
      if (existing === undefined) throw error;
      appealId = existing;
    }
    return this.#reads.get(actor, appealId);
  }

  async #registerOn(
    trx: Transaction<DB>,
    actor: AdminAppealsWriteActor,
    target: RegisterTarget,
    content: string,
    reason: string,
  ): Promise<{ readonly id: string; readonly riskVersion: number | null }> {
    const app = trx.withSchema('app');
    let account:
      | {
          readonly state: string;
          readonly reason: string | null;
          readonly reason_category: string | null;
          readonly frozen_until: Date | null;
          readonly changed_at: Date;
          readonly penalty_started_at: Date | null;
        }
      | undefined;
    if (target.target_type === 'account') {
      // The risk row locked (never the cache), as the app's submission does: concurrent
      // registrations and submissions of one account are serialised here.
      account = await app
        .selectFrom('user_risk_state')
        .select([
          'state',
          'reason',
          'reason_category',
          'frozen_until',
          'changed_at',
          'penalty_started_at',
        ])
        .where('app_id', '=', actor.appId)
        .where('user_id', '=', target.target_id)
        .forUpdate()
        .executeTakeFirst();
      if (
        account === undefined ||
        (account.state !== 'banned' && account.state !== 'frozen' && account.state !== 'appealing')
      ) {
        throw new AdminAppealsWriteFieldsError(['target_id']);
      }
    }
    const existing = await this.#processing(trx, actor.appId, target);
    if (existing !== undefined) return { id: existing, riskVersion: null };
    if (account !== undefined && account.state === 'appealing') {
      // Appealing without a processing account appeal: nothing to return, nothing to appeal.
      throw new AdminAppealsWriteFieldsError(['target_id']);
    }
    // BR-ID-36 细则「维持后再申诉」: every target type, a registered blocked_request appeal too.
    if (!(await this.#attemptsLeft(trx, actor.appId, target, account))) {
      throw new AdminAppealAttemptsUsedUpError();
    }

    const deadline = await resolveAppealDeadline({
      appId: actor.appId,
      clock: this.#clock,
      config: this.#config,
      logger: this.#logger,
    });
    const now = this.#clock.now();
    const id = newUuidV7(now);
    const prev = account === undefined ? null : account.state;
    const penalty = account === undefined ? null : account.penalty_started_at;
    await sql`
      INSERT INTO app.appeals (
        id, app_id, user_id, target_type, request_type, target_id, related_phone_hmac,
        prev_risk_state, status, content, deadline_at, handler_id, closed_at, row_version,
        created_at, updated_at, penalty_started_at, source, registered_by
      ) VALUES (
        ${id}, ${actor.appId}, ${target.user_id}, ${target.target_type}, ${target.request_type},
        ${target.target_id}, ${target.related_phone_hmac}, ${prev}, 'processing', ${content},
        ${deadline}, NULL, NULL, 0, ${now}, ${now}, ${penalty}, 'admin', ${actor.adminId}
      )`.execute(trx);
    let riskVersion: number | null = null;
    if (account !== undefined) {
      await this.#riskState.setRiskState(trx, {
        app_id: actor.appId,
        user_id: target.target_id,
        state: 'appealing',
        reason: account.reason,
        reason_category: account.reason_category as RiskReasonCategory | null,
        frozen_until: account.frozen_until,
        changed_by: actor.loginName,
      });
      riskVersion = await this.#riskVersion(trx, actor.appId, target.target_id);
    }
    await this.#auditOn(trx).append({
      appId: actor.appId,
      actor: actor.adminId,
      action: 'appeal_register',
      target: id,
      before: null,
      after: {
        appeal_id: id,
        target_type: target.target_type,
        target_id: target.target_id,
        user_id: target.user_id,
        request_type: target.request_type,
        prev_risk_state: prev,
        source: 'admin',
        registered_by: actor.adminId,
        reason,
      },
      ip: actor.ip,
    });
    return { id, riskVersion };
  }

  /** The target of a registration and its appellant; anything not appealable → 20001 target_id. */
  async #target(appId: string, type: unknown, id: unknown): Promise<RegisterTarget> {
    if (type !== 'account' && type !== 'order' && type !== 'blocked_request') {
      throw new AdminAppealsWriteFieldsError(['target_type']);
    }
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw new AdminAppealsWriteFieldsError(['target_id']);
    }
    const targetId = id.toLowerCase();
    const base = { target_type: type, target_id: targetId } as const;
    if (type === 'account') {
      // Eligibility (banned / frozen / appealing) is judged on the locked risk row.
      return { ...base, user_id: targetId, request_type: null, related_phone_hmac: null };
    }
    if (type === 'order') {
      const owner = await this.#ports.voidedOrderOwner(appId, targetId);
      if (owner === null) throw new AdminAppealsWriteFieldsError(['target_id']);
      return { ...base, user_id: owner, request_type: null, related_phone_hmac: null };
    }
    const hit = await this.#db
      .withSchema('app')
      .selectFrom('risk_hits')
      .select([
        sql<string | null>`max(request_type)`.as('request_type'),
        sql<string | null>`max(user_id::text)`.as('user_id'),
        sql<string | null>`max(related_phone_hmac)`.as('related_phone_hmac'),
        sql<string>`count(*)`.as('rows'),
      ])
      .where('app_id', '=', appId)
      .where('ref_type', '=', 'blocked_request')
      .where('ref_id', '=', targetId)
      .executeTakeFirst();
    if (hit === undefined || Number(hit.rows) === 0 || hit.request_type === null) {
      throw new AdminAppealsWriteFieldsError(['target_id']);
    }
    const register = hit.request_type === 'register';
    const userId = register ? null : hit.user_id;
    if (!register && userId === null) throw new AdminAppealsWriteFieldsError(['target_id']);
    const phoneBound = hit.request_type === 'register' || hit.request_type === 'phone_change';
    if (phoneBound && hit.related_phone_hmac === null) {
      throw new AdminAppealsWriteFieldsError(['target_id']);
    }
    return {
      ...base,
      user_id: userId,
      request_type: hit.request_type,
      related_phone_hmac: hit.related_phone_hmac,
    };
  }

  /** The processing appeal on the target (a register-type request: also on its related phone). */
  async #processing(
    executor: Kysely<DB> | Transaction<DB>,
    appId: string,
    target: RegisterTarget,
  ): Promise<string | undefined> {
    const row = await executor
      .withSchema('app')
      .selectFrom('appeals')
      .select('id')
      .where('app_id', '=', appId)
      .where('status', '=', 'processing')
      .where((eb) => {
        const same = eb.and([
          eb('target_type', '=', target.target_type),
          eb('target_id', '=', target.target_id),
        ]);
        if (target.request_type !== 'register' || target.related_phone_hmac === null) return same;
        return eb.or([
          same,
          eb.and([
            eb('request_type', '=', 'register'),
            eb('related_phone_hmac', '=', target.related_phone_hmac),
          ]),
        ]);
      })
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    return row?.id;
  }

  /**
   * Whether a new appeal on the target is within the cap (BR-ID-36 细则; the rule of appeals.ts:
   * every appeal on the target counts, registered ones too; an account by its current penalty).
   */
  async #attemptsLeft(
    trx: Transaction<DB>,
    appId: string,
    target: RegisterTarget,
    account:
      | {
          readonly state: string;
          readonly changed_at: Date;
          readonly penalty_started_at: Date | null;
        }
      | undefined,
  ): Promise<boolean> {
    const rows: AppealHistoryRow[] = await trx
      .withSchema('app')
      .selectFrom('appeals')
      .select([
        'id',
        'target_type',
        'target_id',
        'status',
        'prev_risk_state',
        'created_at',
        'closed_at',
        'penalty_started_at',
      ])
      .where('app_id', '=', appId)
      .where('target_type', '=', target.target_type)
      .where('target_id', '=', target.target_id)
      .execute();
    if (rows.length === 0) return true;
    const attempts = appealAttempts(rows, null, this.#clock.now());
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
    const next =
      account === undefined
        ? nextAppealAttempt(latest, latestAttempt, null)
        : nextAppealAttempt(
            latest,
            latestAttempt,
            account.state,
            account.changed_at,
            account.penalty_started_at,
          );
    return next <= MAX_APPEAL_ATTEMPTS;
  }

  async #riskVersion(trx: Transaction<DB>, appId: string, userId: string): Promise<number> {
    const row = await trx
      .withSchema('app')
      .selectFrom('user_risk_state')
      .select('row_version')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.row_version);
  }

  /** The blocked request's rule codes, in hit order. */
  async #blockedRuleIds(
    executor: Kysely<DB> | Transaction<DB>,
    appId: string,
    blockedRequestId: string,
  ): Promise<string[]> {
    const rows = await executor
      .withSchema('app')
      .selectFrom('risk_hits')
      .select('rule_id')
      .where('app_id', '=', appId)
      .where('ref_type', '=', 'blocked_request')
      .where('ref_id', '=', blockedRequestId)
      .orderBy('id')
      .execute();
    return rows.map((row) => row.rule_id);
  }

  /**
   * After the commit the stamp is written again with the same version (it may have been lost
   * between setRiskState's write and the commit): bounded tries, then one warn line.
   */
  async #stampAfterCommit(
    appId: string,
    stamped: { readonly userId: string; readonly version: number },
  ): Promise<void> {
    const redis = this.#redis;
    if (redis === undefined) return;
    for (let attempt = 1; attempt <= STAMP_ATTEMPTS; attempt += 1) {
      try {
        await raiseRiskStateStamp(
          redis,
          { app_id: appId, user_id: stamped.userId },
          stamped.version,
        );
        return;
      } catch {
        // Retried below; nothing identifying is logged.
      }
    }
    this.#logger.warn(
      { event: 'risk.state_stamp_after_commit_failed', app_id: appId, attempts: STAMP_ATTEMPTS },
      'risk: the risk state stamp was not written after the appeal was resolved',
    );
  }
}
