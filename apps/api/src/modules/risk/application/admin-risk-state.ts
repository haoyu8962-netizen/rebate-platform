// F1-07d: the console's ban / unban / freeze / unfreeze of a user (PUT /admin/v1/users/{user_id}/
// risk-state, adminUpdateUserRiskState; BR-ID-31, 04 §6.6 / §11.2). The controller has checked the
// admin account, the permission point (ban / unban: risk.ban; freeze / unfreeze: risk.freeze) and
// its totp step-up; the route schema has checked the body's shape. Here:
// - the body rules the schema cannot say (20001 with the field): reason_category required for ban
//   and freeze, not accepted for unban and unfreeze; frozen_until only for freeze, and then later
//   than the Clock's now (no upper bound; null or absent = without end);
// - Redis is required: without it the change is refused before anything is written (50001), as
//   other processes could not learn of it (risk-state.ts, the version stamp);
// - one transaction: first the user lock (`app.users … FOR NO KEY UPDATE`, the lock every writer
//   of the user's union bindings takes, linking's binding-lock.ts; NO KEY UPDATE so the KEY SHARE
//   of child-table inserts never blocks it; no such user in the console's app → 20001 user_id),
//   for freeze and unfreeze as well; then the risk state as read under it: expected_row_version
//   against the row (null only while there is no row, an integer only the current row_version;
//   otherwise 20902 user_risk_state), then the state rule (44004): ban and freeze from normal or
//   frozen (no row = normal), unban only from banned, unfreeze only from frozen, appealing never;
//   then risk-state.ts setRiskState with the same expected_row_version (the single writer of
//   user_risk_state, which publishes risk.state_changed on this transaction and writes the stamp);
//   then the effects through ports app.module wires (risk imports neither identity nor linking):
//   ban → every session of the user revoked with reason banned, and linking's blockForBan; unban →
//   linking's restoreAfterUnban (Taobao invalid, other unions active); freeze and unfreeze touch
//   neither. A ban writes no withdrawal: the banned state itself refuses new requests (10006) and
//   leaves existing ones to finance (BR-ID-31, BR-WDR-05). Then one audit row
//   (user_risk_state_change, before / after state, reason category and reason) and the stamp once
//   more, last before the commit;
// - after the commit the stamp is written again with the same version (it may have been lost
//   between the first write and the commit while another process rebuilt its old baseline): a
//   bounded number of tries, then one warn line; the change stands.
// Every failure inside the transaction rolls all of it back.
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on CT-04 状态机生成器
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, EventBus, RedisHandle, RootLogger } from '../../platform/index.ts';
import {
  RiskStateConflictError,
  raiseRiskStateStamp,
  type RiskReasonCategory,
  type RiskStateService,
} from './risk-state.ts';

export interface AdminRiskStateCommand {
  readonly appId: string;
  readonly userId: string;
  readonly adminId: string;
  readonly adminUsername: string;
  readonly ip: string | null;
  readonly body: Schema<'AdminUserRiskStateUpdateRequest'>;
}

/** Ports are wired by app.module; risk must not import identity or linking. */
export interface AdminRiskStateOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly events: EventBus;
  readonly riskState: RiskStateService;
  readonly redis?: RedisHandle;
  readonly logger: Pick<RootLogger, 'warn'>;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly revokeSessions: (
    trx: Transaction<DB>,
    input: { readonly app_id: string; readonly user_id: string; readonly reason: 'banned' },
  ) => Promise<readonly string[]>;
  readonly blockForBan: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string; readonly clock: Clock },
  ) => Promise<void>;
  readonly restoreAfterUnban: AdminRiskStateOptions['blockForBan'];
}

export type AdminRiskAction = 'ban' | 'unban' | 'freeze' | 'unfreeze';
type RiskStateValue = 'normal' | 'frozen' | 'banned' | 'appealing';

/** 20001 with data.fields. */
export class AdminRiskStateFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`risk: invalid ${fields.join(', ')}`);
    this.name = 'AdminRiskStateFieldsError';
    this.fields = fields;
  }
}

/** 44004: the user's risk state does not allow the action. */
export class AdminRiskStateNotAllowedError extends Error {
  constructor() {
    super('risk: the user risk state does not allow the action');
    this.name = 'AdminRiskStateNotAllowedError';
  }
}

/** The contract's state rules (adminUpdateUserRiskState); no row reads as normal. */
const FROM: Readonly<Record<AdminRiskAction, readonly RiskStateValue[]>> = {
  ban: ['normal', 'frozen'],
  unban: ['banned'],
  freeze: ['normal', 'frozen'],
  unfreeze: ['frozen'],
};

const TO: Readonly<Record<AdminRiskAction, RiskStateValue>> = {
  ban: 'banned',
  unban: 'normal',
  freeze: 'frozen',
  unfreeze: 'normal',
};

const CATEGORIES: ReadonlySet<unknown> = new Set<RiskReasonCategory>([
  'malicious_rights',
  'fraud_invite',
  'abnormal_trade',
  'account_security',
  'other',
]);

/** Writes of the stamp after the commit before the warn line. */
const STAMP_ATTEMPTS = 3;
const REASON_MAX = 200;

function isAction(value: unknown): value is AdminRiskAction {
  return value === 'ban' || value === 'unban' || value === 'freeze' || value === 'unfreeze';
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

interface Checked {
  readonly action: AdminRiskAction;
  readonly reason: string;
  readonly reasonCategory: RiskReasonCategory | null;
  readonly frozenUntil: Date | null;
  readonly expected: number | null;
}

/** The body rules on top of the route schema (re-checked: the service may be called directly). */
function check(body: unknown, now: Date): Checked {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const has = (name: string) => Object.prototype.hasOwnProperty.call(input, name);
  const fields: string[] = [];
  const action = input['action'];
  if (!isAction(action)) throw new AdminRiskStateFieldsError(['action']);
  const reason = input['reason'];
  if (typeof reason !== 'string' || reason.length === 0 || [...reason].length > REASON_MAX) {
    fields.push('reason');
  }
  const category = input['reason_category'];
  const needsCategory = action === 'ban' || action === 'freeze';
  if (needsCategory ? !CATEGORIES.has(category) : has('reason_category')) {
    fields.push('reason_category');
  }
  let frozenUntil: Date | null = null;
  if (action === 'freeze') {
    const value = input['frozen_until'];
    if (value !== undefined && value !== null) {
      const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(at) || at <= now.getTime()) {
        fields.push('frozen_until');
      } else {
        // A new Date from the Clock's instant (never modified), set to the given time.
        frozenUntil = structuredClone(now);
        frozenUntil.setTime(at);
      }
    }
  } else if (has('frozen_until')) {
    fields.push('frozen_until');
  }
  const expected = input['expected_row_version'];
  if (expected !== null && !(Number.isSafeInteger(expected) && (expected as number) >= 0)) {
    fields.push('expected_row_version');
  }
  if (fields.length > 0) throw new AdminRiskStateFieldsError(fields);
  return {
    action,
    reason: reason as string,
    reasonCategory: needsCategory ? (category as RiskReasonCategory) : null,
    frozenUntil,
    expected: expected as number | null,
  };
}

export class AdminRiskState {
  // RISK_STATE_CHANGED 站内信由通知线消费 risk.state_changed 发送（notification/application/risk-state-message.ts，B1-12g）。
  readonly #db: Kysely<DB>;
  readonly #clock: Clock;
  readonly #riskState: RiskStateService;
  readonly #redis: RedisHandle | undefined;
  readonly #logger: Pick<RootLogger, 'warn'>;
  readonly #auditOn: AdminRiskStateOptions['auditOn'];
  readonly #revokeSessions: AdminRiskStateOptions['revokeSessions'];
  readonly #blockForBan: AdminRiskStateOptions['blockForBan'];
  readonly #restoreAfterUnban: AdminRiskStateOptions['restoreAfterUnban'];

  constructor(options: AdminRiskStateOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#riskState = options.riskState;
    this.#redis = options.redis;
    this.#logger = options.logger;
    this.#auditOn = options.auditOn;
    this.#revokeSessions = options.revokeSessions;
    this.#blockForBan = options.blockForBan;
    this.#restoreAfterUnban = options.restoreAfterUnban;
  }

  async apply(command: AdminRiskStateCommand): Promise<Schema<'AdminUserRiskState'>> {
    const checked = check(command.body, this.#clock.now());
    const redis = this.#redis;
    if (redis === undefined) {
      // Fail closed: other processes would keep serving the old state from their caches.
      throw new Error('risk: admin risk state changes need Redis');
    }
    const { appId, userId } = command;
    const subject = { app_id: appId, user_id: userId };
    const view = await this.#db.transaction().execute(async (trx) => {
      const app = trx.withSchema('app');
      const user = await app
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (user === undefined) throw new AdminRiskStateFieldsError(['user_id']);
      const current = await app
        .selectFrom('user_risk_state')
        .select(['state', 'reason', 'reason_category', 'frozen_until', 'row_version'])
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      const currentVersion = current === undefined ? null : Number(current.row_version);
      // The same compare-and-set setRiskState applies; judged first, on the row as read.
      if (checked.expected !== currentVersion) {
        throw new RiskStateConflictError();
      }
      const from = (current?.state ?? 'normal') as RiskStateValue;
      if (!FROM[checked.action].includes(from)) throw new AdminRiskStateNotAllowedError();
      const to = TO[checked.action];
      await this.#riskState.setRiskState(trx, {
        app_id: appId,
        user_id: userId,
        state: to,
        reason: checked.reason,
        reason_category: checked.reasonCategory,
        frozen_until: checked.frozenUntil,
        changed_by: command.adminUsername,
        expected_row_version: checked.expected,
      });
      if (checked.action === 'ban') {
        await this.#revokeSessions(trx, { app_id: appId, user_id: userId, reason: 'banned' });
        await this.#blockForBan(trx, { appId, userId, clock: this.#clock });
      } else if (checked.action === 'unban') {
        await this.#restoreAfterUnban(trx, { appId, userId, clock: this.#clock });
      }
      const row = await app
        .selectFrom('user_risk_state')
        .select([
          'state',
          'reason',
          'reason_category',
          'frozen_until',
          'changed_by',
          'changed_at',
          'row_version',
        ])
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      const written = Number(row.row_version);
      await this.#auditOn(trx).append({
        appId,
        actor: command.adminId,
        action: 'user_risk_state_change',
        target: userId,
        before: {
          user_id: userId,
          state: from,
          reason_category: current?.reason_category ?? null,
          reason: current?.reason ?? null,
          frozen_until: iso(current?.frozen_until ?? null),
          row_version: currentVersion,
        },
        after: {
          user_id: userId,
          action: checked.action,
          state: row.state,
          reason_category: row.reason_category,
          reason: row.reason,
          frozen_until: iso(row.frozen_until),
          row_version: written,
        },
        ip: command.ip,
      });
      // Last before the commit: a stamp failure rolls the change back (50001).
      await raiseRiskStateStamp(redis, subject, written);
      return {
        state: row.state as Schema<'AdminUserRiskState'>['state'],
        reason_category: row.reason_category as Schema<'AdminUserRiskState'>['reason_category'],
        reason: row.reason,
        frozen_until: iso(row.frozen_until),
        changed_by: row.changed_by,
        changed_at: iso(row.changed_at),
        row_version: written,
      };
    });
    await this.#stampAfterCommit(redis, subject, view.row_version ?? 0);
    return view;
  }

  async #stampAfterCommit(
    redis: RedisHandle,
    subject: { readonly app_id: string; readonly user_id: string },
    version: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= STAMP_ATTEMPTS; attempt += 1) {
      try {
        await raiseRiskStateStamp(redis, subject, version);
        return;
      } catch {
        // Retried; the reason text never reaches the log.
      }
    }
    this.#logger.warn(
      {
        event: 'risk.state_stamp_after_commit_failed',
        app_id: subject.app_id,
        attempts: STAMP_ATTEMPTS,
      },
      'risk: the risk state stamp was not written after the commit',
    );
  }
}
