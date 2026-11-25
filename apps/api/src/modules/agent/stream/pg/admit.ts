import { sql } from 'kysely';
import {
  AdmissionHeldError,
  AdmissionUnavailableError,
  dayKeyOf,
  nextResetAt,
  nextStepOf,
  subjectKeys,
} from '../admission/index.ts';
import type { AdmissionLimits, AdmissionRequest, AdmissionResult } from '../admission/index.ts';
import type { BudgetQueries, DailyBudgetOn } from '../../budget/index.ts';
import type { PgRunDeps } from './types.ts';
import { fromStored } from './frames.ts';
import { holdFailure } from './finalize.ts';
import type { Finalization } from './finalize.ts';
import {
  dailyUsage,
  isRunning,
  lockSession,
  lockSubjects,
  readRun,
  remaining,
  subjectLimits,
} from './store.ts';
import type { RunRow, SessionRow } from './store.ts';
import { errorCode, TransactionFailure, unavailable } from './transaction.ts';
import type { Queries, Transactions } from './transaction.ts';

/**
 * B3-09m · BR-AI-16 (取甲): the run's budget plan, read by the caller for the session's app before
 * any connection is leased. `blocked`: the run must not use a model (plan or price read failed,
 * no usable price): nothing is reserved and the run ends by budget. Otherwise the admission
 * transaction that inserts the run reserves `reserveMfen` against `budgetMfen` (committed
 * actual + reserved of the admission day); a duplicate or a rejection reserves nothing.
 */
export interface RunBudgetPlan {
  readonly blocked: boolean;
  readonly budgetMfen: bigint;
  readonly reserveMfen: bigint;
  readonly priceVersion: string | null;
}

export interface AdmissionBudget {
  /** Never rejects: a failed read is the caller's blocked plan. */
  plan(appId: string): Promise<RunBudgetPlan>;
  readonly daily: DailyBudgetOn;
}

export interface BudgetedAdmissionRequest extends AdmissionRequest {
  readonly budget?: AdmissionBudget;
}

/** The admission verdict of a budgeted run, fixed for the whole run. */
export interface RunBudgetVerdict {
  /** No model for this run (reason budget): over budget, R = 0, or a blocked plan. */
  readonly exhausted: boolean;
  /** Whether a reservation row was written (settled once by the run's finalization). */
  readonly reserved: boolean;
  readonly plan: RunBudgetPlan;
}

const verdicts = new WeakMap<object, RunBudgetVerdict>();

/** The budget verdict of an `accepted` result of a budgeted request (undefined otherwise). */
export function budgetVerdictOf(result: AdmissionResult): RunBudgetVerdict | undefined {
  return verdicts.get(result);
}

export function createAdmission(
  deps: PgRunDeps,
  transaction: Transactions,
  finalization: Finalization,
) {
  async function messageRun(q: Queries, session: SessionRow, clientMsgId: string) {
    return (
      await q.query(sql<{ run_id: string; id: string }>`SELECT run_id, id FROM app.agent_messages
      WHERE app_id = ${session.app_id} AND session_id = ${session.id}
      AND client_msg_id = ${clientMsgId} AND role = 'user'`)
    )[0];
  }

  /** F0 of a budgeted request: the session's app (one pooled read) and its plan, nothing held. */
  async function budgetPlanOf(
    req: BudgetedAdmissionRequest,
  ): Promise<{ readonly appId: string; readonly plan: RunBudgetPlan } | undefined> {
    const budget = req.budget;
    if (budget === undefined) return undefined;
    let appId: string | undefined;
    try {
      const { rows } = await sql<{ app_id: string }>`SELECT app_id FROM app.agent_sessions
        WHERE id = ${req.sessionId}`.execute(deps.db);
      appId = rows[0]?.app_id;
    } catch (error) {
      throw new TransactionFailure(error, false);
    }
    // No session: the transaction rejects the request (30504) before any reservation.
    if (appId === undefined) return undefined;
    return { appId, plan: await budget.plan(appId) };
  }

  async function accept(
    q: Queries,
    req: BudgetedAdmissionRequest,
    limits: AdmissionLimits,
    budget: { readonly appId: string; readonly plan: RunBudgetPlan } | undefined,
  ): Promise<AdmissionResult> {
    const session = await lockSession(q, req.sessionId);
    const now = deps.clock.now();
    if (
      !session ||
      session.last_active_at.getTime() + 86_400_000 <= now.getTime() ||
      (session.expired_at !== null && session.expired_at.getTime() <= now.getTime())
    ) {
      return { kind: 'rejected', code: 30504, reason: 'expired' };
    }
    const appId = session.app_id;
    const duplicate = await messageRun(q, session, req.clientMsgId);
    if (duplicate) {
      const run = await readRun(q, duplicate.run_id, true);
      if (run.finalize_hold !== null) throw new AdmissionHeldError(run.finalize_hold);
      const assistant = (
        await q.query(sql<{ id: string }>`SELECT id FROM app.agent_messages
        WHERE app_id = ${appId} AND run_id = ${run.id} AND role = 'assistant'`)
      )[0];
      if (!assistant) throw new Error('Agent assistant message missing');
      const original = {
        runId: run.id,
        userMessageId: duplicate.id,
        assistantMessageId: assistant.id,
        promptVersion: run.prompt_version,
        modelSnapshot: run.model_snapshot,
      };
      if (run.final_event !== null) {
        return {
          kind: 'duplicate',
          original,
          reply: { kind: 'final', frame: fromStored(run.final_event, 'final') },
        };
      }
      if (isRunning(session, run.id, now))
        return { kind: 'duplicate', original, reply: { kind: 'running' } };
      await lockSubjects(q, appId, run.quota_subjects);
      const out = await finalization.finalizeRun(
        q,
        session,
        run,
        now,
        limits,
        undefined,
        undefined,
        undefined,
        staleBudgetMfen(budget),
      );
      if (out.kind === 'held') throw new AdmissionHeldError(out.reason);
      if (out.kind !== 'final') throw new Error('Unfinished duplicate');
      return { kind: 'duplicate', original, reply: { kind: 'final', frame: out.frame } };
    }

    const leftovers: RunRow[] = [];
    if (session.run_lock_run_id !== null) {
      const run = await readRun(q, session.run_lock_run_id, true);
      if (run.finalize_hold !== null) throw new AdmissionHeldError(run.finalize_hold);
      if (isRunning(session, run.id, now)) return { kind: 'rejected', code: 30506 };
      leftovers.push(run);
    }
    const others = await q.query(sql<RunRow>`SELECT * FROM app.agent_runs
      WHERE app_id = ${appId} AND session_id = ${session.id} AND final_event IS NULL
      ${session.run_lock_run_id === null ? sql`` : sql`AND id <> ${session.run_lock_run_id}`}
      ORDER BY id FOR UPDATE`);
    for (const run of others) {
      if (run.finalize_hold !== null) throw new AdmissionHeldError(run.finalize_hold);
      leftovers.push(run);
    }
    const subjects = subjectKeys(req.subject);
    await lockSubjects(q, appId, [...subjects, ...leftovers.flatMap((run) => run.quota_subjects)]);
    for (const run of leftovers) {
      // B3-09m: a stale run settled here has no live detail (its full reservation is booked); the
      // alert check uses this request's budget plan when it has one.
      const out = await finalization.finalizeRun(
        q,
        session,
        run,
        now,
        limits,
        undefined,
        undefined,
        undefined,
        staleBudgetMfen(budget),
      );
      if (out.kind === 'held') throw new AdmissionHeldError(out.reason);
    }
    const window = (
      await q.query(sql<{ count: string; oldest: Date | null }>`SELECT count(*)::text AS count,
      min(accepted_at) AS oldest FROM app.agent_runs WHERE app_id = ${appId}
      AND quota_subjects[1] = ${subjects[0]} AND accepted_at > ${instantPlus(now, -60_000)}`)
    )[0]!;
    if (Number(window.count) >= limits.perMinute) {
      return {
        kind: 'rejected',
        code: 42901,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((window.oldest?.getTime() ?? now.getTime()) + 60_000 - now.getTime()) / 1_000),
        ),
      };
    }
    const rounds = (
      await q.query(sql<{ count: string }>`SELECT count(*)::text AS count FROM app.agent_runs
      WHERE app_id = ${appId} AND session_id = ${session.id}`)
    )[0]!;
    if (Number(rounds.count) >= limits.maxRounds)
      return { kind: 'rejected', code: 30504, reason: 'round_limit' };
    const counts = await dailyUsage(q, appId, subjects, now);
    if (subjectLimits(subjects, limits).some((limit, index) => counts[index]! >= limit)) {
      return {
        kind: 'rejected',
        code: 30502,
        resetAt: nextResetAt(now),
        next: nextStepOf(req.subject),
      };
    }
    const deadline = instantPlus(now, deps.timings.runMaxMs);
    const lockEnd = instantPlus(deadline, deps.timings.lockGraceMs);
    await q.query(sql`INSERT INTO app.agent_runs
      (id, app_id, session_id, user_text, prompt_version, model_snapshot, accepted_at, quota_subjects,
        deadline_at, created_at, updated_at)
      VALUES (${req.runId}, ${appId}, ${session.id}, ${req.reply.runUserText}, ${req.reply.promptVersion},
        ${req.reply.modelSnapshot}, ${now}, ${subjects}::text[], ${deadline}, ${now}, ${now})`);
    await q.query(sql`INSERT INTO app.agent_messages
      (id, app_id, session_id, run_id, role, client_msg_id, text, created_at, updated_at) VALUES
      (${req.messageId}, ${appId}, ${session.id}, ${req.runId}, 'user', ${req.clientMsgId}, ${req.reply.messageText}, ${now}, ${now}),
      (${req.reply.assistantMessageId}, ${appId}, ${session.id}, ${req.runId}, 'assistant', NULL, NULL, ${now}, ${now})`);
    await q.query(sql`UPDATE app.agent_sessions SET last_active_at = GREATEST(last_active_at, ${now}),
      run_lock_run_id = ${req.runId}, run_lock_expires_at = ${lockEnd}, row_version = row_version + 1, updated_at = ${now}
      WHERE app_id = ${appId} AND id = ${session.id}`);
    // B3-09m · BR-AI-16: the new run's reservation, in the transaction that inserted it.
    let verdict: RunBudgetVerdict | undefined;
    if (req.budget !== undefined) {
      // The plan was read for the session's app before BEGIN; a missing or different app cannot
      // be reserved against (nothing is committed; the caller may retry).
      if (budget === undefined || budget.appId !== appId) {
        throw new AdmissionUnavailableError('rolled_back');
      }
      const plan = budget.plan;
      if (plan.blocked) {
        verdict = { exhausted: true, reserved: false, plan };
      } else {
        const runner: BudgetQueries = q;
        const { exhausted } = await req.budget.daily.reserve(runner, {
          runId: req.runId,
          acceptedAt: now,
          budgetMfen: plan.budgetMfen,
          reserveMfen: plan.reserveMfen,
          priceVersion: plan.priceVersion,
        });
        verdict = { exhausted, reserved: !exhausted, plan };
      }
    }
    const accepted: AdmissionResult = {
      kind: 'accepted',
      ticket: {
        runId: req.runId,
        messageId: req.messageId,
        sessionId: session.id,
        subject: structuredClone(req.subject),
        dayKey: dayKeyOf(now),
        acceptedAtMs: now.getTime(),
        lockExpiresAtMs: lockEnd.getTime(),
      },
      quotaLeft: remaining(
        subjects,
        limits,
        counts.map((count) => count + 1),
      ),
    };
    if (verdict !== undefined) verdicts.set(accepted, verdict);
    return accepted;
  }

  return async function admit(
    req: BudgetedAdmissionRequest,
    limits: AdmissionLimits,
  ): Promise<AdmissionResult> {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('Invalid admission limit');
    }
    let budget: Awaited<ReturnType<typeof budgetPlanOf>>;
    try {
      budget = await budgetPlanOf(req);
    } catch (error) {
      return unavailable(error);
    }
    for (let attempt = 0; ; attempt += 1) {
      let answer: AdmissionResult | undefined;
      try {
        return await transaction('admit', async (q) => {
          answer = await accept(q, req, limits, budget);
          return answer;
        });
      } catch (error) {
        const hold = holdFailure(error);
        if (hold) {
          await finalization.markHold(hold);
          throw new AdmissionHeldError(hold.reason);
        }
        if (error instanceof TransactionFailure && error.original instanceof AdmissionHeldError)
          throw error.original;
        if (error instanceof TransactionFailure && error.commitAttempted) {
          if (answer?.kind === 'rejected') return answer;
          // A duplicate's inline finalization must be confirmed before replaying its frame.
          if (answer?.kind !== 'accepted') throw new AdmissionUnavailableError('unknown');
          let found: string | undefined;
          try {
            found = await transaction('lookup', async (q) => {
              const session = await lockSession(q, req.sessionId);
              return session ? (await messageRun(q, session, req.clientMsgId))?.run_id : undefined;
            });
          } catch {
            deps.logger?.warn({ run_id: req.runId }, 'agent.accept_outcome_unknown');
            throw new AdmissionUnavailableError('unknown');
          }
          if (found === req.runId) return answer;
          if (found !== undefined && attempt === 0) continue;
          throw new AdmissionUnavailableError('rolled_back');
        }
        if (
          attempt === 0 &&
          errorCode(error) === '23505' &&
          error instanceof TransactionFailure &&
          typeof error.original === 'object' &&
          error.original !== null &&
          'constraint' in error.original &&
          error.original.constraint === 'agent_messages_client_msg_key'
        )
          continue;
        return unavailable(error);
      }
    }
  };
}

/** The budget for the alert check of a stale run settled by this admission (none: no check). */
function staleBudgetMfen(budget: { readonly plan: RunBudgetPlan } | undefined): bigint | undefined {
  return budget === undefined || budget.plan.blocked ? undefined : budget.plan.budgetMfen;
}

/** Derive another instant from the one Clock reading, without mutating it. */
function instantPlus(instant: Date, milliseconds: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + milliseconds);
  return result;
}
