// B1-01zzk: effective concurrency of each entry (contract section 12 of
// apps/api/src/modules/platform/queue/index.ts). ENTRY_PLAN and QUEUE_CATALOG stay exactly the
// trunk's (the plan's concurrency is each queue's upper bound); limits only lower a worker queue and
// set the worker's shared budget (default 7 = floor(POOL_SIZES.worker.db × 0.7)); the other entries
// keep their plan and have no shared budget.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { POOL_SIZES } from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
  effectiveLimits,
  type QueueLimits,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { queueErrorProblems, thrown } from '../queue/kit.ts';
import {
  DEFAULT_DB_BUDGET,
  LIMIT_PLAN,
  RESERVED_CONNECTIONS,
  TRUNK_CATALOG,
  TRUNK_ENTRY_PLAN,
  TRUNK_WORKER_PLAN,
  concurrencyOf,
} from './kit.ts';

it('[B1-01zzk 冻结结构不变] ENTRY_PLAN 与 QUEUE_CATALOG 与主干逐字一致且仍冻结；不给 limits 时 worker 22 个队列取计划值（合计 43；B2-06f D10-398 ① 加 payout-review，B2-07c D10-408 / D10-415 ① 加 payout-recon，B2-02q D10-415 ① 加 ledger-check），共享预算缺省 7 = floor(POOL_SIZES.worker.db × 0.7)，至少留 3 个连接', () => {
  expect(ENTRY_PLAN).toStrictEqual(TRUNK_ENTRY_PLAN);
  expect(QUEUE_CATALOG).toStrictEqual(TRUNK_CATALOG);
  expect(
    [ENTRY_PLAN, ENTRY_PLAN.worker, ...ENTRY_PLAN.worker, QUEUE_CATALOG, ...QUEUE_CATALOG].every(
      (value) => Object.isFrozen(value),
    ),
  ).toBe(true);
  // B1-03z: evt.risk-appeal-restore adds one slot (43 → 44 after B2-02q's ledger-check); B1-12u:
  // evt.notification-withdrawal-result adds five (44 → 49); B2-05n (D10-475 ②): payout-overdue
  // adds one (49 → 50); B1-12zc (D10-773 ①): evt.notification-clawback adds five (50 → 55). The
  // title keeps its frozen wording.
  expect(TRUNK_WORKER_PLAN.reduce((sum, item) => sum + item.concurrency, 0)).toBe(55);
  expect(TRUNK_ENTRY_PLAN.payout.reduce((sum, item) => sum + item.concurrency, 0)).toBe(2);
  expect(DEFAULT_DB_BUDGET).toBe(Math.floor(POOL_SIZES.worker.db * 0.7));
  expect(POOL_SIZES.worker.db - DEFAULT_DB_BUDGET).toBeGreaterThanOrEqual(RESERVED_CONNECTIONS);
  expect(effectiveLimits('worker', ENTRY_PLAN)).toStrictEqual({
    concurrency: concurrencyOf(TRUNK_WORKER_PLAN),
    dbBudget: DEFAULT_DB_BUDGET,
  });
  expect(effectiveLimits('worker', ENTRY_PLAN, { concurrency: {}, dbBudget: null })).toStrictEqual({
    concurrency: concurrencyOf(TRUNK_WORKER_PLAN),
    dbBudget: DEFAULT_DB_BUDGET,
  });
});

it('[B1-01zzk 配置覆盖] 覆盖只往下调：列出的队列取覆盖值（等于计划值也接受），没列出的仍取计划值，dbBudget 取给定值（1 与 7 都接受）；计划与 limits 本身都不被改动', () => {
  const limits: QueueLimits = {
    concurrency: {
      'order-sync': 1,
      notify: 2,
      'evt.notification-risk-state': 5,
      pay: 1,
      poster: 1,
    },
    dbBudget: 4,
  };
  const before = structuredClone(limits);
  expect(effectiveLimits('worker', ENTRY_PLAN, limits)).toStrictEqual({
    concurrency: { ...concurrencyOf(TRUNK_WORKER_PLAN), notify: 2, pay: 1, poster: 1 },
    dbBudget: 4,
  });
  expect(limits).toStrictEqual(before);
  expect(ENTRY_PLAN).toStrictEqual(TRUNK_ENTRY_PLAN);
  for (const dbBudget of [1, DEFAULT_DB_BUDGET]) {
    expect(effectiveLimits('worker', ENTRY_PLAN, { concurrency: {}, dbBudget })).toStrictEqual({
      concurrency: concurrencyOf(TRUNK_WORKER_PLAN),
      dbBudget,
    });
  }
  expect(
    effectiveLimits('worker', LIMIT_PLAN, { concurrency: { 'c-a': 1, 'c-c': 2 }, dbBudget: null }),
  ).toStrictEqual({ concurrency: { 'c-a': 1, 'c-b': 4, 'c-c': 2 }, dbBudget: DEFAULT_DB_BUDGET });
});

it('[B1-01zzk 其他入口不受影响] api / stream / admin / payout：有没有 limits 都只取自己的计划值（B2-07e：payout 为 payout 1 与 payout-attempt-append 1），没有共享预算（dbBudget null）', () => {
  const limits: QueueLimits = { concurrency: { notify: 1, 'order-sync': 1 }, dbBudget: 1 };
  const seen: Record<string, unknown> = {};
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    seen[entry] = [effectiveLimits(entry, ENTRY_PLAN), effectiveLimits(entry, ENTRY_PLAN, limits)];
  }
  seen['payout (test plan)'] = effectiveLimits('payout', LIMIT_PLAN, {
    concurrency: { 'c-a': 1 },
    dbBudget: 1,
  });
  const none = { concurrency: {}, dbBudget: null };
  const payout = { concurrency: { payout: 1, 'payout-attempt-append': 1 }, dbBudget: null };
  expect(seen).toStrictEqual({
    api: [none, none],
    stream: [none, none],
    admin: [none, none],
    payout: [payout, payout],
    'payout (test plan)': { concurrency: { 'c-pay': 3 }, dbBudget: null },
  });
});

/** Limits that break section 12, each one rule. */
function badLimits(): Array<[string, unknown]> {
  const accessor = Object.defineProperty({}, 'notify', { get: () => 1, enumerable: true });
  const hidden = Object.defineProperty({}, 'notify', { value: 1, enumerable: false });
  const over = (queue: string, value: unknown) => ({
    concurrency: { [queue]: value },
    dbBudget: null,
  });
  return [
    ['notify above its plan 5', over('notify', 6)],
    ['order-sync above its plan 1', over('order-sync', 2)],
    ['pay above its plan 4', over('pay', 5)],
    ['override 0', over('notify', 0)],
    ['override -1', over('notify', -1)],
    ['override 1.5', over('notify', 1.5)],
    ['override "1"', over('notify', '1')],
    ['override NaN', over('notify', Number.NaN)],
    ['override null', over('notify', null)],
    ['unknown queue', over('nowhere', 1)],
    ['payout queue (payout entry only)', over('payout', 1)],
    ['dead letter queue', over('notify.dead', 1)],
    ['dbBudget 0', { concurrency: {}, dbBudget: 0 }],
    ['dbBudget 8', { concurrency: {}, dbBudget: 8 }],
    ['dbBudget 2.5', { concurrency: {}, dbBudget: 2.5 }],
    ['dbBudget "3"', { concurrency: {}, dbBudget: '3' }],
    ['dbBudget NaN', { concurrency: {}, dbBudget: Number.NaN }],
    ['dbBudget undefined', { concurrency: {}, dbBudget: undefined }],
    ['missing dbBudget', { concurrency: {} }],
    ['missing concurrency', { dbBudget: null }],
    ['extra key', { concurrency: {}, dbBudget: null, ratio: 0.7 }],
    ['limits null', null],
    ['limits an array', []],
    ['limits a Map', new Map()],
    ['concurrency an array', { concurrency: [], dbBudget: null }],
    ['concurrency null', { concurrency: null, dbBudget: null }],
    ['concurrency with an accessor', { concurrency: accessor, dbBudget: null }],
    ['concurrency with a hidden property', { concurrency: hidden, dbBudget: null }],
  ];
}

it('[B1-01zzk 配置覆盖] 合法的 limits 被接受；超过计划值、非整数、不在 worker 计划里的队列、预算不在 1..7、多键缺键、不是普通对象 → 同步抛 QueueError invalid_option（固定文案、无 cause），payout 入口同样检查', () => {
  const run = (entry: 'worker' | 'payout', limits: unknown) =>
    thrown(() => effectiveLimits(entry, ENTRY_PLAN, limits as QueueLimits));
  const seen: Record<string, string> = {
    valid: run('worker', { concurrency: { notify: 5, 'risk-scan': 1 }, dbBudget: 7 }),
    'valid on payout': run('payout', { concurrency: { notify: 1 }, dbBudget: 1 }),
  };
  for (const [label, limits] of badLimits()) seen[label] = run('worker', limits);
  seen['payout: dbBudget 0'] = run('payout', { concurrency: {}, dbBudget: 0 });
  seen['payout: notify above its plan'] = run('payout', {
    concurrency: { notify: 6 },
    dbBudget: 1,
  });
  let shape: string[] = ['returned'];
  try {
    effectiveLimits('worker', ENTRY_PLAN, { concurrency: { notify: 6 }, dbBudget: null });
  } catch (error) {
    shape = queueErrorProblems(error, 'invalid_option');
  }
  expect(seen).toStrictEqual({
    valid: 'returned',
    'valid on payout': 'returned',
    ...Object.fromEntries(badLimits().map(([label]) => [label, 'QueueError invalid_option'])),
    'payout: dbBudget 0': 'QueueError invalid_option',
    'payout: notify above its plan': 'QueueError invalid_option',
  });
  expect(shape).toStrictEqual([]);
});
