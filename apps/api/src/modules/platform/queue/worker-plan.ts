// The worker entry's lanes and limits as plain data (B1-01zzk; contract section 12 of ./index.ts).
// A leaf module without imports: platform/config reads it, and platform/config must not depend on
// ./types.ts (which reaches back into platform/config through the logger).

/** ENTRY_PLAN.worker as [queue, concurrency, pollingIntervalSeconds]; ./catalog.ts builds it. */
export const WORKER_LANES: readonly (readonly [string, number, number])[] = Object.freeze([
  Object.freeze(['order-sync', 1, 2] as const),
  Object.freeze(['order-rescan', 1, 2] as const),
  Object.freeze(['settle', 1, 2] as const),
  // One worker lands W5 / W6 of the payout results, serially (B2-06fz, D10-326 C).
  Object.freeze(['payout-landing', 1, 2] as const),
  // One worker reviews BR-WDR-13 ③ of a transfer under the users lock (B2-06f, D10-398 ①).
  Object.freeze(['payout-review', 1, 2] as const),
  // One worker reconciles the payout channel's daily bill (B2-07c, D10-408), serially.
  Object.freeze(['payout-recon', 1, 2] as const),
  // One worker runs the daily ledger check (B2-02q, BR-FUND-19), serially.
  Object.freeze(['ledger-check', 1, 2] as const),
  // B2-05n (BR-WDR-26, D10-475 ②): the worker's review-overdue check, right after ledger-check.
  Object.freeze(['payout-overdue', 1, 2] as const),
  Object.freeze(['notify', 5, 2] as const),
  Object.freeze(['union-auth', 1, 2] as const),
  Object.freeze(['evt.notification-risk-state', 5, 2] as const),
  Object.freeze(['evt.notification-appeal-result', 5, 2] as const),
  Object.freeze(['evt.notification-claim-result', 5, 2] as const),
  // B1-12u: withdrawal result messages (WD_SUCCESS / WD_REJECTED / WD_FAILED), five slots.
  Object.freeze(['evt.notification-withdrawal-result', 5, 2] as const),
  // B1-12zc: CLAWBACK / SETTLE_ADJUSTED messages (D10-773 ①), five slots.
  Object.freeze(['evt.notification-clawback', 5, 2] as const),
  // B1-03z: appeal_restore differences of revoked ban appeals, one slot, serially.
  Object.freeze(['evt.risk-appeal-restore', 1, 2] as const),
  // B2-11c: one decision per withdrawal under the users / balance / daily-total locks, serially.
  Object.freeze(['evt.payout-auto-payout', 1, 2] as const),
  // One worker: the member's withdrawals are re-checked under the users lock, serially.
  Object.freeze(['evt.payout-went-negative', 1, 2] as const),
  // B2-15b: payment's queue, worker only, four slots (task §9.10).
  Object.freeze(['pay', 4, 2] as const),
  Object.freeze(['pool-refresh', 1, 2] as const),
  Object.freeze(['page-schedule', 1, 2] as const),
  Object.freeze(['poster', 2, 0.5] as const),
  Object.freeze(['data-copy', 1, 2] as const),
  Object.freeze(['agent-trace', 2, 2] as const),
  Object.freeze(['export', 1, 2] as const),
  Object.freeze(['risk-scan', 1, 2] as const),
]);

/**
 * Default and largest shared budget of the worker: floor(POOL_SIZES.worker.db 10 × 7 / 10) = 7,
 * leaving at least 3 connections to supervision, the dead letter scan and the health checks.
 * ./worker-plan.test.ts keeps it in step with POOL_SIZES.
 */
export const WORKER_DB_BUDGET = 7;

/**
 * Concurrency limits of the worker entry (B1-01zzk, section 12): lower per-queue concurrency than
 * the plan's and the shared budget of handler calls running at once. Exactly these two keys.
 */
export interface QueueLimits {
  /** Queue of plan.worker → integer from 1 to that queue's plan concurrency. */
  readonly concurrency: Readonly<Record<string, number>>;
  /** null (the default budget 7) or an integer from 1 to 7. */
  readonly dbBudget: number | null;
}
