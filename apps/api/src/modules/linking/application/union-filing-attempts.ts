// B1-04zzzzn (D10-2850 / D10-2851; BR-ID-17, BR-ATTR-05): the channel filing attempts of
// POST /v1/unions/taobao/bindings (app.union_filing_attempts, written only by this module).
//
// The filing adapter calls the recorder right before publisher.info.save is sent (after the
// credential gave a user session, so a refused code leaves no attempt): one INSERT on the pool
// handle, committed on its own before anything is sent. The save's answer is then written once:
// - an id came back → 'saved', on the binding's transaction before its savepoint (markSaved): the
//   binding and the outcome commit together, and a binding refused afterwards (30151, a ban rolled
//   back to the savepoint, 10001) still commits the outcome with the stored answer;
// - an explicit refusal → 'rejected', an answer without an id ("already filed") → 'duplicate': both
//   on the pool handle as the adapter reports them (the binding's transaction never touched the row,
//   so nothing waits on it);
// - a transport failure, a gateway system error or a process that dies meanwhile → left NULL
//   (unknown).
// Only an earlier attempt of the same (app, user, platform, union account) whose outcome is unknown
// is evidence for a duplicate answer's read-back id (hasEarlierUnknownAttempt): the request's own
// attempt and attempts with a known outcome never are (D10-2851 ①).
// Rows hold no credential, token or personal data.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
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

/** The request's own attempt, once recorded. */
export interface FilingAttempt {
  readonly id: string;
  readonly startedAt: Date;
}

export type FilingRecorder = NonNullable<BindReq['filing']> & {
  /** The attempt this recorder inserted; null while the save was never about to be sent. */
  current(): FilingAttempt | null;
};

/** A recorder for one submission; `started` inserts at most once. */
export function createFilingRecorder(
  db: Kysely<DB>,
  clock: Clock,
  logger: Pick<RootLogger, 'warn'>,
  scope: FilingAttemptScope,
): FilingRecorder {
  let attempt: FilingAttempt | null = null;
  return {
    async started() {
      if (attempt !== null) return;
      const startedAt = clock.now();
      const id = newUuidV7(startedAt);
      // On the pool handle: committed on its own before the save is sent.
      await db
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
      const current = attempt;
      if (current === null) return;
      try {
        await db
          .updateTable('union_filing_attempts')
          .set({ outcome, finished_at: clock.now() })
          .where('id', '=', current.id)
          .where('outcome', 'is', null)
          .execute();
      } catch (error) {
        // The outcome stays unknown; the filing's own answer still goes up unchanged.
        logger.warn(
          {
            event: 'linking.bindings.filing_outcome_unrecorded',
            app_id: scope.appId,
            platform: scope.platform,
            outcome,
            trace_id: scope.traceId,
            error_name: error instanceof Error ? error.name : typeof error,
          },
          'linking: the channel filing outcome could not be recorded',
        );
      }
    },
    current: () => attempt,
  };
}

/** 'saved' on the binding's transaction (before its savepoint), written once. */
export async function markFilingSaved(
  trx: Transaction<DB>,
  attempt: FilingAttempt,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('union_filing_attempts')
    .set({ outcome: 'saved', finished_at: now })
    .where('id', '=', attempt.id)
    .where('outcome', 'is', null)
    .execute();
}

/**
 * Whether the same (app, user, platform, union account) has an attempt that started before the
 * request's own and whose outcome is unknown (D10-2851 ①). Without an own attempt: none counts.
 */
export async function hasEarlierUnknownAttempt(
  trx: Transaction<DB>,
  scope: Pick<FilingAttemptScope, 'appId' | 'userId' | 'platform' | 'unionAccountId'>,
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
