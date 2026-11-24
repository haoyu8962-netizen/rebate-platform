// B1-04zzzzn (D10-2850 / D10-2851; BR-ID-17, BR-ATTR-05): the channel filing attempts of
// POST /v1/unions/taobao/bindings (app.union_filing_attempts, written only by this module).
//
// The filing adapter calls the recorder right before publisher.info.save is sent (after the
// credential gave a user session, so a refused code leaves no attempt). The save's answer is then
// written once:
// - an id came back → 'saved', on the binding's transaction before its savepoint (markSaved): the
//   binding and the outcome commit together (a binding refused with a stored answer, 30151, still
//   commits it); r2 (money review S1): when the handler's answer is one the key does not store
//   (10001 after a ban, 50001), its transaction rolls the outcome back, so it is written again on
//   its own once that transaction is over (requestEnded);
// - an explicit refusal → 'rejected', an answer without an id ("already filed") → 'duplicate': both
//   on the lock's connection as the adapter reports them; r2 (S0): an attempt whose save was never
//   sent because the call was cancelled meanwhile is also closed as 'rejected' (not filed);
// - a transport failure, a gateway system error or a process that dies meanwhile → left NULL
//   (unknown).
// The filing lock (r2, money review S0): one session-level advisory lock per (app, user, platform,
// union account), held on a connection of its own from before the attempt is inserted until both
// the adapter's call and the request's transaction are over (a process that dies drops the
// connection and with it the lock). Filings of the same scope therefore run one at a time, so a
// NULL outcome another request reads under its own lock is one whose request has ended: a request
// in flight is never taken for an unknown outcome. The wait is bounded (FILING_LOCK_WAIT); a
// request that cannot get the lock inserts and sends nothing.
// Only an earlier attempt of the same scope whose outcome is unknown is evidence for a duplicate
// answer's read-back id (hasEarlierUnknownAttempt): the request's own attempt and attempts with a
// known outcome never are (D10-2851 ①).
// Rows hold no credential, token or personal data.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type RootLogger } from '../../platform/index.ts';
import type { BindReq } from '../../union/index.ts';

/** Who and what one filing attempt is for. */
export interface FilingAttemptScope {
  readonly appId: string;
  readonly userId: string;
  readonly platform: 'taobao';
  readonly unionAccountId: string;
  /** The consumed state of the submission. */
  readonly state: string;
  readonly traceId: string;
}

type FilingLockScope = Pick<FilingAttemptScope, 'appId' | 'userId' | 'platform' | 'unionAccountId'>;

/** The request's own attempt, once recorded. */
export interface FilingAttempt {
  readonly id: string;
  readonly startedAt: Date;
}

export type FilingRecorder = NonNullable<BindReq['filing']> & {
  /** The attempt this recorder inserted; null while the save was never about to be sent. */
  current(): FilingAttempt | null;
  /** 'saved' on the binding's transaction (before its savepoint), written once. */
  markSaved(trx: Transaction<DB>): Promise<void>;
  /**
   * The request's transaction is over; `answerStored`: the handler's answer was one the key stores
   * (0 or 30000–39999). Writes a rolled-back 'saved' again on its own, then gives the lock back
   * once the adapter's call is over too.
   */
  requestEnded(answerStored: boolean): Promise<void>;
};

/** The longest wait for another request of the same scope to finish its filing. */
export const FILING_LOCK_WAIT = '5s';

/** The advisory lock text of a scope (namespaced, hashed with hashtextextended seed 0). */
export function filingLockKey(scope: FilingLockScope): string {
  return `linking.union_filing_attempts:${scope.appId}:${scope.userId}:${scope.platform}:${scope.unionAccountId}`;
}

/** A granted filing lock and the connection that holds it. */
export interface HeldFilingLock {
  readonly conn: Kysely<DB>;
  /** Unlocks and gives the connection back to the pool. */
  release(): Promise<void>;
}

/**
 * Takes the scope's session-level advisory lock on a connection of its own, waiting at most
 * FILING_LOCK_WAIT (SET LOCAL inside a short transaction: the session lock outlives it, the
 * timeout does not). Rejects (lock_not_available) when the wait runs out; nothing is held then.
 */
export async function acquireFilingLock(db: Kysely<DB>, key: string): Promise<HeldFilingLock> {
  let granted!: (conn: Kysely<DB>) => void;
  let refused!: (error: unknown) => void;
  const grant = new Promise<Kysely<DB>>((resolve, reject) => {
    granted = resolve;
    refused = reject;
  });
  let free!: () => void;
  const freed = new Promise<void>((resolve) => {
    free = resolve;
  });
  const holding = db.connection().execute(async (conn) => {
    try {
      await conn.transaction().execute(async (t) => {
        await sql`SELECT set_config('lock_timeout', ${FILING_LOCK_WAIT}, true)`.execute(t);
        await sql`SELECT pg_advisory_lock(hashtextextended(${key}::text, 0))`.execute(t);
      });
    } catch (error) {
      // A lock granted by a statement whose transaction then failed is not kept on a pooled
      // connection (unlocking a lock not held only warns).
      await sql`SELECT pg_advisory_unlock(hashtextextended(${key}::text, 0))`
        .execute(conn)
        .catch(() => undefined);
      throw error;
    }
    granted(conn);
    await freed;
    await sql`SELECT pg_advisory_unlock(hashtextextended(${key}::text, 0))`.execute(conn);
  });
  // Before the grant: the acquisition's failure; after it, the release reports its own.
  holding.catch(refused);
  const conn = await grant;
  return {
    conn,
    release: async () => {
      free();
      await holding;
    },
  };
}

/** The filing could not start: the scope's lock was not granted in time. Nothing was sent. */
export class FilingLockUnavailable extends Error {
  constructor() {
    super('linking: the channel filing lock was not granted');
    this.name = 'FilingLockUnavailable';
  }
}

/** The request already ended (its call timed out) before the filing started. Nothing was sent. */
export class FilingRequestOver extends Error {
  constructor() {
    super('linking: the channel filing request is already over');
    this.name = 'FilingRequestOver';
  }
}

/** A recorder for one submission; `started` inserts at most once. */
export function createFilingRecorder(
  db: Kysely<DB>,
  clock: Clock,
  logger: Pick<RootLogger, 'warn'>,
  scope: FilingAttemptScope,
): FilingRecorder {
  let attempt: FilingAttempt | null = null;
  let lock: HeldFilingLock | null = null;
  let ended = false;
  let adapterDone = false;
  let released = false;
  let savedOnTrx = false;

  const warn = (event: string, error: unknown, fields: Record<string, string> = {}) => {
    logger.warn(
      {
        event,
        app_id: scope.appId,
        platform: scope.platform,
        trace_id: scope.traceId,
        ...fields,
        error_name: error instanceof Error ? error.name : typeof error,
      },
      'linking: channel filing attempt bookkeeping failed',
    );
  };

  /** Gives the lock back once both the adapter's call and the request's transaction are over. */
  const releaseWhenOver = async (): Promise<void> => {
    const held = lock;
    if (held === null || !ended || !adapterDone || released) return;
    released = true;
    try {
      await held.release();
    } catch (error) {
      warn('linking.bindings.filing_lock_release_failed', error);
    }
  };

  /** One write-once outcome on the lock's connection (the pool when none is held). */
  const writeOutcome = async (outcome: 'saved' | 'rejected' | 'duplicate'): Promise<void> => {
    const current = attempt;
    if (current === null) return;
    try {
      await (lock?.conn ?? db)
        .updateTable('union_filing_attempts')
        .set({ outcome, finished_at: clock.now() })
        .where('id', '=', current.id)
        .where('outcome', 'is', null)
        .execute();
    } catch (error) {
      // The outcome stays unknown; the filing's own answer still goes up unchanged.
      warn('linking.bindings.filing_outcome_unrecorded', error, { outcome });
    }
  };

  return {
    async started(signal) {
      if (attempt !== null) return;
      if (ended || adapterDone) throw new FilingRequestOver();
      let held = lock;
      if (held === null) {
        try {
          held = await acquireFilingLock(db, filingLockKey(scope));
        } catch (error) {
          warn('linking.bindings.filing_lock_unavailable', error);
          throw new FilingLockUnavailable();
        }
        lock = held;
      }
      // Cancelled or over while waiting: nothing is inserted (the adapter sends nothing either).
      if (ended || signal?.aborted === true) return;
      const startedAt = clock.now();
      const id = newUuidV7(startedAt);
      // On the lock's connection, outside any transaction: committed before the save is sent.
      await held.conn
        .insertInto('union_filing_attempts')
        .values({
          id,
          app_id: scope.appId,
          user_id: scope.userId,
          platform: scope.platform,
          union_account_id: scope.unionAccountId,
          state: scope.state,
          started_at: startedAt,
          outcome: null,
          finished_at: null,
        })
        .execute();
      attempt = { id, startedAt };
    },
    async settled(outcome) {
      await writeOutcome(outcome);
    },
    done() {
      adapterDone = true;
      void releaseWhenOver();
    },
    current: () => attempt,
    async markSaved(trx) {
      const current = attempt;
      if (current === null) return;
      await trx
        .updateTable('union_filing_attempts')
        .set({ outcome: 'saved', finished_at: clock.now() })
        .where('id', '=', current.id)
        .where('outcome', 'is', null)
        .execute();
      savedOnTrx = true;
    },
    async requestEnded(answerStored) {
      ended = true;
      // The save gave an id but the answer is not stored: the transaction rolled 'saved' back.
      // An answer that is stored and then not committed (an interruption) stays unknown.
      if (savedOnTrx && !answerStored) await writeOutcome('saved');
      await releaseWhenOver();
    },
  };
}

/**
 * Whether the same (app, user, platform, union account) has an attempt that started before the
 * request's own and whose outcome is unknown (D10-2851 ①). Without an own attempt: none counts.
 * An own attempt means the caller holds the scope's filing lock, so every other attempt of the
 * scope belongs to a request that has ended: its NULL outcome is really unknown.
 */
export async function hasEarlierUnknownAttempt(
  trx: Transaction<DB>,
  scope: FilingLockScope,
  own: FilingAttempt | null,
): Promise<boolean> {
  if (own === null) return false;
  const row = await trx
    .selectFrom('union_filing_attempts')
    .select('id')
    .where('app_id', '=', scope.appId)
    .where('user_id', '=', scope.userId)
    .where('platform', '=', scope.platform)
    .where('union_account_id', '=', scope.unionAccountId)
    .where('started_at', '<', own.startedAt)
    .where('id', '!=', own.id)
    .where('outcome', 'is', null)
    .where('finished_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
