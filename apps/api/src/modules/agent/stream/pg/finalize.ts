import { sql } from 'kysely';
import {
  AdmissionHeldError,
  AdmissionUnavailableError,
  dayKeyOf,
  shouldRefund,
} from '../admission/index.ts';
import type { AdmissionLimits, RunEnding, RunReply } from '../admission/index.ts';
import type { TerminalFrame } from '../run/types.ts';
import { createFrameValidator } from '../writer/index.ts';
import type { FinalizeHold, FinalizeOutcome, PgRunDeps } from './types.ts';
import { defaultDraft, decideEnding } from './ending.ts';
import type { EndingMemo } from './ending.ts';
import { fromStored, redactedStored, StoredFrameInvalid, toStored, withQuota } from './frames.ts';
import { detached, writeReply } from './reply.ts';
import { dailyUsage, isRunning, lockSession, lockSubjects, readRun, remaining } from './store.ts';
import type { RunRow, SessionRow } from './store.ts';
import { errorCode, retryable, TransactionFailure, unavailable } from './transaction.ts';
import type { Queries, Transactions } from './transaction.ts';

export class HoldRequired extends Error {
  readonly runId: string;
  readonly reason: FinalizeHold;
  constructor(runId: string, reason: FinalizeHold) {
    super('Agent run requires manual handling');
    this.runId = runId;
    this.reason = reason;
  }
}

export function holdFailure(error: unknown): HoldRequired | undefined {
  if (error instanceof HoldRequired) return error;
  if (error instanceof TransactionFailure) return holdFailure(error.original);
  return undefined;
}

function result(
  frame: TerminalFrame,
  refunded: boolean,
  quotaLeft: number,
  wrote: boolean,
): FinalizeOutcome {
  return {
    kind: 'final',
    frame,
    refunded,
    quotaLeft,
    wrote,
    snapshotQuotaLeft: frame.event === 'done' ? frame.data.quota_left : null,
  };
}

export function createFinalization(deps: PgRunDeps, transaction: Transactions) {
  /** F2–F6: caller already owns the session, run and entire union of quota subject locks. */
  async function finalizeRun(
    q: Queries,
    session: SessionRow,
    initial: RunRow,
    now: Date,
    limits: AdmissionLimits,
    live?: EndingMemo,
    reply?: RunReply,
  ): Promise<FinalizeOutcome> {
    let row = initial;
    try {
      if (row.final_event !== null) {
        const frame = fromStored(row.final_event, 'final');
        const counts = await dailyUsage(q, row.app_id, row.quota_subjects, now);
        return result(
          frame,
          row.settle_result === 'refunded',
          remaining(row.quota_subjects, limits, counts),
          false,
        );
      }
      if (row.finalize_hold !== null)
        return { kind: 'held', reason: row.finalize_hold as FinalizeHold };
      if (row.end_reason === null) {
        if (!live && isRunning(session, row.id, now)) return { kind: 'running' };
        row = await decideEnding(
          q,
          row.id,
          live ?? {
            facts: { ending: 'server_error', cardsDelivered: 0 },
            draft: defaultDraft('server_error', deps.texts),
          },
        );
      }
      const draft =
        row.end_draft === null
          ? defaultDraft('server_error', deps.texts)
          : fromStored(row.end_draft, 'draft');
      if (row.end_draft === null) deps.logger?.warn({ run_id: row.id }, 'agent.end_draft_missing');
      const refunded = shouldRefund({
        ending: row.end_reason as RunEnding,
        cardsDelivered: row.card_delivered ? 1 : 0,
      });
      const counts = await dailyUsage(q, row.app_id, row.quota_subjects, now, row.id);
      const charge = !refunded && dayKeyOf(row.accepted_at) === dayKeyOf(now) ? 1 : 0;
      const quotaLeft = remaining(
        row.quota_subjects,
        limits,
        counts.map((count) => count + charge),
      );
      const frame = fromStored(toStored(withQuota(draft, quotaLeft)), 'final');
      if (!createFrameValidator()({ ...frame, id: 1 }).ok)
        throw new StoredFrameInvalid('Invalid terminal frame');
      // B3-08zh (BR-AI-22): the session was detached from its user while the run went on (the purge
      // holds the session lock this transaction now has): the stored terminal state and draft keep
      // no answer text or search term, as the purge would have left them; the rest as usual.
      const erased = detached(session);
      const stored = erased ? redactedStored(toStored(frame)) : toStored(frame);
      const endDraft =
        erased && row.end_draft !== null
          ? sql`${JSON.stringify(redactedStored(toStored(draft)))}::jsonb`
          : sql`end_draft`;
      await q.query(sql`UPDATE app.agent_runs SET
        settle_result = ${refunded ? 'refunded' : 'counted'}, settled_at = ${now},
        final_event = ${JSON.stringify(stored)}::jsonb, end_draft = ${endDraft},
        ended_at = GREATEST(${now}, accepted_at),
        finish_reason = COALESCE(finish_reason, ${frame.event === 'done' ? frame.data.finish_reason : 'error'})
        WHERE app_id = ${row.app_id} AND id = ${row.id} AND final_event IS NULL`);
      // B3-08zc (BR-AI-19 细则「助手回复落库」): the reply of the process that ran the run, in this
      // same transaction — committed with the terminal state or not at all.
      if (reply !== undefined) await writeReply(q, row, session, reply, now, deps.logger);
      await q.query(sql`UPDATE app.agent_sessions SET run_lock_run_id = NULL, run_lock_expires_at = NULL
        WHERE app_id = ${row.app_id} AND id = ${row.session_id} AND run_lock_run_id = ${row.id}`);
      return result(frame, refunded, quotaLeft, true);
    } catch (error) {
      if (error instanceof StoredFrameInvalid)
        throw new HoldRequired(row.id, 'stored_frame_invalid');
      if (['23514', '23001'].includes(errorCode(error) ?? ''))
        throw new HoldRequired(row.id, 'facts_inconsistent');
      throw error;
    }
  }

  async function markHold(failure: HoldRequired): Promise<void> {
    await transaction('hold', async (q) => {
      await q.query(sql`UPDATE app.agent_runs SET finalize_hold = ${failure.reason},
        finalize_hold_at = ${deps.clock.now()}
        WHERE id = ${failure.runId} AND final_event IS NULL AND finalize_hold IS NULL`);
    });
    deps.logger?.error({ run_id: failure.runId, reason: failure.reason }, 'agent.finalize_held');
  }

  /**
   * F0 before any connection is leased: the run's app (one short pooled read, released at once),
   * then the limits with nothing held. A failure is wrapped as the former in-transaction F0
   * failure was (TransactionFailure, nothing committed), so retries and the rolled_back outcome
   * are unchanged.
   */
  async function limitsOf(
    runId: string,
  ): Promise<{ readonly appId: string; readonly limits: AdmissionLimits }> {
    let appId: string;
    try {
      const { rows } = await sql<{ app_id: string }>`SELECT app_id FROM app.agent_runs
        WHERE id = ${runId}`.execute(deps.db);
      if (!rows[0]) throw new Error('Agent run missing');
      appId = rows[0].app_id;
    } catch (error) {
      throw new TransactionFailure(error, false);
    }
    try {
      return { appId, limits: await deps.limits.current(appId) };
    } catch {
      throw new TransactionFailure(new AdmissionUnavailableError('rolled_back'), false);
    }
  }

  async function independent(
    runId: string,
    live?: EndingMemo,
    reply?: RunReply,
  ): Promise<FinalizeOutcome> {
    const step = live ? 'settle' : 'finalize';
    for (let attempt = 0; ; attempt += 1) {
      try {
        let info!: RunRow;
        // B3-08r: F0's configuration read happens while no pool connection is held. transaction()
        // leases its connection before `prepare`; reading the limits there could make the content
        // reader's refresh wait for a second connection of the same pool, and N finalizations on
        // a pool of N would deadlock the instance. Failures keep F0's classification.
        const { appId, limits } = await limitsOf(runId);
        return await transaction(
          step,
          async (q) => {
            const session = await lockSession(q, info.session_id);
            if (!session) throw new Error('Agent session missing');
            const row = await readRun(q, runId, true);
            await lockSubjects(q, row.app_id, row.quota_subjects);
            const now = deps.clock.now();
            if (
              live &&
              row.deadline_at?.getTime() !== row.accepted_at.getTime() + deps.timings.runMaxMs
            ) {
              deps.logger?.warn({ run_id: runId }, 'agent.deadline_mismatch');
            }
            return finalizeRun(q, session, row, now, limits, live, live ? reply : undefined);
          },
          async (q) => {
            // F0 precedes BEGIN: the limits were read before the connection was leased (a failed
            // configuration refresh opens no write transaction). Metadata reads take no row lock;
            // F1 always locks the session before the run.
            info = await readRun(q, runId);
            if (info.app_id !== appId) throw new Error('Agent run app changed');
          },
        );
      } catch (error) {
        const held = holdFailure(error);
        if (held) {
          await markHold(held);
          return { kind: 'held', reason: held.reason };
        }
        if (
          live &&
          attempt === 0 &&
          (retryable(error) || (error instanceof TransactionFailure && retryable(error.original)))
        )
          continue;
        return unavailable(error);
      }
    }
  }

  async function requireFinal(runId: string, live: EndingMemo, reply?: RunReply) {
    const out = await independent(runId, live, reply);
    if (out.kind === 'held') throw new AdmissionHeldError(out.reason);
    if (out.kind !== 'final') throw new AdmissionUnavailableError('rolled_back');
    return out;
  }
  return { finalizeRun, markHold, independent, requireFinal };
}

export type Finalization = ReturnType<typeof createFinalization>;
