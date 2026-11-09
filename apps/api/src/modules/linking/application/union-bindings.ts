// B1-06h: POST /v1/unions/{platform}/bindings and GET /v1/unions/bindings (04 §6.3 bindings rows;
// BR-ID-17 细则「授权方式」「授权管理页」「pending_auth 不产生」, BR-ID-19, BR-ID-24 ④).
//
// Submission, in this order (orchestrator ruling D7-3 ②): login (10001) → platform (only taobao
// takes a state and a credential; pdd's body is not in the contract yet, jd has no user
// authorization: 20001 data.fields=[platform]) → platform idempotency (transactional mode) →
// blocked binding of a user who is not banned (30153) → the site authorization of the account this
// authorization uses (30101 / 30102 data.reason=auth_unavailable, same judgement as auth-url) →
// state check ① (exists, this app, taobao, bind, unused, unexpired, uid and device_id match →
// else 30104 without reason) → ②③ (device record's client = state.client, method issued in the
// state and still in union.taobao.auth_methods.<device record's client> → else 30104
// method_not_allowed). None of these touches the state or calls the upstream. Then the state is
// consumed by one conditional UPDATE committed on its own (concurrent submissions: exactly one
// wins, the others 30104), and only then the credential is exchanged with the application the
// state recorded for the method (④: credential_invalid → 30104, state stays used, bindings
// unchanged; an upstream failure → 50001, same). Last, BR-ID-19 decides on the relation id R:
// - another user's active / invalid / blocked row of (app, account, platform, R), or their
//   released row still cooling (cooldown_until > now) → 30151 (conflict kind occupied / cooling);
// - the user's unreleased binding: same account and R → active stays untouched, invalid becomes
//   active (bound_at kept); a different R → 30151 (kind rebind), never replaced;
// - no unreleased binding: the user's own released row of R still cooling → restored to active
//   (release instants cleared, bound_at kept); otherwise a new active row (bound_at = now).
// B1-06z: every 30151 writes one conflict row on the submission's transaction (bindings unchanged;
// ../infra/binding-conflicts.ts, written already resolved when the user has an active binding),
// and every write that makes the binding active resolves the user's unresolved taobao rows in the
// same savepoint (BR-ID-18). A replay of the key answers the stored 30151 and writes nothing.
// The two partial unique indexes stay the arbiter of concurrent writes: a unique violation
// re-reads and decides again (30151 or success), never a 500 and never an application lock.
// Every status written (the new active row, invalid → active, the user's cooling released row →
// active) is first judged by canTransitionBinding (../domain/binding-status-transitions.ts, the
// single entry for union_bindings.status, approvals #26); an existing row's change is then a
// compare-and-set on the row_version read with it; losing it re-reads and decides again.
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on CT-10 状态机生成器（approvals #26）
//
// Atomicity with the key (Codex money review r1): the submission runs in platform idempotency's
// transactional mode. Everything after the key is claimed reads on that transaction except the
// state consumption, which is one UPDATE on the pool handle committed on its own before the
// exchange (the consumption must be visible before the upstream is called). The binding write and
// the key's completed response then commit together: a binding never takes effect without the
// stored answer, and a stored answer never claims a binding that did not commit. A process that
// dies after the consumption leaves no key record and no binding; the same key then runs again,
// finds its state used and answers 30104 (the state is burnt: the upstream is never called twice
// and the consumption is never rolled back). While the first submission's transaction is open the
// same key gets 40901, as for every transactional operation.
// Each submission holds its transaction's connection while it takes a second one for the
// consumption and the shared reads; BIND_CONCURRENCY keeps those holders below the pool size so
// they can never wait on each other for the last connection.
// B1-06za (规划/02 §18; D9-4): the submissions over BIND_CONCURRENCY wait in the process's bounded
// admission queue (upstream-limits.ts getBindingAdmission: 16 waiting, 2 s each, FIFO). A full
// queue or an expired wait answers 42901 with Retry-After before the idempotent transaction opens:
// the state is not consumed, the upstream is not called and no key record is stored, so the same
// state and key can be submitted again.
//
// The credential (code / access_token) lives only in this process: never stored, logged or
// echoed. Responses carry only {platform, status}: no account name, relation id or other user.
// Cross-module reads (devices, user_risk_state, union_accounts, pids) are read-only; this module
// writes union_auth_sessions (used_at only) and union_bindings.
// F1-07c: the user lock (binding-lock.ts) is never held during the exchange. A new row is inserted
// first (the unique-index race of B1-06h is unchanged: two submissions both reach their INSERT),
// and the lock is taken right after the write, before the conflict log's advisory lock and the
// key's commit (r3 S2: every path takes the user lock before the advisory lock); an update of an
// existing row (invalid → active, a cooling row restored) takes the lock just before its UPDATE,
// in the order the console and the ban ports use (lock, then row), so the two never deadlock.
// After settling, the lock is taken (again, a no-op when held) and the risk state read: a user
// banned meanwhile gets the banned answer (10001) and the whole write is rolled back to the
// savepoint taken before it. Either order leaves no banned + active: a ban holding the lock first
// commits before this reads banned; this holding it first commits before the ban reads the rows.
// A new row's row_version, and a restored row's, follow the highest of the user's taobao rows (an
// earlier row_version never names the current binding again: the console's CAS stays sound). That
// highest is read under the user lock (r3 S1): a restore reads the rows again after the lock, a
// new row re-reads after its lock and moves its own row_version up when a row created and reset
// meanwhile went past it.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  newUuidV7,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type RootLogger,
} from '../../platform/index.ts';
import { canTransitionBinding } from '../domain/binding-status-transitions.ts';
import {
  lockBindingUser,
  nextBindingRowVersion,
  userBannedOn,
  userTombstonedOn,
} from './binding-lock.ts';
import {
  recordBindingConflict,
  resolveBindingConflictsOnActive,
  type BindingConflictKind,
} from '../infra/binding-conflicts.ts';
import type { CallerContext } from '../ports.ts';
import {
  AuthConfigError,
  UNRELEASED,
  type AuthClient,
  type AuthPlatform,
  type UnionAuthMethod,
  type UnionAuthReads,
} from './union-auth-reads.ts';
import type {
  UnionBindingExchangeInput,
  UnionBindingExchanger,
} from './union-binding-exchanger.ts';
import { BIND_RETRY_AFTER_SEC, getBindingAdmission } from './upstream-limits.ts';

type BindUnionRequest = components['schemas']['BindUnionRequest'];
type BindingRow = Selectable<DB['union_bindings']>;

export interface UnionBindInput {
  /** The path parameter, already checked against the contract's platform enum. */
  readonly platform: string;
  readonly body: BindUnionRequest;
  readonly idempotencyKey: string | undefined;
  readonly traceId: string;
}

export interface UnionBindingsListInput {
  readonly traceId: string;
}

/** A bind answer; a 42901 refusal also carries its Retry-After (whole seconds). */
export interface UnionBindResult extends HandlerResult {
  readonly retryAfterSec?: number;
}

export interface UnionBindingsService {
  bind(input: UnionBindInput): Promise<UnionBindResult>;
  list(input: UnionBindingsListInput): Promise<HandlerResult>;
}

export interface UnionBindingsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly reads: UnionAuthReads;
  readonly idempotency: Pick<Idempotency, 'executeInTransaction'>;
  readonly exchanger: Pick<UnionBindingExchanger, 'exchange'>;
  readonly logger: Pick<RootLogger, 'warn'>;
}

const CLIENTS: ReadonlySet<string> = new Set<AuthClient>(['ios', 'android', 'harmony']);
/** Platforms of the authorization page (orchestrator ruling D7-3 ⑧: no jd). */
const LISTED: readonly AuthPlatform[] = Object.freeze(['taobao', 'pdd']);
/** Statuses that occupy (app, account, platform, relation_id) for another user (BR-ID-19). */
const OCCUPYING: readonly string[] = Object.freeze([
  'pending_auth',
  'active',
  'invalid',
  'blocked',
]);
/** Unique-violation retries before giving up (each one re-reads and decides again). */
const DECIDE_ATTEMPTS = 4;

const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  20001: 400,
  30101: 422,
  30102: 422,
  30104: 422,
  30151: 422,
  30153: 422,
  42901: 429,
  50001: 500,
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  20001: '参数错误',
  30101: '淘宝暂时无法下单，请稍后再试',
  30102: '淘宝暂时无法下单，请稍后再试',
  30104: '授权已过期，请重新授权',
  30151: '该淘宝账号已绑定本 App 其他用户',
  30153: '该平台返利已被停用，请联系客服',
  42901: '操作太频繁，请稍后再试',
  50001: '服务端错误',
};

function result(code: number, traceId: string, data?: Record<string, unknown>): HandlerResult {
  return {
    status: STATUS[code] ?? 500,
    envelope: {
      code,
      msg: MESSAGES[code] ?? '服务端错误',
      ...(data === undefined ? {} : { data }),
      trace_id: traceId,
    },
  };
}

/** Throws on a status change the transition table does not allow (never written, 50001). */
function assertTransition(from: string | null, to: string): void {
  if (!canTransitionBinding(from, to)) {
    throw new Error(`union_bindings: illegal status transition ${String(from)} → ${to}`);
  }
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

/** The credential exactly as the contract branch carries it, without state or method. */
function credentialOf(body: BindUnionRequest): UnionBindingExchangeInput['credential'] {
  return body.auth_method === 'web_code'
    ? { code: body.code }
    : { access_token: body.access_token, expires_in: body.expires_in };
}

type Decision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'conflict'; readonly conflict: BindingConflictKind }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'retry' };

/** Every taobao row of the user, read on the caller's transaction (as committed now). */
async function userRows(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<BindingRow[]> {
  return trx
    .selectFrom('union_bindings')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', 'taobao')
    .execute();
}

export function createUnionBindings(options: UnionBindingsOptions): UnionBindingsService {
  const { db, clock, callerContext, reads, idempotency, exchanger, logger } = options;

  /** BR-ID-19 on relation id R of account A, read once; writes are conditional. */
  async function decide(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    accountId: string,
    relationId: string,
  ): Promise<Decision> {
    const now = clock.now();
    const platform = 'taobao';
    const others = await trx
      .selectFrom('union_bindings')
      .select(['status', 'cooldown_until'])
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('union_account_id', '=', accountId)
      .where('relation_id', '=', relationId)
      .where('user_id', '!=', userId)
      .execute();
    // Held by another user's unreleased row before any cooling one (BR-ID-19).
    if (others.some((row) => OCCUPYING.includes(row.status))) {
      return { kind: 'conflict', conflict: 'occupied' };
    }
    const othersCooling = others.some(
      (row) =>
        row.status === 'released' &&
        row.cooldown_until !== null &&
        row.cooldown_until.getTime() > now.getTime(),
    );
    if (othersCooling) return { kind: 'conflict', conflict: 'cooling' };

    const mine = await userRows(trx, appId, userId);
    const unreleased = mine.find((row) => UNRELEASED.includes(row.status));
    if (unreleased !== undefined) {
      if (unreleased.relation_id !== relationId || unreleased.union_account_id !== accountId) {
        return { kind: 'conflict', conflict: 'rebind' };
      }
      if (unreleased.status === 'active') return { kind: 'ok' };
      if (unreleased.status === 'blocked') return { kind: 'blocked' };
      // invalid (or a legacy pending_auth) → active; bound_at is written once and kept.
      assertTransition(unreleased.status, 'active');
      // F1-07c: the user lock before the row's (lock order of the console and the ban ports).
      await lockBindingUser(trx, appId, userId);
      const updated = await trx
        .updateTable('union_bindings')
        .set((eb) => ({
          status: 'active',
          bound_at: eb.fn.coalesce('bound_at', eb.val(now)),
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', unreleased.id)
        .where('status', '=', unreleased.status)
        .where('row_version', '=', unreleased.row_version)
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n ? activated(trx, appId, userId, now) : { kind: 'retry' };
    }

    // No unreleased binding: the user's own row of R still cooling is restored (BR-ID-19).
    const cooling = mine
      .filter(
        (row) =>
          row.status === 'released' &&
          row.relation_id === relationId &&
          row.union_account_id === accountId &&
          row.cooldown_until !== null &&
          row.cooldown_until.getTime() > now.getTime(),
      )
      .sort((a, b) => (b.released_at?.getTime() ?? 0) - (a.released_at?.getTime() ?? 0))[0];
    if (cooling !== undefined) {
      assertTransition(cooling.status, 'active');
      // F1-07c: the user lock before the row's (lock order of the console and the ban ports).
      await lockBindingUser(trx, appId, userId);
      // Codex money review r3 S1: the rows read before the lock may be stale (a row created and
      // reset meanwhile). Read again under the lock; anything unreleased now, or the cooling row
      // moved, decides again (the lock stays held), and the new row_version follows the highest
      // row_version committed by then.
      const locked = await userRows(trx, appId, userId);
      const same = locked.find((row) => row.id === cooling.id);
      if (
        locked.some((row) => UNRELEASED.includes(row.status)) ||
        same === undefined ||
        same.status !== 'released' ||
        same.row_version !== cooling.row_version
      ) {
        return { kind: 'retry' };
      }
      const restored = await trx
        .updateTable('union_bindings')
        .set((eb) => ({
          status: 'active',
          released_at: null,
          cooldown_until: null,
          bound_at: eb.fn.coalesce('bound_at', eb.val(now)),
          updated_at: now,
          // F1-07c: after the highest row_version of the user's taobao rows, never its own + 1
          // (that value may be one a later row already had: a stale console CAS would hit it).
          row_version: nextBindingRowVersion(locked),
        }))
        .where('id', '=', cooling.id)
        .where('status', '=', 'released')
        .where('row_version', '=', cooling.row_version)
        .executeTakeFirst();
      return restored.numUpdatedRows === 1n
        ? activated(trx, appId, userId, now)
        : { kind: 'retry' };
    }

    // pending_auth is never produced (BR-ID-17 细则): the row is written active directly.
    assertTransition(null, 'active');
    const id = newUuidV7(now);
    const version = nextBindingRowVersion(mine);
    await trx
      .insertInto('union_bindings')
      .values({
        id,
        app_id: appId,
        user_id: userId,
        platform,
        union_account_id: accountId,
        relation_id: relationId,
        status: 'active',
        bound_at: now,
        released_at: null,
        cooldown_until: null,
        blocked_reason: null,
        // F1-07c: after the highest row_version of the user's earlier rows on the platform.
        row_version: version,
        created_at: now,
        updated_at: now,
      })
      .execute();
    // Inserted first (the B1-06h unique race stays reachable), then the user lock before the
    // conflict log's advisory lock (Codex money review r3 S2: user lock → advisory lock on every
    // path). Under the lock the earlier rows are read again (r3 S1): a row created and reset
    // since the pre-insert read may carry a row_version >= this row's, so this row (not yet
    // visible to anyone else) moves after the highest; its status is not touched.
    await lockBindingUser(trx, appId, userId);
    const earlier = (await userRows(trx, appId, userId)).filter((row) => row.id !== id);
    const after = nextBindingRowVersion(earlier);
    if (after > version) {
      await trx
        .updateTable('union_bindings')
        .set({ row_version: after })
        .where('id', '=', id)
        .where('row_version', '=', version)
        .execute();
    }
    return activated(trx, appId, userId, now);
  }

  /** The binding just became active: its unresolved conflicts resolve with it (BR-ID-18). */
  async function activated(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    now: Date,
  ): Promise<Decision> {
    await resolveBindingConflictsOnActive(trx, appId, userId, 'taobao', now);
    return { kind: 'ok' };
  }

  async function settle(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    accountId: string,
    relationId: string,
  ): Promise<Decision> {
    for (let attempt = 1; ; attempt += 1) {
      let decision: Decision;
      // A failed statement aborts the transaction: each attempt runs under its own savepoint, so
      // a lost unique race undoes only that attempt and the next one can read what won.
      await sql`SAVEPOINT union_binding_decide`.execute(trx);
      try {
        decision = await decide(trx, appId, userId, accountId, relationId);
        await sql`RELEASE SAVEPOINT union_binding_decide`.execute(trx);
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT union_binding_decide`.execute(trx);
        // A concurrent writer won the partial unique index: read again and decide on what won.
        if (!uniqueViolation(error) || attempt >= DECIDE_ATTEMPTS) throw error;
        continue;
      }
      if (decision.kind !== 'retry' || attempt >= DECIDE_ATTEMPTS) return decision;
    }
  }

  async function handle(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    deviceId: string,
    client: AuthClient,
    body: BindUnionRequest,
    traceId: string,
  ): Promise<HandlerResult> {
    const platform = 'taobao';
    const { status, accountId: bound } = await reads.binding(appId, userId, platform);
    if (status === 'blocked') {
      // A banned user has no session (BR-ID-31); one still reaching here binds nothing either.
      if (await reads.userBanned(appId, userId)) return result(10001, traceId);
      return result(30153, traceId);
    }
    // The account this authorization uses, judged exactly as auth-url judged it (D7-3 ⑦).
    const accountId = await reads.authAccountId(appId, platform, bound);
    if (accountId === null || !(await reads.siteAuthAvailable(appId, platform, accountId))) {
      return result(status === 'invalid' ? 30102 : 30101, traceId, {
        reason: 'auth_unavailable',
      });
    }

    const now = clock.now();
    // ① the state itself: any mismatch is 30104 without reason and leaves it as it is.
    const session = await trx
      .selectFrom('union_auth_sessions')
      .selectAll()
      .where('state', '=', body.state)
      .executeTakeFirst();
    if (
      session === undefined ||
      session.app_id !== appId ||
      session.platform !== platform ||
      session.mode !== 'bind' ||
      session.used_at !== null ||
      session.expire_at.getTime() <= now.getTime() ||
      session.user_id !== userId ||
      session.device_id !== deviceId
    ) {
      return result(30104, traceId);
    }
    // ②③ the device record's client and the method: method_not_allowed, state unchanged.
    const method: UnionAuthMethod = body.auth_method;
    const issued = session.auth_methods ?? [];
    if (
      session.client !== client ||
      !issued.includes(method) ||
      !(await reads.configuredMethods(appId, client)).includes(method)
    ) {
      return result(30104, traceId, { reason: 'method_not_allowed' });
    }
    const refs = session.auth_app_refs as Readonly<Record<string, unknown>> | null;
    const appRef = refs?.[method];
    if (typeof appRef !== 'string' || appRef === '') {
      throw new AuthConfigError('linking: the state recorded no application for the method');
    }

    // Consume: one conditional update on the pool handle, so it commits on its own before the
    // upstream is called (not on trx, which commits only with the key's response).
    const consumed = await db
      .updateTable('union_auth_sessions')
      .set({ used_at: now })
      .where('state', '=', session.state)
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('device_id', '=', deviceId)
      .where('used_at', 'is', null)
      .where('expire_at', '>', now)
      .executeTakeFirst();
    if (consumed.numUpdatedRows !== 1n) return result(30104, traceId);

    // ④ with the application the state recorded for this method.
    const exchanged = await exchanger.exchange({
      appId,
      method,
      credential: credentialOf(body),
      appRef,
      traceId,
    });
    if (exchanged.kind === 'credential_invalid') {
      return result(30104, traceId, { reason: 'credential_invalid' });
    }
    if (typeof exchanged.relationId !== 'string' || exchanged.relationId === '') {
      throw new AuthConfigError('linking: the credential exchange returned no relation id');
    }

    // F1-07c: write first (the decide savepoints and the unique race unchanged), then the user
    // lock outside them, held until the key's transaction commits. A ban committed before the
    // lock was granted is read after it: the write is rolled back and the answer is the banned
    // user's (BR-ID-31: no session, 10001).
    await sql`SAVEPOINT union_binding_write`.execute(trx);
    const decision = await settle(trx, appId, userId, accountId, exchanged.relationId);
    if (!(await lockBindingUser(trx, appId, userId))) {
      throw new Error('linking: the bound user does not exist');
    }
    // B1-20c (D10-1099 T-7): an account merged meanwhile is a tombstone whose sessions are over;
    // no binding is written for it (the same answer as a session that ended, rolled back as a ban).
    if ((await userBannedOn(trx, appId, userId)) || (await userTombstonedOn(trx, appId, userId))) {
      await sql`ROLLBACK TO SAVEPOINT union_binding_write`.execute(trx);
      return result(10001, traceId);
    }
    await sql`RELEASE SAVEPOINT union_binding_write`.execute(trx);
    if (decision.kind === 'conflict') {
      // BR-ID-18 / BR-ID-19: one conflict row per 30151, committed with the stored answer; it
      // names the account used, never R or the other user.
      await recordBindingConflict(trx, {
        appId,
        userId,
        platform,
        accountId,
        kind: decision.conflict,
        now: clock.now(),
      });
      return result(30151, traceId);
    }
    if (decision.kind === 'blocked') return result(30153, traceId);
    if (decision.kind === 'retry') {
      throw new Error('linking: the binding kept changing under concurrent writers');
    }
    return {
      status: 200,
      envelope: {
        code: 0,
        msg: MESSAGES[0]!,
        data: { platform, status: 'active' },
        trace_id: traceId,
      },
    };
  }

  /** The handler's failures are server faults: logged without the request, answered 50001. */
  async function guarded(traceId: string, run: () => Promise<HandlerResult>) {
    try {
      return await run();
    } catch (error) {
      logger.warn(
        {
          event: 'linking.bindings.failed',
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'linking: binding submission failed',
      );
      return result(50001, traceId);
    }
  }

  return {
    async bind(input) {
      const { traceId } = input;
      const caller = await callerContext.current();
      if (caller.userId === null || caller.deviceId === null) return result(10001, traceId);
      const { appId, userId, deviceId } = caller;
      if (input.platform !== 'taobao') {
        return result(20001, traceId, { fields: ['platform'] });
      }
      // The client is the device record's (BR-ID-17 细则), never the X-Platform declaration.
      const device = await db
        .selectFrom('devices')
        .select(['platform', 'revoked_at'])
        .where('app_id', '=', appId)
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (device === undefined || device.revoked_at !== null) return result(10001, traceId);
      if (!CLIENTS.has(device.platform)) return result(50001, traceId);
      const client = device.platform as AuthClient;

      // Submissions of one process that may hold their transaction's connection at once (the api
      // pool has 10, POOL_SIZES.api.db): each needs a second connection for the consumption and
      // the shared reads, so the cap stays well below the pool size; the others wait without one.
      const admitted = await getBindingAdmission().run(() =>
        idempotency.executeInTransaction(
          {
            appId,
            actor: { userId, deviceId, phoneHmac: null },
            method: 'POST',
            path: `/v1/unions/${input.platform}/bindings`,
            key: input.idempotencyKey,
            body: input.body,
            traceId,
          },
          (trx) =>
            guarded(traceId, () =>
              handle(trx, appId, userId, deviceId, client, input.body, traceId),
            ),
        ),
      );
      if (admitted.kind !== 'completed') {
        // Refused before the transaction: nothing consumed, called or stored (data: none).
        logger.warn(
          {
            event: 'linking.union_bind_admission_refused',
            app_id: appId,
            platform: input.platform,
            trace_id: traceId,
            error_code: admitted.kind,
          },
          'linking: union binding submission refused by the admission queue',
        );
        return { ...result(42901, traceId), retryAfterSec: BIND_RETRY_AFTER_SEC };
      }
      const response = admitted.value;
      // Handler and replay alike: the stored body is the answer, so a replay equals the first.
      return {
        status: response.status,
        envelope: JSON.parse(response.body) as HandlerResult['envelope'],
      };
    },

    async list(input) {
      const caller = await callerContext.current();
      if (caller.userId === null) return result(10001, input.traceId);
      const { appId, userId } = caller;
      const items = [];
      for (const platform of LISTED) {
        // Pinduoduo's self-purchase slot authorization has no pid_scene column on bindings: the
        // same projection of its platform row (D7-3 ⑨).
        const { status } = await reads.binding(appId, userId, platform);
        items.push({ platform, status });
      }
      return {
        status: 200,
        envelope: { code: 0, msg: MESSAGES[0]!, data: { items }, trace_id: input.traceId },
      };
    },
  };
}
