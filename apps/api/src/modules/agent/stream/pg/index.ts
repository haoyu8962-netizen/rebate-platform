// Agent acceptance, quota and the single run finalization in PostgreSQL (B3-03g; design
// couli-runs/B3-03g/design.md v5; owner decisions 2026-10-08: acceptance and quota move to PG, the
// ending is what the run row holds; BR-AI-23 table row and 细则「受理记录与收尾」, BR-AI-15,
// BR-AI-13; migration 0023). Rule tests: test/spec/agent/stream-finalize/** and
// test/spec/agent/stream-admission/** import this file by path: names, signatures and the
// semantics written here are the contract.
//
// createPgRunPorts(deps) → {admission, registry, finalizer, cancel}; every port works with Redis
// absent (deps.signals is only a fast path for cancel signals; its failures are ignored).
//
// admission.admit(req, limits) — one READ COMMITTED transaction (design §2.1 A1–A11): session row
//   FOR UPDATE, then now = clock.now() once (every judgement and write uses it); ④ re-check
//   (last_active_at + 24 h ≤ now or expired_at ≤ now, or no row → rejected 30504 'expired'); ⑥ the
//   (session, client_msg_id) user message → D path (§2.3); ⑦ session lock (run_lock_run_id L):
//   L's run FOR UPDATE, L held → AdmissionHeldError (before the running check), now <
//   run_lock_expires_at → rejected 30506, else L and every other unfinished run of the session are
//   finalized inside this transaction (recovery mode, these limits) after the subject advisory
//   locks of (request subjects ∪ their quota_subjects) are taken in ascending order; ⑧ minute
//   window on quota_subjects[1] (accepted_at > now − 60 000 ms; count ≥ perMinute → 42901,
//   retryAfterSeconds = max(1, ceil((oldest + 60 000 − now) / 1000))); ⑨ runs of the session ≥
//   maxRounds → 30504 'round_limit'; ⑩ per subject, runs of that subject accepted in
//   dayRange(dayKeyOf(now)) with settle_result IS DISTINCT FROM 'refunded' ≥ its limit → 30502
//   {resetAt: nextResetAt(now), next: nextStepOf(subject)}. Accepting writes, in the same
//   transaction: agent_runs (id runId, accepted_at now, quota_subjects subjectKeys(subject),
//   deadline_at now + runMaxMs, user_text runUserText, prompt_version, model_snapshot), the user
//   message (id messageId, client_msg_id, run_id, text messageText) and the assistant message (id
//   assistantMessageId, text NULL), and the session (last_active_at = GREATEST(last_active_at,
//   now), run_lock_run_id runId, run_lock_expires_at now + runMaxMs + lockGraceMs). A rejected
//   request writes nothing but the left-over finalizations. Returns accepted {ticket: {runId,
//   messageId, sessionId, subject, dayKey: dayKeyOf(now), acceptedAtMs: now, lockExpiresAtMs},
//   quotaLeft: min over subjects of (limit − today's unrefunded runs incl. this one), ≥ 0}.
//   D path (⑥ hit, run R, under the session lock and R's row lock): R held → AdmissionHeldError;
//   R has final_event → duplicate final(fromStored(final_event)); R holds the lock and now <
//   run_lock_expires_at → duplicate running, nothing written; else finalize R (recovery) and
//   return duplicate final. `original` is read from PG. ⑦–⑩ are not judged.
//   Errors: retryable errors before COMMIT → rollback, AdmissionUnavailableError('rolled_back');
//   a COMMIT whose reply is lost (connection gone, or the afterCommit hook rejects) → lookup on a
//   new connection (session row FOR UPDATE, then the user message of client_msg_id): runId found →
//   accepted as if the reply had come; another run → run admit again once (D path); no row →
//   AdmissionUnavailableError('rolled_back'); lookup failing → AdmissionUnavailableError('unknown').
//   A deterministic failure finalizing a left-over run → rollback, mark it held in a new
//   transaction, AdmissionHeldError. The admit `limits` argument is the only limit it uses.
// admission.settle(ticket, outcome, limits) — the live tail S5: limits = deps.limits.current(app)
//   (the argument is ignored); then finalizeRun in live mode, one independent transaction; one
//   retry on a retryable error, then AdmissionUnavailableError. Returns {refunded, quotaLeft}:
//   refunded is the stored settle_result ('refunded'); quotaLeft the remaining quota at this call
//   (on a re-entry, recomputed without changing the stored terminal).
// finalizeRun (design §3.2 F0–F7; shared by admit, settle and finalizer.finalize):
//   F1 session row, run row FOR UPDATE, then the run's subject locks; F2 final_event present → no
//   write, kind final with the stored frame; F2a finalize_hold → kind held; F3 the ending: the
//   stored end_reason / end_draft / card_delivered when present; else live mode → the decision
//   UPDATE with this instance's memo (recordEnding / recordFacts; without one, settle's outcome and
//   the draft saved by recordFacts); else recovery: the lock still belongs to the run and now <
//   run_lock_expires_at → kind running, no write; otherwise the decision UPDATE with server_error
//   and the draft error{50001, texts.errorMsg(50001), retryable true, fallback null}. F4 refunded =
//   shouldRefund({ending, cardsDelivered: card_delivered ? 1 : 0}); quotaLeft = min over subjects of
//   max(0, L_i − today's unrefunded runs of subject i) (today = dayKeyOf(now) of this
//   finalization). F5 one UPDATE: settle_result, settled_at now, final_event =
//   toStored(withQuota(draft, quotaLeft)), ended_at GREATEST(now, accepted_at), finish_reason.
//   B3-08zh (BR-AI-22): a session the purge detached (user_id NULL, user_hash set; read under F1's
//   lock) gets final_event and end_draft as redactedStored (data.msg / data.fallback_q → null).
//   F5a (B3-08zc, BR-AI-19 细则「助手回复落库」) in the same transaction, live mode only (settle's
//   reply, the 4th argument): the run's assistant row gets text and card_ids, its cards go to
//   agent_cards (./reply.ts), and the cards kept while the client was gone (reply.unframed) get
//   the delivery records their receipt would have written (./deliveries.ts); recovery writes no
//   reply; agent_sessions.last_active_at is never touched here (BR-AI-20).
//   F6 in the same transaction: clear the session lock when it holds this run. Deterministic
//   failures (StoredFrameInvalid; 23514 / 23001 at F3 / F5) → rollback and finalize_hold
//   ('stored_frame_invalid' | 'facts_inconsistent') in a new transaction.
// The decision UPDATE (S4, S4′, F3; design §3.3): end_reason = CASE WHEN cancel_requested_at IS
//   NULL THEN $ending ELSE 'cancelled' END, end_draft likewise ($draft or done{finish_reason
//   'cancelled'}), card_delivered = card_delivered OR $cards, WHERE end_reason IS NULL; the first
//   committed one decides (cancel committed first → cancelled).
// registry (RunRegistry for createRunManager): register is a no-op that never fails;
//   recordEnding(runId, facts, draft) = S4: memo, then the decision UPDATE at once (one retry),
//   RETURNING into the memo; recordFacts(runId, {ending: null, cards}) = S3 (card_delivered = true
//   WHERE end_reason IS NULL, when cards > 0); recordFacts with an ending = S4′ (same decision
//   UPDATE); facts / draft / final read the run row; finish(runId, terminal) returns
//   fromStored(final_event) (S6; the manager sends that frame; B3-08zh: `terminal` itself when the
//   stored form is its BR-AI-22 redaction, the session detached during the run); cancelRequested:
//   signals first, otherwise cancel_requested_at IS NOT NULL read at most every cancelPgPollMs;
//   requestCancel is not used by B3-03d (cancel below).
// cancel({appId, runId}) — the cancel endpoint's write (design §5.2, §13 S2-2, S2-3): in one
//   transaction take the run row lock, then read the clock; UPDATE cancel_requested_at =
//   GREATEST(now, accepted_at) WHERE end_reason IS NULL AND final_event IS NULL AND
//   cancel_requested_at IS NULL AND now < deadline_at → 'accepted'; a repeated call on a run whose
//   cancel_requested_at is set and whose end_reason is NULL or 'cancelled' → 'accepted' with no
//   write; anything else (no such run, ended, other ending, deadline reached) → 'not_running'.
//   'accepted' guarantees the run ends cancelled. Then signals?.requestCancel best effort. An
//   error before its COMMIT rolls back and rejects (no retry; B3-03d maps it, the client retries).
//   The run row lock is taken before anything about the run is read: an ending committed while
//   the cancel waited for that lock is seen (→ 'not_running'), never a value read before it.
// finalizer.finalize(runId) — finalizeRun in recovery mode, one independent transaction, limits
//   from deps.limits.current(appId) (a rejection → AdmissionUnavailableError, nothing written).
// assertRunTimings(t): throws RangeError unless runMaxMs === admissionRunMaxMs, lockGraceMs ≥
//   30 000, sweepMarginMs ≥ 0, 0 < cancelPgPollMs ≤ 5 000 and every value is a safe integer.
// runTimingsDefaults(): {runMaxMs 20 000, lockGraceMs 30 000, cancelPgPollMs 2 000}.
//
// Test seams (TxHooks, all optional, default no-ops; design §7.1). `step` names the transaction or
// statement: admit (the admission transaction, D path and inline finalizations included), lookup
// (§2.5), hold, facts (S3), ending (S4 / S4′), settle (S5), finish (S6 read), finalize
// (finalizer.finalize), cancel (cancel write), cancel_poll (the PG cancel read).
//   beforeSql(step, pid): awaited before every SQL statement of the step, with the backend pid of
//     its connection; a rejection counts as a lost connection (retryable).
//   beforeCommit(step, pid): awaited after the step's last statement, before COMMIT (locks held);
//     a rejection is a connection lost before COMMIT: the transaction rolls back (its locks go)
//     and the step fails like any retryable error. cancel is never retried: it rejects.
//   afterCommit(step): awaited after COMMIT succeeded; a rejection counts as a COMMIT whose reply
//     was lost (for admit: the lookup above).
//   crash(point, phase): called synchronously before the step sends anything ('before') and after
//     its COMMIT succeeded and afterCommit resolved ('after'); an exception propagates out of the
//     port method as it is (never retried, never translated) — it models the process dying there.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock,
// data access only through Kysely on deps.db.
import type { PgRunDeps, PgRunPorts, RunTimings } from './types.ts';
import { buildPgRunPorts } from './ports.ts';

export type {
  FinalizeHold,
  FinalizeOutcome,
  Finalizer,
  RunTimings,
  TxStep,
  CrashPoint,
  TxHooks,
  PgRunDeps,
  PgRunRegistry,
  CancelQuery,
  PgRunPorts,
} from './types.ts';
export { fromStored, StoredFrameInvalid, toStored, withQuota } from './frames.ts';
export type { StoredFrame } from './frames.ts';
export { createQuotaLimitsSource } from './limits.ts';
export type { QuotaLimitsSource, QuotaLimitsSourceDeps } from './limits.ts';

export function createPgRunPorts(deps: PgRunDeps): PgRunPorts {
  assertRunTimings({ ...deps.timings, admissionRunMaxMs: deps.timings.runMaxMs, sweepMarginMs: 0 });
  return buildPgRunPorts({ ...deps, timings: Object.freeze({ ...deps.timings }) });
}

export function assertRunTimings(
  timings: RunTimings & { readonly admissionRunMaxMs: number; readonly sweepMarginMs: number },
): void {
  if (
    Object.values(timings).some((n) => !Number.isSafeInteger(n) || n < 0) ||
    timings.runMaxMs !== timings.admissionRunMaxMs ||
    timings.lockGraceMs < 30_000 ||
    timings.cancelPgPollMs <= 0 ||
    timings.cancelPgPollMs > 5_000
  ) {
    throw new RangeError('Invalid agent run timings');
  }
}

export function runTimingsDefaults(): RunTimings {
  return { runMaxMs: 20_000, lockGraceMs: 30_000, cancelPgPollMs: 2_000 };
}
