// Shared values of the B1-01zzk rule tests (worker queue concurrency limits: contract section 12 of
// apps/api/src/modules/platform/queue/index.ts, apps/api/src/modules/platform/config/queue-concurrency.ts).
// Every expected value is written out by hand from the task brief and the trunk, never read from
// the implementation. Nothing here imports the test-database base (`@couli/db/testing`).
import type {
  EntryPlan,
  QueueSpec,
  WorkSpec,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { TEST_DEAD, spec } from '../queue/kit.ts';

export function w(queue: string, concurrency: number, pollingIntervalSeconds = 2): WorkSpec {
  return { queue, concurrency, pollingIntervalSeconds };
}

/**
 * ENTRY_PLAN.worker of the trunk (task brief, 现状), in order: 26 queues, 55 slots together (B2-06f
 * D10-398 ①: payout-review; B2-07c D10-408: payout-recon; B2-02q D10-415 ①: ledger-check; B1-03z: evt.risk-appeal-restore;
 * B1-12u: evt.notification-withdrawal-result; B2-05n D10-475 ②: payout-overdue; B1-12zc D10-773 ①:
 * evt.notification-clawback).
 */
export const TRUNK_WORKER_PLAN: readonly WorkSpec[] = [
  w('order-sync', 1),
  w('order-rescan', 1),
  w('settle', 1),
  // B2-06fz (D10-326 取 C; D10-376): the worker lands W5 / W6, right after settle.
  w('payout-landing', 1),
  // B2-06f (D10-398 ①): the worker's BR-WDR-13 ③ review, right after payout-landing.
  w('payout-review', 1),
  // B2-07c (D10-408): the worker's daily R2 channel reconciliation, right after payout-review.
  w('payout-recon', 1),
  // B2-02q (D10-415 ①): the worker's daily ledger check (BR-FUND-19), right after payout-recon.
  w('ledger-check', 1),
  // B2-05n (BR-WDR-26, D10-475 ②): the worker's review overdue check, right after ledger-check.
  w('payout-overdue', 1),
  w('notify', 5),
  w('union-auth', 1),
  w('evt.notification-risk-state', 5),
  w('evt.notification-appeal-result', 5),
  w('evt.notification-claim-result', 5),
  // B1-12u (BR-TEXT-09, BR-WDR-26): notification's wallet.withdrawal_changed consumer, five slots,
  // right after evt.notification-claim-result.
  w('evt.notification-withdrawal-result', 5),
  // B1-12zc (BR-TEXT-09, D10-773 ①): notification's order.clawed_back / order.settle_adjusted
  // consumer, five slots, right after evt.notification-withdrawal-result.
  w('evt.notification-clawback', 5),
  // B1-03z (BR-FUND-22, BR-CALC-13 细则「申诉恢复」): risk's appeal.resolved consumer, one slot,
  // right after evt.notification-claim-result.
  w('evt.risk-appeal-restore', 1),
  // B2-11c (BR-WDR-30): payout's withdrawal.created consumer, one slot, before went-negative.
  w('evt.payout-auto-payout', 1),
  w('evt.payout-went-negative', 1),
  w('pay', 4),
  w('pool-refresh', 1),
  w('page-schedule', 1),
  w('poster', 2, 0.5),
  w('data-copy', 1),
  w('agent-trace', 2),
  w('export', 1),
  w('risk-scan', 1),
];

/**
 * ENTRY_PLAN of the trunk: only the worker and payout work queues; payout 1 (规划/02 §3.1). B2-07e
 * (D10-428, D10-415 ①): the payout process also appends the W11 attempt records, queue
 * payout-attempt-append, concurrency 1, after payout.
 */
export const TRUNK_ENTRY_PLAN: EntryPlan = {
  api: [],
  stream: [],
  admin: [],
  worker: TRUNK_WORKER_PLAN,
  payout: [w('payout', 1), w('payout-attempt-append', 1)],
};

/** Business queues of the trunk catalog, in catalog order. */
const TRUNK_BUSINESS_QUEUES = [
  'order-sync',
  'order-rescan',
  'settle',
  'payout',
  'payout-landing',
  'payout-review',
  'payout-recon',
  'ledger-check',
  // B2-05n (D10-475 ②): the worker's review overdue check, right after ledger-check.
  'payout-overdue',
  // B2-07e (D10-428): the payout process's W11 attempt records, right after payout-recon.
  'payout-attempt-append',
  'notify',
  'union-auth',
  'evt.notification-risk-state',
  'evt.notification-appeal-result',
  'evt.notification-claim-result',
  // B1-12u: notification's wallet.withdrawal_changed consumer, right after the claim result one.
  'evt.notification-withdrawal-result',
  // B1-12zc: notification's order.clawed_back / order.settle_adjusted consumer, right after it.
  'evt.notification-clawback',
  'evt.risk-appeal-restore',
  'evt.payout-auto-payout',
  'evt.payout-went-negative',
  'pay',
  'pool-refresh',
  'page-schedule',
  'poster',
  'data-copy',
  'agent-trace',
  'risk-scan',
  'export',
] as const;

const TRUNK_EXCLUSIVE: ReadonlySet<string> = new Set([
  'order-sync',
  'settle',
  'payout',
  'payout-landing',
  'payout-review',
  'payout-recon',
  'ledger-check',
  // B2-05n: one queued or active job per 5-minute slot singletonKey.
  'payout-overdue',
  // B2-07e: one queued or active job per (withdrawal, difference) singletonKey.
  'payout-attempt-append',
  'risk-scan',
  'union-auth',
  'pay',
]);

/** QUEUE_CATALOG of the trunk: the business queues, then their `.dead` queues in the same order. */
export const TRUNK_CATALOG: readonly QueueSpec[] = [
  ...TRUNK_BUSINESS_QUEUES.map((name): QueueSpec => ({
    name,
    policy: TRUNK_EXCLUSIVE.has(name) ? 'exclusive' : 'standard',
    retryLimit: 5,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 600,
    expireInSeconds: 900,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetter: `${name}.dead`,
  })),
  ...TRUNK_BUSINESS_QUEUES.map((name): QueueSpec => ({
    name: `${name}.dead`,
    policy: 'standard',
    retryLimit: 0,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retryDelayMaxSeconds: null,
    expireInSeconds: 900,
    retentionSeconds: 2_592_000,
    deleteAfterSeconds: 2_592_000,
    deadLetter: null,
  })),
];

/** The default shared budget of the worker: floor(POOL_SIZES.worker.db 10 × 0.7). */
export const DEFAULT_DB_BUDGET = 7;
/** Connections of the worker's pool kept for supervision and health checks (task brief 取值 3). */
export const RESERVED_CONNECTIONS = 3;

/** QUEUE_CONCURRENCY_<Q> of each worker queue: upper case, '-' and '.' replaced by '_'. */
export const ENV_NAME_OF: Readonly<Record<string, string>> = {
  'order-sync': 'QUEUE_CONCURRENCY_ORDER_SYNC',
  'order-rescan': 'QUEUE_CONCURRENCY_ORDER_RESCAN',
  settle: 'QUEUE_CONCURRENCY_SETTLE',
  'payout-landing': 'QUEUE_CONCURRENCY_PAYOUT_LANDING',
  'payout-review': 'QUEUE_CONCURRENCY_PAYOUT_REVIEW',
  'payout-recon': 'QUEUE_CONCURRENCY_PAYOUT_RECON',
  'ledger-check': 'QUEUE_CONCURRENCY_LEDGER_CHECK',
  'payout-overdue': 'QUEUE_CONCURRENCY_PAYOUT_OVERDUE',
  notify: 'QUEUE_CONCURRENCY_NOTIFY',
  'union-auth': 'QUEUE_CONCURRENCY_UNION_AUTH',
  'evt.notification-risk-state': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_RISK_STATE',
  'evt.notification-appeal-result': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_APPEAL_RESULT',
  'evt.notification-claim-result': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_CLAIM_RESULT',
  'evt.notification-withdrawal-result': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_WITHDRAWAL_RESULT',
  'evt.notification-clawback': 'QUEUE_CONCURRENCY_EVT_NOTIFICATION_CLAWBACK',
  'evt.risk-appeal-restore': 'QUEUE_CONCURRENCY_EVT_RISK_APPEAL_RESTORE',
  'evt.payout-auto-payout': 'QUEUE_CONCURRENCY_EVT_PAYOUT_AUTO_PAYOUT',
  'evt.payout-went-negative': 'QUEUE_CONCURRENCY_EVT_PAYOUT_WENT_NEGATIVE',
  pay: 'QUEUE_CONCURRENCY_PAY',
  'pool-refresh': 'QUEUE_CONCURRENCY_POOL_REFRESH',
  'page-schedule': 'QUEUE_CONCURRENCY_PAGE_SCHEDULE',
  poster: 'QUEUE_CONCURRENCY_POSTER',
  'data-copy': 'QUEUE_CONCURRENCY_DATA_COPY',
  'agent-trace': 'QUEUE_CONCURRENCY_AGENT_TRACE',
  export: 'QUEUE_CONCURRENCY_EXPORT',
  'risk-scan': 'QUEUE_CONCURRENCY_RISK_SCAN',
};

/** The shared budget variable. */
export const BUDGET_ENV = 'QUEUE_DB_BUDGET';

function work(queue: string, concurrency: number): WorkSpec {
  return { queue, concurrency, pollingIntervalSeconds: 0.5 };
}

/**
 * Catalog of the runtime tests: three standard worker queues `c-a`, `c-b`, `c-c`, the payout
 * entry's `c-pay` and the dead letter queue of ../queue/kit.ts (expiry 60 s: nothing expires).
 */
export const LIMIT_CATALOG: readonly QueueSpec[] = [
  spec('c-a'),
  spec('c-b'),
  spec('c-c'),
  spec('c-pay'),
  TEST_DEAD,
];

/** Worker c-a 4 + c-b 4 + c-c 2 = 10 slots (the worker pool's size); payout c-pay 3. */
export const LIMIT_PLAN: EntryPlan = {
  api: [],
  stream: [],
  admin: [],
  worker: [work('c-a', 4), work('c-b', 4), work('c-c', 2)],
  payout: [work('c-pay', 3)],
};

/** queue → concurrency of a plan's items. */
export function concurrencyOf(items: readonly WorkSpec[]): Record<string, number> {
  return Object.fromEntries(items.map((item) => [item.queue, item.concurrency]));
}
