// Session reads and writes of the Agent HTTP layer (B3-03d after the 2026-10-08 redesign; BR-AI-20;
// table app.agent_sessions, db/schema.sql). Acceptance, duplicates, the session run lock,
// finalization and the cancel write are B3-03g's (../stream/pg); this store only creates, finds and
// checks the ownership of sessions, and tells whether a run belongs to one of the caller's sessions.
// The rule tests in test/spec/agent/stream-http/** import this file by path: names, signatures
// and the semantics written here are the contract.
//
// Owner (BR-AI-20): kind 'user' (the caller has an access token) owns the sessions whose user_id is
// that user, on any device; kind 'device' (a guest) owns the sessions whose user_id IS NULL, whose
// user_hash IS NULL and whose device_id is that device (B3-08ze: a deleted member's session keeps
// its device_id but carries user_hash; it is nobody's, never the device's guest). A user never
// falls back to the device's guest sessions, and a guest never sees a user's session even on the
// same device. Every query is scoped by app_id.
// Expired (BR-AI-20): last_active_at + deps.idleMs ≤ now, where now = deps.clock.now() read once
// per call (never the database clock); a set expired_at ≤ now is expired as well (the same test as
// the admission re-check in ../stream/pg).
//
// createPgAgentSessionStore({db, clock, idleMs}):
//   open(owner, newId) — createAgentSession: the owner's newest unexpired session while it has no
//     agent_runs row yet (no turn) is returned unchanged; otherwise a new row is inserted with id
//     newId, user_id (null for a device owner), device_id (the owner's device), started_at =
//     last_active_at = now. Writes nothing else (no run, no message).
//   current(owner) — getCurrentAgentSession: the owner's unexpired session with the greatest
//     last_active_at, or null. Read only.
//   owned(owner, sessionId) — BR-AI-23 ④: {session, expired} when the session exists and belongs to
//     the owner, otherwise null (missing and not owned are never told apart). An id that is not a
//     UUID is null, not an error. Read only; last_active_at is never touched here (only an
//     acceptance moves it, B3-03g).
//   ownsRun(owner, runId) — the cancel endpoint: true when an agent_runs row with this id is in a
//     session the owner owns (expired or not); false when the run does not exist, is not the
//     owner's, or the id is not a UUID. Read only.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock, data
// access only through Kysely on deps.db.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type AgentOwner =
  | {
      readonly kind: 'user';
      readonly appId: string;
      readonly userId: string;
      /** The device of the request; written as device_id when a session is created. */
      readonly deviceId: string;
    }
  | { readonly kind: 'device'; readonly appId: string; readonly deviceId: string };

export interface AgentSessionRow {
  readonly id: string;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
}

export interface OwnedSession {
  readonly session: AgentSessionRow;
  readonly expired: boolean;
}

export interface AgentSessionStore {
  open(owner: AgentOwner, newId: string): Promise<AgentSessionRow>;
  current(owner: AgentOwner): Promise<AgentSessionRow | null>;
  owned(owner: AgentOwner, sessionId: string): Promise<OwnedSession | null>;
  ownsRun(owner: AgentOwner, runId: string): Promise<boolean>;
}

export interface PgAgentSessionStoreDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** BR-AI-20 expiry after last_active_at (agentSessionDefaults().idleMs). */
  readonly idleMs: number;
}

/** BR-AI-20: idleMs is 24 hours. */
export function agentSessionDefaults(): { readonly idleMs: number } {
  return { idleMs: 86_400_000 };
}

export function createPgAgentSessionStore(deps: PgAgentSessionStoreDeps): AgentSessionStore {
  if (!Number.isSafeInteger(deps.idleMs) || deps.idleMs <= 0) {
    throw new RangeError('Invalid session idle duration');
  }
  const db = deps.db.withSchema('app');
  function sessions(connection: Kysely<DB>, owner: AgentOwner) {
    const query = connection.selectFrom('agent_sessions').where('app_id', '=', owner.appId);
    return owner.kind === 'user'
      ? query.where('user_id', '=', owner.userId)
      : query
          .where('user_id', 'is', null)
          .where('user_hash', 'is', null)
          .where('device_id', '=', owner.deviceId);
  }
  function live(connection: Kysely<DB>, owner: AgentOwner, now: Date) {
    const cutoff = structuredClone(now);
    cutoff.setTime(now.getTime() - deps.idleMs);
    return sessions(connection, owner)
      .where('last_active_at', '>', cutoff)
      .where((eb) => eb.or([eb('expired_at', 'is', null), eb('expired_at', '>', now)]));
  }
  return {
    async open(owner, newId) {
      return db.transaction().execute(async (tx) => {
        // Serialize even the first creation, when there is no session row to lock yet.
        const key = JSON.stringify([
          'agent.session.open',
          owner.appId,
          owner.kind,
          owner.kind === 'user' ? owner.userId : owner.deviceId,
        ]);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx);
        const now = deps.clock.now();
        const latest = await live(tx, owner, now)
          .selectAll()
          .orderBy('started_at', 'desc')
          .orderBy('id', 'desc')
          .limit(1)
          .forUpdate()
          .executeTakeFirst();
        if (latest) {
          // Locking the session also serializes this check with PG admission.
          const run = await tx
            .selectFrom('agent_runs')
            .select('id')
            .where('app_id', '=', owner.appId)
            .where('session_id', '=', latest.id)
            .limit(1)
            .executeTakeFirst();
          if (!run) return sessionRow(latest);
        }
        const created = await tx
          .insertInto('agent_sessions')
          .values({
            id: newId,
            app_id: owner.appId,
            user_id: owner.kind === 'user' ? owner.userId : null,
            device_id: owner.deviceId,
            started_at: now,
            last_active_at: now,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return sessionRow(created);
      });
    },
    async current(owner) {
      const now = deps.clock.now();
      const row = await live(db, owner, now)
        .selectAll()
        .orderBy('last_active_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row ? sessionRow(row) : null;
    },
    async owned(owner, sessionId) {
      const now = deps.clock.now();
      if (!isUuid(sessionId)) return null;
      const row = await sessions(db, owner)
        .selectAll()
        .where('id', '=', sessionId)
        .executeTakeFirst();
      if (!row) return null;
      return {
        session: sessionRow(row),
        expired:
          row.last_active_at.getTime() + deps.idleMs <= now.getTime() ||
          (row.expired_at !== null && row.expired_at.getTime() <= now.getTime()),
      };
    },
    async ownsRun(owner, runId) {
      if (!isUuid(runId)) return false;
      const row = await sessions(db, owner)
        .select('id')
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('agent_runs as r')
              .select('r.id')
              .whereRef('r.app_id', '=', 'agent_sessions.app_id')
              .whereRef('r.session_id', '=', 'agent_sessions.id')
              .where('r.id', '=', runId),
          ),
        )
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

function sessionRow(row: { id: string; started_at: Date; last_active_at: Date }): AgentSessionRow {
  return { id: row.id, startedAt: row.started_at, lastActiveAt: row.last_active_at };
}

/** Accept canonical UUIDs of any version; malformed external ids behave as missing rows. */
export function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
