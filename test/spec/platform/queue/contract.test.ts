// Rule tests of the job queue without a database (ADR-0001 §2 队列与事件, §4.2 第 14、19 项; 规划/02 §11
// 队列拆分, §3.1 payout concurrency=1, §16.3 不要绕过 JobQueue; contract sections 1–3, 5, 6, 8, 9, 11 of
// apps/api/src/modules/platform/queue/index.ts). The db handle points at 127.0.0.1:1 where nothing
// listens; the tests count the connection attempts of every socket, which must stay 0 (creating a
// runtime and every rejected send touch no connection).
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRY_PLAN,
  MAX_PAYLOAD_BYTES,
  PGBOSS_SCHEMA,
  PGBOSS_SCHEMA_VERSION,
  QUEUE_CATALOG,
  createQueueRuntime,
  type EntryPlan,
  type JobPayload,
  type QueueRuntime,
  type QueueSpec,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { envFor, urlsOf, watchSocketConnects } from '../db/kit.ts';
import {
  ENTRIES,
  TEST_CATALOG,
  TEST_PLAN,
  describeError,
  memoryLogger,
  rejectionProblems,
  settled,
  spec,
  thrown,
  thrownProblems,
  type Entry,
} from './kit.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, '../../../../apps/api/src');
const QUEUE_DIR = path.join(API_SRC, 'modules/platform/queue');

function handlesFor(entry: Entry, label: string): DbHandles {
  const { logger } = memoryLogger(entry);
  return createDbHandles(loadConnectionConfig(entry, envFor(entry, urlsOf(label).env)), {
    logger,
  });
}

/** A runtime on a db handle that connects nowhere; `null` plus the reason when creation threw. */
function runtimeFor(
  entry: Entry,
  label: string,
  extra: Record<string, unknown> = { catalog: TEST_CATALOG, plan: TEST_PLAN },
): { runtime: QueueRuntime | null; handles: DbHandles; reason: string } {
  const handles = handlesFor(entry, label);
  const { logger } = memoryLogger(entry);
  try {
    const runtime = createQueueRuntime({ entry, db: handles.db, logger, ...extra } as never);
    return { runtime, handles, reason: 'created' };
  } catch (error) {
    return { runtime: null, handles, reason: describeError(error) };
  }
}

const DEFAULT = {
  policy: 'standard',
  retryLimit: 5,
  retryDelaySeconds: 10,
  retryBackoff: true,
  retryDelayMaxSeconds: 600,
  expireInSeconds: 900,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
  deadLetter: 'dead-letter',
} as const;

it('[ADR-0001 §4.2 #14] 常量：pg-boss schema 名 pgboss、期望 schema 版本 42、负载上限 16384 字节；生产目录与入口计划可直接创建运行时且不连库', async () => {
  const sockets = watchSocketConnects();
  try {
    const { runtime, handles, reason } = runtimeFor('worker', 'consts', {});
    const seen = {
      schema: PGBOSS_SCHEMA,
      version: PGBOSS_SCHEMA_VERSION,
      limit: MAX_PAYLOAD_BYTES,
      reason,
      methods:
        runtime === null
          ? null
          : ['register', 'send', 'start', 'stop'].map((name) => typeof (runtime as never)[name]),
    };
    await handles.close();
    expect(seen).toEqual({
      schema: 'pgboss',
      version: 42,
      limit: 16_384,
      reason: 'created',
      methods: ['function', 'function', 'function', 'function'],
    });
    expect(sockets.count()).toBe(0);
  } finally {
    sockets.restore();
  }
});

it('[规划/02 §11 队列拆分; ADR-0001 §4.2 #19] 生产队列目录逐项确切（待编排会话确认的默认值）：payout、settle 为 exclusive（risk-scan 若有亦然），其余 standard，死信队列 dead-letter', () => {
  // B1-03s: B1-03j adds risk-scan; when present it must be exactly this entry, right after
  // agent-trace (its existence is pinned by [AC-B1-03j#12]). Everything else stays exact.
  const riskScan = QUEUE_CATALOG.findIndex((queue) => queue.name === 'risk-scan');
  if (riskScan !== -1) {
    expect(QUEUE_CATALOG[riskScan]).toStrictEqual({
      name: 'risk-scan',
      ...DEFAULT,
      deadLetter: 'risk-scan.dead',
      policy: 'exclusive',
    });
    expect(QUEUE_CATALOG[riskScan - 1]?.name).toBe('agent-trace');
  }
  // B1-08g: order-sync (incremental order sync windows), when present, is exactly this entry,
  // right before order-rescan. Everything else stays exact.
  const orderSync = QUEUE_CATALOG.findIndex((queue) => queue.name === 'order-sync');
  if (orderSync !== -1) {
    expect(QUEUE_CATALOG[orderSync]).toStrictEqual({
      name: 'order-sync',
      ...DEFAULT,
      deadLetter: 'order-sync.dead',
      policy: 'exclusive',
    });
    expect(QUEUE_CATALOG[orderSync + 1]?.name).toBe('order-rescan');
  }
  // B1-34c: export (admin data exports), when present, is exactly this standard entry with the
  // defaults, right after risk-scan and right before dead-letter. Everything else stays exact.
  const exportAt = QUEUE_CATALOG.findIndex((queue) => queue.name === 'export');
  if (exportAt !== -1) {
    expect(QUEUE_CATALOG.filter((queue) => queue.name === 'export')).toHaveLength(1);
    expect(QUEUE_CATALOG[exportAt]).toStrictEqual({
      name: 'export',
      ...DEFAULT,
      deadLetter: 'export.dead',
    });
    expect(QUEUE_CATALOG[exportAt - 1]?.name).toBe('risk-scan');
    expect(QUEUE_CATALOG[exportAt + 1]?.name).toBe('order-sync.dead');
  }
  // F1-09q：page-schedule（页面定时发布）有则钉死，F1-09p 合并后收紧。Exactly one standard entry with
  // the defaults, right after pool-refresh and right before poster. Everything else stays exact.
  const pageScheduleAt = QUEUE_CATALOG.findIndex((queue) => queue.name === 'page-schedule');
  if (pageScheduleAt !== -1) {
    expect(QUEUE_CATALOG.filter((queue) => queue.name === 'page-schedule')).toHaveLength(1);
    expect(QUEUE_CATALOG[pageScheduleAt]).toStrictEqual({
      name: 'page-schedule',
      ...DEFAULT,
      deadLetter: 'page-schedule.dead',
    });
    expect(QUEUE_CATALOG[pageScheduleAt - 1]?.name).toBe('pool-refresh');
    expect(QUEUE_CATALOG[pageScheduleAt + 1]?.name).toBe('poster');
  }
  // B2-05h 两态过渡（D10-208）：B2-05e 合并后由收紧任务 B2-05j 改回单态。Without
  // evt.payout-went-negative the list below is exactly the original one; with it, the entry sits
  // right after evt.notification-appeal-result with the defaults.
  const hasPayoutWentNegative = QUEUE_CATALOG.some((q) => q.name === 'evt.payout-went-negative');
  // B1-22b: union-auth must appear exactly once, exclusive with directory defaults, between
  // notify and evt.notification-risk-state.
  const unionAuthAt = QUEUE_CATALOG.findIndex((queue) => queue.name === 'union-auth');
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'union-auth')).toHaveLength(1);
  expect(QUEUE_CATALOG[unionAuthAt]).toStrictEqual({
    name: 'union-auth',
    ...DEFAULT,
    policy: 'exclusive',
    deadLetter: 'union-auth.dead',
  });
  expect(QUEUE_CATALOG[unionAuthAt - 1]?.name).toBe('notify');
  expect(QUEUE_CATALOG[unionAuthAt + 1]?.name).toBe('evt.notification-risk-state');
  // B2-15b: pay (payment's order.query / order.close jobs), when present, is exactly one exclusive
  // entry with the directory defaults, right after evt.payout-went-negative and right before
  // pool-refresh. Everything else stays exact.
  const payAt = QUEUE_CATALOG.findIndex((queue) => queue.name === 'pay');
  expect(payAt).not.toBe(-1);
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'pay')).toHaveLength(1);
  expect(QUEUE_CATALOG[payAt]).toStrictEqual({
    name: 'pay',
    ...DEFAULT,
    policy: 'exclusive',
    deadLetter: 'pay.dead',
  });
  expect(QUEUE_CATALOG[payAt - 1]?.name).toBe('evt.payout-went-negative');
  expect(QUEUE_CATALOG[payAt + 1]?.name).toBe('pool-refresh');
  // B2-06fz（D10-326 取 C）：payout-landing 是 worker 落库 W5 / W6 的队列，重试策略同 payout 行
  // （exclusive：按 `${withdrawal_id}:${execute_seq}:land:${attempt_id}` 去重），紧跟 payout 之后；
  // 死信队列 payout-landing.dead 恰一条，设置同其他 `<q>.dead`（下面的列表滤掉 .dead，故在此钉住）。
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'payout-landing.dead')).toStrictEqual([
    {
      name: 'payout-landing.dead',
      policy: 'standard',
      retryLimit: 0,
      retryDelaySeconds: 1,
      retryBackoff: false,
      retryDelayMaxSeconds: null,
      expireInSeconds: 900,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
      deadLetter: null,
    },
  ]);
  expect(
    QUEUE_CATALOG.filter(
      (queue) =>
        queue.name !== 'risk-scan' &&
        queue.name !== 'order-sync' &&
        queue.name !== 'export' &&
        queue.name !== 'union-auth' &&
        queue.name !== 'pay' &&
        queue.name !== 'page-schedule' &&
        // B1-27h（个人信息副本作业，BR-ID-40）的队列，属性由 test/spec/identity/data-copies-worker 钉住。
        queue.name !== 'data-copy' &&
        queue.name !== 'dead-letter' &&
        (!queue.name.endsWith('.dead') || queue.name === 'order-sync.dead'),
    ),
  ).toStrictEqual([
    { name: 'order-rescan', ...DEFAULT, deadLetter: 'order-rescan.dead' },
    { name: 'settle', ...DEFAULT, policy: 'exclusive', deadLetter: 'settle.dead' },
    { name: 'payout', ...DEFAULT, policy: 'exclusive', deadLetter: 'payout.dead' },
    { name: 'payout-landing', ...DEFAULT, policy: 'exclusive', deadLetter: 'payout-landing.dead' },
    // B2-06f（D10-398 ①）：worker 复核 BR-WDR-13 ③ 的队列，exclusive（按 `${withdrawal_id}:${execute_seq}:review` 去重）。
    { name: 'payout-review', ...DEFAULT, policy: 'exclusive', deadLetter: 'payout-review.dead' },
    // B2-07c（D10-408）：worker 的 R2 打款通道日对账队列，exclusive（按 (app, channel, 账单日) 键去重），紧跟 payout-review。
    { name: 'payout-recon', ...DEFAULT, policy: 'exclusive', deadLetter: 'payout-recon.dead' },
    // B2-02q（D10-415 ①）：worker 的 ledger 日终校验队列，exclusive（按 `daily:<app_id>:<D>` 去重），紧跟 payout-recon。
    { name: 'ledger-check', ...DEFAULT, policy: 'exclusive', deadLetter: 'ledger-check.dead' },
    // B2-05n（BR-WDR-26 超时判定，D10-475 ②）：worker 的审核超时检查队列，exclusive（按 5 分钟时间槽键 `review-overdue:<槽>` 去重），紧跟 ledger-check。
    {
      name: 'payout-overdue',
      ...DEFAULT,
      policy: 'exclusive',
      deadLetter: 'payout-overdue.dead',
    },
    // B2-07e（D10-428 / D10-415 ①）：payout 进程追加 W11 尝试记录的队列，exclusive（按 (提现单, 差错单) 键去重），紧跟 payout-recon。
    {
      name: 'payout-attempt-append',
      ...DEFAULT,
      policy: 'exclusive',
      deadLetter: 'payout-attempt-append.dead',
    },
    { name: 'notify', ...DEFAULT, deadLetter: 'notify.dead' },
    {
      name: 'evt.notification-risk-state',
      ...DEFAULT,
      deadLetter: 'evt.notification-risk-state.dead',
    },
    {
      name: 'evt.notification-appeal-result',
      ...DEFAULT,
      deadLetter: 'evt.notification-appeal-result.dead',
    },
    {
      name: 'evt.notification-claim-result',
      ...DEFAULT,
      deadLetter: 'evt.notification-claim-result.dead',
    },
    // B1-12u（BR-TEXT-09、BR-WDR-26）：notification 的 wallet.withdrawal_changed 消费者队列，目录默认值，
    // 紧跟 evt.notification-claim-result。
    {
      name: 'evt.notification-withdrawal-result',
      ...DEFAULT,
      deadLetter: 'evt.notification-withdrawal-result.dead',
    },
    // B1-12zc（BR-TEXT-09，D10-773 ①）：notification 的 order.clawed_back / order.settle_adjusted
    // 消费者队列，目录默认值，紧跟 evt.notification-withdrawal-result。
    {
      name: 'evt.notification-clawback',
      ...DEFAULT,
      deadLetter: 'evt.notification-clawback.dead',
    },
    // B1-03z（BR-FUND-22、BR-CALC-13 细则「申诉恢复」）：risk 的 appeal.resolved 消费者队列，目录默认值，
    // 紧跟 evt.notification-claim-result。
    {
      name: 'evt.risk-appeal-restore',
      ...DEFAULT,
      deadLetter: 'evt.risk-appeal-restore.dead',
    },
    // B2-11c（BR-WDR-30）：payout 的 withdrawal.created 消费者队列，目录默认值，紧跟
    // evt.notification-claim-result、在 evt.payout-went-negative 之前（不插在 evt.payout-went-negative
    // 与 pay 之间，以免与上面 B2-15b 对 pay 两侧的断言矛盾）。
    {
      name: 'evt.payout-auto-payout',
      ...DEFAULT,
      deadLetter: 'evt.payout-auto-payout.dead',
    },
    ...(hasPayoutWentNegative
      ? [
          {
            name: 'evt.payout-went-negative',
            ...DEFAULT,
            deadLetter: 'evt.payout-went-negative.dead',
          },
        ]
      : []),
    { name: 'pool-refresh', ...DEFAULT, deadLetter: 'pool-refresh.dead' },
    { name: 'poster', ...DEFAULT, deadLetter: 'poster.dead' },
    { name: 'agent-trace', ...DEFAULT, deadLetter: 'agent-trace.dead' },
    {
      name: 'order-sync.dead',
      policy: 'standard',
      retryLimit: 0,
      retryDelaySeconds: 1,
      retryBackoff: false,
      retryDelayMaxSeconds: null,
      expireInSeconds: 900,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
      deadLetter: null,
    },
  ]);
});

it('[规划/02 §3.1 转账队列 concurrency=1; ADR-0001 §3 海报轮询 0.5 秒] 生产入口计划逐项确切：api / stream / admin 不执行任务，worker 六个队列，payout 为 payout 并发 1 与 payout-attempt-append 并发 1（B2-07e D10-428 / D10-415 ①）', () => {
  const w = (queue: string, concurrency: number, pollingIntervalSeconds = 2) => ({
    queue,
    concurrency,
    pollingIntervalSeconds,
  });
  // B1-03s: risk-scan (B1-03j), when planned, is worker-only with concurrency 1, after agent-trace.
  const scans = ENTRY_PLAN.worker.filter((work) => work.queue === 'risk-scan');
  if (scans.length > 0) {
    expect(scans).toStrictEqual([w('risk-scan', 1)]);
    expect(ENTRY_PLAN.worker.at(-1)).toStrictEqual(w('risk-scan', 1));
  }
  // B1-08g: order-sync, when planned, is worker-only with concurrency 1, first in the worker list.
  const syncs = ENTRY_PLAN.worker.filter((work) => work.queue === 'order-sync');
  if (syncs.length > 0) {
    expect(syncs).toStrictEqual([w('order-sync', 1)]);
    expect(ENTRY_PLAN.worker[0]).toStrictEqual(w('order-sync', 1));
  }
  // B1-34c: export, when planned, is worker-only with concurrency 1, right after agent-trace and
  // right before risk-scan (risk-scan stays last); no other entry consumes it.
  const exports = ENTRY_PLAN.worker.filter((work) => work.queue === 'export');
  if (exports.length > 0) {
    expect(exports).toStrictEqual([w('export', 1)]);
    const at = ENTRY_PLAN.worker.findIndex((work) => work.queue === 'export');
    expect(ENTRY_PLAN.worker[at - 1]).toStrictEqual(w('agent-trace', 2));
    expect(ENTRY_PLAN.worker[at + 1]).toStrictEqual(w('risk-scan', 1));
  }
  expect(
    (['api', 'stream', 'admin', 'payout'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === 'export').map(() => entry),
    ),
  ).toStrictEqual([]);
  // F1-09q：page-schedule（页面定时发布）有则钉死，F1-09p 合并后收紧。When planned, it is worker-only
  // with concurrency 1 and the default polling, right after pool-refresh and right before poster.
  const pageSchedules = ENTRY_PLAN.worker.filter((work) => work.queue === 'page-schedule');
  if (pageSchedules.length > 0) {
    expect(pageSchedules).toStrictEqual([w('page-schedule', 1)]);
    const at = ENTRY_PLAN.worker.findIndex((work) => work.queue === 'page-schedule');
    expect(ENTRY_PLAN.worker[at - 1]).toStrictEqual(w('pool-refresh', 1));
    expect(ENTRY_PLAN.worker[at + 1]).toStrictEqual(w('poster', 2, 0.5));
  }
  expect(
    (['api', 'stream', 'admin', 'payout'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === 'page-schedule').map(() => entry),
    ),
  ).toStrictEqual([]);
  // B2-05h 两态过渡（D10-208）：B2-05e 合并后由收紧任务 B2-05j 改回单态。Without
  // evt.payout-went-negative the plan below is exactly the original one; with it, the worker runs it
  // with concurrency 1 right after evt.notification-appeal-result.
  const plansPayoutWentNegative = ENTRY_PLAN.worker.some(
    (work) => work.queue === 'evt.payout-went-negative',
  );
  // B1-22b: union-auth is worker-only, between notify and evt.notification-risk-state.
  const unionAuth = ENTRY_PLAN.worker.filter((work) => work.queue === 'union-auth');
  expect(unionAuth).toStrictEqual([w('union-auth', 1)]);
  const at = ENTRY_PLAN.worker.findIndex((work) => work.queue === 'union-auth');
  expect(ENTRY_PLAN.worker[at - 1]).toStrictEqual(w('notify', 5));
  expect(ENTRY_PLAN.worker[at + 1]).toStrictEqual(w('evt.notification-risk-state', 5));
  expect(
    (['api', 'stream', 'admin', 'payout'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === 'union-auth').map(() => entry),
    ),
  ).toStrictEqual([]);
  // B2-15b: pay, when planned, is worker-only with concurrency 4 and the default polling, exactly
  // one entry, right after evt.payout-went-negative and right before pool-refresh; api /
  // stream / admin / payout never consume it.
  const pays = ENTRY_PLAN.worker.filter((work) => work.queue === 'pay');
  expect(pays).toStrictEqual([w('pay', 4)]);
  const payAt = ENTRY_PLAN.worker.findIndex((work) => work.queue === 'pay');
  expect(ENTRY_PLAN.worker[payAt - 1]).toStrictEqual(w('evt.payout-went-negative', 1));
  expect(ENTRY_PLAN.worker[payAt + 1]).toStrictEqual(w('pool-refresh', 1));
  expect(
    (['api', 'stream', 'admin', 'payout'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === 'pay').map(() => entry),
    ),
  ).toStrictEqual([]);
  // B2-06fz（D10-326 取 C；D10-376）：payout-landing 只由 worker 消费（couli_app 落库），并发 1，
  // 紧跟 settle（不插在 evt.payout-went-negative 与 pool-refresh 之间，以免与上面 B2-15b 对 pay
  // 两侧的断言矛盾）；payout 入口不消费它。
  expect({
    ...ENTRY_PLAN,
    worker: ENTRY_PLAN.worker.filter(
      (work) =>
        work.queue !== 'risk-scan' &&
        work.queue !== 'order-sync' &&
        work.queue !== 'export' &&
        work.queue !== 'union-auth' &&
        work.queue !== 'pay' &&
        work.queue !== 'page-schedule' &&
        // B1-27h（个人信息副本作业，BR-ID-40）的队列，属性由 test/spec/identity/data-copies-worker 钉住。
        work.queue !== 'data-copy',
    ),
  }).toStrictEqual({
    api: [],
    stream: [],
    admin: [],
    worker: [
      w('order-rescan', 1),
      w('settle', 1),
      w('payout-landing', 1),
      w('payout-review', 1),
      // B2-07c（D10-408）：R2 日对账只由 worker（couli_app）消费，并发 1，紧跟 payout-review。
      w('payout-recon', 1),
      // B2-02q（D10-415 ①）：ledger 日终校验只由 worker（couli_app）消费，并发 1，紧跟 payout-recon。
      w('ledger-check', 1),
      // B2-05n（BR-WDR-26，D10-475 ②）：审核超时检查只由 worker（couli_app）消费，并发 1，紧跟 ledger-check。
      w('payout-overdue', 1),
      w('notify', 5),
      w('evt.notification-risk-state', 5),
      w('evt.notification-appeal-result', 5),
      w('evt.notification-claim-result', 5),
      // B1-12u：提现结果通知只由 worker 消费，并发 5，紧跟 evt.notification-claim-result。
      w('evt.notification-withdrawal-result', 5),
      // B1-12zc：扣回与结算负差调减通知只由 worker 消费，并发 5，紧跟 evt.notification-withdrawal-result。
      w('evt.notification-clawback', 5),
      // B1-03z：申诉恢复差错单只由 worker 消费，并发 1，紧跟 evt.notification-claim-result。
      w('evt.risk-appeal-restore', 1),
      // B2-11c（BR-WDR-30）：自动到账判定只由 worker 消费，并发 1，紧跟 evt.notification-claim-result
      // （同目录位置；不插在 evt.payout-went-negative 与 pay 之间）。
      w('evt.payout-auto-payout', 1),
      ...(plansPayoutWentNegative ? [w('evt.payout-went-negative', 1)] : []),
      w('pool-refresh', 1),
      w('poster', 2, 0.5),
      w('agent-trace', 2),
    ],
    // B2-07e（D10-428）：W11 尝试记录只由 payout 进程（couli_payout）追加，并发 1，紧跟 payout。
    payout: [w('payout', 1), w('payout-attempt-append', 1)],
  });
});

it('[规划/02 §3.1; ADR-0001 §2 进程入口] 生产计划下每个入口只能为自己计划里的队列注册处理器：其余目录队列一律 not_in_entry', async () => {
  // B2-06fz: payout-landing is the worker's (couli_app lands W5 / W6), never the payout entry's;
  // in the worker plan it sits right after settle (D10-376).
  const names = [
    'order-rescan',
    'settle',
    'payout',
    'payout-landing',
    'payout-review',
    // B2-07c (D10-408): the worker's R2 reconciliation, never the payout entry's.
    'payout-recon',
    // B2-02q (D10-415 ①): the worker's daily ledger check, never another entry's.
    'ledger-check',
    // B2-05n (D10-475 ②): the worker's review overdue check, never another entry's.
    'payout-overdue',
    // B2-07e (D10-428): the payout process's W11 attempt records, never the worker's.
    'payout-attempt-append',
    'notify',
    'pool-refresh',
    'poster',
    'agent-trace',
    'order-sync.dead',
  ];
  const seen: Record<string, Record<string, string>> = {};
  for (const entry of ENTRIES) {
    const { runtime, handles, reason } = runtimeFor(entry, `plan.${entry}`, {});
    seen[entry] = {};
    for (const name of names) {
      seen[entry][name] =
        runtime === null ? reason : thrown(() => runtime.register(name, async () => undefined));
    }
    await handles.close();
  }
  const row = (allowed: string[]) =>
    Object.fromEntries(
      names.map((name) => [name, allowed.includes(name) ? 'returned' : 'QueueError not_in_entry']),
    );
  expect(seen).toEqual({
    api: row([]),
    stream: row([]),
    admin: row([]),
    worker: row([
      'order-rescan',
      'settle',
      'payout-landing',
      'payout-review',
      'payout-recon',
      'ledger-check',
      'payout-overdue',
      'notify',
      'pool-refresh',
      'poster',
      'agent-trace',
    ]),
    payout: row(['payout', 'payout-attempt-append']),
  });
});

/** Variants of the test catalog / plan, each breaking one rule of sections 1 and 2. */
function badCatalogs(): Array<[string, unknown, unknown]> {
  const base = TEST_CATALOG;
  const swap = (name: string, overrides: Record<string, unknown>) =>
    base.map((item) => (item.name === name ? { ...item, ...overrides } : item));
  const plan = (entry: Entry, items: unknown[]) => ({ ...TEST_PLAN, [entry]: items });
  const item = (queue: string, concurrency = 1, pollingIntervalSeconds = 0.5) => ({
    queue,
    concurrency,
    pollingIntervalSeconds,
  });
  const cases: Array<[string, unknown, unknown]> = [
    ['catalog not an array', { 0: base[0] }, TEST_PLAN],
    ['duplicate name', [...base, spec('t-std')], TEST_PLAN],
    ['upper-case name', [...base, spec('T-up')], TEST_PLAN],
    ['name starting with a digit', [...base, spec('1q')], TEST_PLAN],
    ['name with a slash', [...base, spec('a/b')], TEST_PLAN],
    ['name with an underscore', [...base, spec('a_b')], TEST_PLAN],
    ['empty segment', [...base, spec('a..b')], TEST_PLAN],
    ['trailing dot', [...base, spec('a.')], TEST_PLAN],
    ['51 characters', [...base, spec(`q${'x'.repeat(50)}`)], TEST_PLAN],
    ['policy short', swap('t-std', { policy: 'short' }), TEST_PLAN],
    ['policy singleton', swap('t-std', { policy: 'singleton' }), TEST_PLAN],
    ['policy stately', swap('t-std', { policy: 'stately' }), TEST_PLAN],
    ['policy key_strict_fifo', swap('t-std', { policy: 'key_strict_fifo' }), TEST_PLAN],
    ['retryLimit -1', swap('t-std', { retryLimit: -1 }), TEST_PLAN],
    ['retryLimit 21', swap('t-std', { retryLimit: 21 }), TEST_PLAN],
    ['retryLimit 1.5', swap('t-std', { retryLimit: 1.5 }), TEST_PLAN],
    ['retryLimit "2"', swap('t-std', { retryLimit: '2' }), TEST_PLAN],
    ['retryDelaySeconds 0', swap('t-std', { retryDelaySeconds: 0 }), TEST_PLAN],
    ['retryDelaySeconds 3601', swap('t-std', { retryDelaySeconds: 3601 }), TEST_PLAN],
    ['retryDelaySeconds NaN', swap('t-std', { retryDelaySeconds: Number.NaN }), TEST_PLAN],
    ['retryBackoff "true"', swap('t-std', { retryBackoff: 'true' }), TEST_PLAN],
    ['retryDelayMax without backoff', swap('t-std', { retryDelayMaxSeconds: 10 }), TEST_PLAN],
    [
      'retryDelayMax below retryDelay',
      swap('t-std', { retryBackoff: true, retryDelaySeconds: 10, retryDelayMaxSeconds: 9 }),
      TEST_PLAN,
    ],
    [
      'retryDelayMax 86401',
      swap('t-std', { retryBackoff: true, retryDelayMaxSeconds: 86_401 }),
      TEST_PLAN,
    ],
    ['expireInSeconds 0', swap('t-std', { expireInSeconds: 0 }), TEST_PLAN],
    ['expireInSeconds 86401', swap('t-std', { expireInSeconds: 86_401 }), TEST_PLAN],
    ['retentionSeconds 59', swap('t-std', { retentionSeconds: 59 }), TEST_PLAN],
    ['retentionSeconds 2592001', swap('t-std', { retentionSeconds: 2_592_001 }), TEST_PLAN],
    ['deleteAfterSeconds 59', swap('t-std', { deleteAfterSeconds: 59 }), TEST_PLAN],
    ['deleteAfterSeconds 0', swap('t-std', { deleteAfterSeconds: 0 }), TEST_PLAN],
    ['deleteAfterSeconds 2592001', swap('t-std', { deleteAfterSeconds: 2_592_001 }), TEST_PLAN],
    ['dead letter not in catalog', swap('t-std', { deadLetter: 'nowhere' }), TEST_PLAN],
    ['dead letter is itself', swap('t-std', { deadLetter: 't-std' }), TEST_PLAN],
    ['dead letter is exclusive', swap('t-std', { deadLetter: 't-excl' }), TEST_PLAN],
    ['dead letter has a dead letter', swap('t-std', { deadLetter: 't-wide' }), TEST_PLAN],
    ['extra key', swap('t-std', { partition: false }), TEST_PLAN],
    [
      'missing key',
      base.map((entry) => {
        if (entry.name !== 't-std') return entry;
        const rest: Record<string, unknown> = { ...entry };
        delete rest.deadLetter;
        return rest;
      }),
      TEST_PLAN,
    ],
    ['spec not a plain object', [...base, new Map()], TEST_PLAN],
    ['plan missing an entry', base, { api: [], stream: [], admin: [], worker: [] }],
    ['plan with an extra entry', base, { ...TEST_PLAN, relay: [] }],
    ['plan queue not in catalog', base, plan('worker', [item('nowhere')])],
    ['plan works a dead letter queue', base, plan('worker', [item('test-dead')])],
    ['plan queue twice in one entry', base, plan('worker', [item('t-std'), item('t-std')])],
    ['plan queue in two entries', base, plan('payout', [item('t-pay'), item('t-std')])],
    ['concurrency 0', base, plan('worker', [item('t-std', 0)])],
    ['concurrency 11', base, plan('worker', [item('t-std', 11)])],
    ['concurrency 1.5', base, plan('worker', [item('t-std', 1.5)])],
    ['polling 0.4', base, plan('worker', [item('t-std', 1, 0.4)])],
    ['polling 0.75', base, plan('worker', [item('t-std', 1, 0.75)])],
    ['polling 60.5', base, plan('worker', [item('t-std', 1, 60.5)])],
    ['polling NaN', base, plan('worker', [item('t-std', 1, Number.NaN)])],
    ['plan item with an extra key', base, plan('worker', [{ ...item('t-std'), batchSize: 2 }])],
    ['plan item not an object', base, plan('worker', ['t-std'])],
  ];
  return cases;
}

it('[规划/02 §11 各自设置并发; contract §1–2 上下界] 目录或入口计划违反任一条规则时 createQueueRuntime 同步抛 invalid_catalog（固定文案、无 cause），且先于其他选项检查', async () => {
  const handles = handlesFor('worker', 'catalog');
  const { logger } = memoryLogger('worker');
  const seen: Record<string, string> = {};
  for (const [label, catalog, plan] of badCatalogs()) {
    seen[label] = thrown(() =>
      createQueueRuntime({ entry: 'worker', db: handles.db, logger, catalog, plan } as never),
    );
  }
  const shape = thrownProblems(
    () =>
      createQueueRuntime({
        entry: 'relay',
        db: handles.db,
        logger,
        catalog: [...TEST_CATALOG, spec('t-std')],
        plan: TEST_PLAN,
        stopTimeoutMs: 0,
      } as never),
    'invalid_catalog',
  );
  await handles.close();
  expect(seen).toEqual(
    Object.fromEntries(badCatalogs().map(([label]) => [label, 'QueueError invalid_catalog'])),
  );
  expect(shape).toEqual([]);
});

it('[contract §1–2 上下界] 处在上下界上的目录与计划被接受：重试 0 与 20 次、延迟 1 与 3600 秒、退避上限等于延迟与 86400、过期 1 与 86400、保留 60 与 2592000、并发 1 与 10、轮询 0.5 与 60、50 字符队列名', async () => {
  const handles = handlesFor('worker', 'bounds');
  const { logger } = memoryLogger('worker');
  const long = `q${'x'.repeat(49)}`;
  const catalog: QueueSpec[] = [
    spec('b-low', {
      retryLimit: 0,
      retryDelaySeconds: 1,
      expireInSeconds: 1,
      retentionSeconds: 60,
      deleteAfterSeconds: 60,
    }),
    spec('b-high', {
      retryLimit: 20,
      retryDelaySeconds: 3600,
      retryBackoff: true,
      retryDelayMaxSeconds: 3600,
      expireInSeconds: 86_400,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
    }),
    spec('b-max', { retryBackoff: true, retryDelayMaxSeconds: 86_400 }),
    spec('b-nomax', { retryBackoff: true, retryDelayMaxSeconds: null }),
    spec('b.dotted-name.x1'),
    spec(long, { policy: 'exclusive' }),
    TEST_CATALOG[TEST_CATALOG.length - 1] as QueueSpec,
  ];
  const plan: EntryPlan = {
    api: [],
    stream: [],
    admin: [],
    worker: [
      { queue: 'b-low', concurrency: 1, pollingIntervalSeconds: 0.5 },
      { queue: 'b-high', concurrency: 10, pollingIntervalSeconds: 60 },
      { queue: long, concurrency: 3, pollingIntervalSeconds: 1.5 },
    ],
    payout: [{ queue: 'b-max', concurrency: 1, pollingIntervalSeconds: 2 }],
  };
  const seen = [
    thrown(() => createQueueRuntime({ entry: 'worker', db: handles.db, logger, catalog, plan })),
    thrown(() =>
      createQueueRuntime({
        entry: 'payout',
        db: handles.db,
        logger,
        catalog,
        plan,
        stopTimeoutMs: 1,
      }),
    ),
    thrown(() =>
      createQueueRuntime({
        entry: 'api',
        db: handles.db,
        logger,
        catalog,
        plan,
        stopTimeoutMs: 60_000,
      }),
    ),
  ];
  await handles.close();
  expect(seen).toEqual(['returned', 'returned', 'returned']);
});

it('[contract §9] createQueueRuntime 的其他选项错误一律同步抛 invalid_option：未知键、入口不是五个之一、stopTimeoutMs 不是 1..60000 的整数', async () => {
  const handles = handlesFor('worker', 'options');
  const { logger } = memoryLogger('worker');
  const base = { entry: 'worker', db: handles.db, logger, catalog: TEST_CATALOG, plan: TEST_PLAN };
  const variants: Record<string, unknown> = {
    'unknown key': { ...base, migrate: true },
    'entry relay': { ...base, entry: 'relay' },
    'entry missing': { db: handles.db, logger, catalog: TEST_CATALOG, plan: TEST_PLAN },
    'stopTimeoutMs 0': { ...base, stopTimeoutMs: 0 },
    'stopTimeoutMs 60001': { ...base, stopTimeoutMs: 60_001 },
    'stopTimeoutMs 1.5': { ...base, stopTimeoutMs: 1.5 },
    'stopTimeoutMs NaN': { ...base, stopTimeoutMs: Number.NaN },
    'stopTimeoutMs Infinity': { ...base, stopTimeoutMs: Number.POSITIVE_INFINITY },
    'stopTimeoutMs "5000"': { ...base, stopTimeoutMs: '5000' },
  };
  const seen: Record<string, string> = {};
  for (const [label, options] of Object.entries(variants)) {
    seen[label] = thrown(() => createQueueRuntime(options as never));
  }
  const shape = thrownProblems(
    () => createQueueRuntime({ ...base, stopTimeoutMs: 0 } as never),
    'invalid_option',
  );
  await handles.close();
  expect(seen).toEqual(
    Object.fromEntries(Object.keys(variants).map((label) => [label, 'QueueError invalid_option'])),
  );
  expect(shape).toEqual([]);
});

/** A transaction-like object as Kysely's Transaction reports itself (`isTransaction`). */
const FAKE_TRX = { isTransaction: true } as unknown as SendOptions['trx'];

function sendCases(handles: DbHandles): Array<[string, unknown[], string]> {
  const ok = { trx: null };
  const okKey = { trx: null, singletonKey: 'w:1' };
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  const withProp = Object.assign([1], { extra: 1 });
  const accessor = Object.defineProperty({}, 'a', { get: () => 1, enumerable: true });
  const hidden = Object.defineProperty({}, 'a', { value: 1, enumerable: false });
  const symbolKey = { [Symbol('s')]: 1 };
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let deep: Record<string, unknown> = {};
  const deepRoot = deep;
  for (let level = 1; level < 33; level += 1) {
    const next: Record<string, unknown> = {};
    deep.n = next;
    deep = next;
  }
  // deepRoot has 33 levels of objects (deepRoot is level 1).
  let fine: Record<string, unknown> = {};
  const fineRoot = fine;
  for (let level = 1; level < 32; level += 1) {
    const next: Record<string, unknown> = {};
    fine.n = next;
    fine = next;
  }
  class Box {
    a = 1;
  }
  return [
    ['unknown queue', ['nowhere', 'a.b', {}, ok], 'QueueError unknown_queue'],
    ['dead letter queue is a catalog queue', ['test-dead', 'a', {}, ok], 'QueueError not_running'],
    ['queue not a string', [1, 'a', {}, ok], 'QueueError unknown_queue'],
    ['unknown queue before a bad name', ['nowhere', 'BAD', null, null], 'QueueError unknown_queue'],
    ['name upper case', ['t-std', 'Order.created', {}, ok], 'QueueError invalid_name'],
    ['name with a hyphen', ['t-std', 'order-created', {}, ok], 'QueueError invalid_name'],
    ['name empty segment', ['t-std', 'order..created', {}, ok], 'QueueError invalid_name'],
    ['name starting with a digit', ['t-std', '1order', {}, ok], 'QueueError invalid_name'],
    ['name empty', ['t-std', '', {}, ok], 'QueueError invalid_name'],
    ['name 65 characters', ['t-std', `a${'b'.repeat(64)}`, {}, ok], 'QueueError invalid_name'],
    ['name 64 characters', ['t-std', `a${'b'.repeat(63)}`, {}, ok], 'QueueError not_running'],
    ['name not a string', ['t-std', 7, {}, ok], 'QueueError invalid_name'],
    ['bad name before a bad payload', ['t-std', 'A', null, null], 'QueueError invalid_name'],
    ['payload null', ['t-std', 'a', null, ok], 'QueueError invalid_payload'],
    ['payload array', ['t-std', 'a', [1], ok], 'QueueError invalid_payload'],
    ['payload string', ['t-std', 'a', 'x', ok], 'QueueError invalid_payload'],
    ['payload Date', ['t-std', 'a', new Date(0), ok], 'QueueError invalid_payload'],
    ['payload Map', ['t-std', 'a', new Map(), ok], 'QueueError invalid_payload'],
    ['payload class instance', ['t-std', 'a', new Box(), ok], 'QueueError invalid_payload'],
    ['bigint value', ['t-std', 'a', { amount_fen: 1n }, ok], 'QueueError invalid_payload'],
    ['fraction', ['t-std', 'a', { rate: 0.5 }, ok], 'QueueError invalid_payload'],
    ['unsafe integer', ['t-std', 'a', { n: 2 ** 53 }, ok], 'QueueError invalid_payload'],
    ['NaN', ['t-std', 'a', { n: Number.NaN }, ok], 'QueueError invalid_payload'],
    ['Infinity', ['t-std', 'a', { n: Number.NEGATIVE_INFINITY }, ok], 'QueueError invalid_payload'],
    ['undefined value', ['t-std', 'a', { u: undefined }, ok], 'QueueError invalid_payload'],
    ['function value', ['t-std', 'a', { f: () => 1 }, ok], 'QueueError invalid_payload'],
    ['symbol value', ['t-std', 'a', { s: Symbol('s') }, ok], 'QueueError invalid_payload'],
    ['nested Date', ['t-std', 'a', { at: [new Date(0)] }, ok], 'QueueError invalid_payload'],
    [
      'boxed string',
      ['t-std', 'a', { s: Object('x') as unknown }, ok],
      'QueueError invalid_payload',
    ],
    ['typed array', ['t-std', 'a', { b: new Uint8Array(2) }, ok], 'QueueError invalid_payload'],
    ['sparse array', ['t-std', 'a', { list: sparse }, ok], 'QueueError invalid_payload'],
    ['array with a property', ['t-std', 'a', { list: withProp }, ok], 'QueueError invalid_payload'],
    ['accessor property', ['t-std', 'a', accessor, ok], 'QueueError invalid_payload'],
    ['non-enumerable property', ['t-std', 'a', hidden, ok], 'QueueError invalid_payload'],
    ['symbol key', ['t-std', 'a', symbolKey, ok], 'QueueError invalid_payload'],
    ['lone surrogate', ['t-std', 'a', { s: 'a\uD800b' }, ok], 'QueueError invalid_payload'],
    ['lone surrogate key', ['t-std', 'a', { ['\uDC00']: 1 }, ok], 'QueueError invalid_payload'],
    ['NUL character', ['t-std', 'a', { s: 'a\u0000b' }, ok], 'QueueError invalid_payload'],
    ['NUL in a key', ['t-std', 'a', { ['k\u0000']: 1 }, ok], 'QueueError invalid_payload'],
    ['cycle', ['t-std', 'a', cyclic, ok], 'QueueError invalid_payload'],
    ['33 levels', ['t-std', 'a', deepRoot, ok], 'QueueError invalid_payload'],
    ['32 levels', ['t-std', 'a', fineRoot, ok], 'QueueError not_running'],
    [
      'null prototype and nested JSON',
      [
        't-std',
        'order.created',
        Object.assign(Object.create(null) as object, {
          id: 'x',
          n: -(2 ** 53 - 1),
          ok: false,
          none: null,
          list: [1, 'two', [true], { k: '\u{1F600}' }],
        }),
        ok,
      ],
      'QueueError not_running',
    ],
    ['bad payload before bad options', ['t-std', 'a', null, null], 'QueueError invalid_payload'],
    ['options null', ['t-std', 'a', {}, null], 'QueueError invalid_option'],
    ['options without trx', ['t-std', 'a', {}, {}], 'QueueError invalid_option'],
    ['trx undefined', ['t-std', 'a', {}, { trx: undefined }], 'QueueError invalid_option'],
    ['trx is the db handle', ['t-std', 'a', {}, { trx: handles.db }], 'QueueError invalid_option'],
    ['trx a plain object', ['t-std', 'a', {}, { trx: {} }], 'QueueError invalid_option'],
    ['trx a transaction-like', ['t-std', 'a', {}, { trx: FAKE_TRX }], 'QueueError not_running'],
    ['unknown option', ['t-std', 'a', {}, { trx: null, priority: 1 }], 'QueueError invalid_option'],
    [
      'singletonSeconds',
      ['t-std', 'a', {}, { trx: null, singletonSeconds: 60 }],
      'QueueError invalid_option',
    ],
    [
      'upper-case id',
      ['t-std', 'a', {}, { trx: null, id: '0190A6A0-0000-7000-8000-000000000001' }],
      'QueueError invalid_option',
    ],
    ['id not a uuid', ['t-std', 'a', {}, { trx: null, id: 'evt-1' }], 'QueueError invalid_option'],
    [
      'id braces',
      ['t-std', 'a', {}, { trx: null, id: '{0190a6a0-0000-7000-8000-000000000001}' }],
      'QueueError invalid_option',
    ],
    [
      'lower-case id',
      ['t-std', 'a', {}, { trx: null, id: '0190a6a0-0000-7000-8000-000000000001' }],
      'QueueError not_running',
    ],
    [
      'key on a standard queue',
      ['t-std', 'a', {}, { trx: null, singletonKey: 'k' }],
      'QueueError invalid_option',
    ],
    ['no key on an exclusive queue', ['t-excl', 'a', {}, ok], 'QueueError invalid_option'],
    [
      'empty key',
      ['t-excl', 'a', {}, { trx: null, singletonKey: '' }],
      'QueueError invalid_option',
    ],
    [
      'key with a space',
      ['t-excl', 'a', {}, { trx: null, singletonKey: 'w 1' }],
      'QueueError invalid_option',
    ],
    [
      'key with a slash',
      ['t-excl', 'a', {}, { trx: null, singletonKey: 'w/1' }],
      'QueueError invalid_option',
    ],
    [
      'key 201 characters',
      ['t-excl', 'a', {}, { trx: null, singletonKey: 'k'.repeat(201) }],
      'QueueError invalid_option',
    ],
    [
      'key 200 characters',
      ['t-excl', 'a', {}, { trx: null, singletonKey: 'k'.repeat(200) }],
      'QueueError not_running',
    ],
    [
      'key of every allowed character',
      ['t-excl', 'a', {}, { trx: null, singletonKey: 'AZaz09:._+-' }],
      'QueueError not_running',
    ],
    [
      'key of a withdrawal step',
      [
        't-excl',
        'payout.execute',
        {},
        { trx: null, singletonKey: '0190a6a0-0000-7000-8000-000000000001:2' },
      ],
      'QueueError not_running',
    ],
    [
      'key not a string',
      ['t-excl', 'a', {}, { trx: null, singletonKey: 1 }],
      'QueueError invalid_option',
    ],
    ['delay -1', ['t-std', 'a', {}, { trx: null, delaySeconds: -1 }], 'QueueError invalid_option'],
    [
      'delay 1.5',
      ['t-std', 'a', {}, { trx: null, delaySeconds: 1.5 }],
      'QueueError invalid_option',
    ],
    [
      'delay 2592001',
      ['t-std', 'a', {}, { trx: null, delaySeconds: 2_592_001 }],
      'QueueError invalid_option',
    ],
    [
      'delay "1"',
      ['t-std', 'a', {}, { trx: null, delaySeconds: '1' }],
      'QueueError invalid_option',
    ],
    ['delay 0', ['t-std', 'a', {}, { trx: null, delaySeconds: 0 }], 'QueueError not_running'],
    [
      'delay 2592000',
      ['t-std', 'a', {}, { trx: null, delaySeconds: 2_592_000 }],
      'QueueError not_running',
    ],
    [
      'every option',
      [
        't-excl',
        'a',
        {},
        { ...okKey, id: '0190a6a0-0000-7000-8000-000000000002', delaySeconds: 5, trx: FAKE_TRX },
      ],
      'QueueError not_running',
    ],
  ];
}

it('[规划/02 §11; ADR-0001 §4.2 #14、#19] send 的检查顺序与每条规则确切：队列 → 任务名 → 负载 → 大小 → 选项 → 运行状态；被拒的 send 不碰任何连接', async () => {
  const sockets = watchSocketConnects();
  try {
    const { runtime, handles, reason } = runtimeFor('worker', 'send');
    const cases = sendCases(handles);
    const seen: Record<string, string> = {};
    for (const [label, args] of cases) {
      seen[label] =
        runtime === null
          ? reason
          : await settled((runtime.send as (...rest: unknown[]) => Promise<unknown>)(...args));
    }
    await handles.close();
    expect(seen).toEqual(Object.fromEntries(cases.map(([label, , want]) => [label, want])));
    expect(sockets.count()).toBe(0);
  } finally {
    sockets.restore();
  }
});

it('[contract §3d] 负载大小按 JSON.stringify 的 UTF-8 字节计：16384 字节放行（到运行状态检查），16385 字节 payload_too_large；多字节字符按字节计', async () => {
  const { runtime, handles, reason } = runtimeFor('api', 'size');
  // {"s":"…"} is 8 bytes plus the string.
  const ascii = (bytes: number): JobPayload => ({ s: 'a'.repeat(bytes - 8) });
  // '中' is 3 UTF-8 bytes; pad with ASCII to the exact size.
  const wide = (bytes: number): JobPayload => {
    const chars = Math.floor((bytes - 8) / 3);
    return { s: '中'.repeat(chars) + 'a'.repeat(bytes - 8 - chars * 3) };
  };
  const seen: Record<string, string> = {};
  const sizes: Record<string, JobPayload> = {
    'ascii 16384': ascii(16_384),
    'ascii 16385': ascii(16_385),
    'wide 16384': wide(16_384),
    'wide 16385': wide(16_385),
  };
  for (const [label, payload] of Object.entries(sizes)) {
    seen[label] =
      runtime === null ? reason : await settled(runtime.send('t-std', 'a', payload, { trx: null }));
  }
  const shape =
    runtime === null
      ? [reason]
      : await rejectionProblems(
          runtime.send('t-std', 'a', ascii(16_385), { trx: null }),
          'payload_too_large',
        );
  await handles.close();
  expect(
    Object.values(sizes).map((payload) => Buffer.byteLength(JSON.stringify(payload), 'utf8')),
  ).toEqual([16_384, 16_385, 16_384, 16_385]);
  expect(seen).toEqual({
    'ascii 16384': 'QueueError not_running',
    'ascii 16385': 'QueueError payload_too_large',
    'wide 16384': 'QueueError not_running',
    'wide 16385': 'QueueError payload_too_large',
  });
  expect(shape).toEqual([]);
});

it('[contract §5] register 的检查顺序：目录 → 本入口计划 → 处理器是函数 → 未重复 → 未启动；api 入口不能注册任何队列；错误是同步抛出的 QueueError', async () => {
  const worker = runtimeFor('worker', 'register.worker');
  const api = runtimeFor('api', 'register.api');
  const payout = runtimeFor('payout', 'register.payout');
  const noop = async () => undefined;
  const seen: Record<string, string> = {};
  const w = worker.runtime;
  if (w === null || api.runtime === null || payout.runtime === null) {
    seen.created = [worker.reason, api.reason, payout.reason].join(' | ');
  } else {
    seen['unknown queue'] = thrown(() => w.register('nowhere', noop));
    seen['unknown queue, bad handler'] = thrown(() => w.register('nowhere', 1 as never));
    seen['payout queue on worker'] = thrown(() => w.register('t-pay', noop));
    seen['dead letter queue'] = thrown(() => w.register('test-dead', noop));
    seen['not in entry, bad handler'] = thrown(() => w.register('t-pay', 1 as never));
    seen['handler not a function'] = thrown(() => w.register('t-std', 'run' as never));
    seen['first'] = thrown(() => w.register('t-std', noop));
    seen['second'] = thrown(() => w.register('t-std', noop));
    seen['second, bad handler'] = thrown(() => w.register('t-std', null as never));
    seen['other queue'] = thrown(() => w.register('t-once', noop));
    seen['api'] = thrown(() => api.runtime?.register('t-std', noop));
    seen['payout own'] = thrown(() => payout.runtime?.register('t-pay', noop));
    seen['payout worker queue'] = thrown(() => payout.runtime?.register('t-std', noop));
    seen.shape = thrownProblems(() => w.register('t-std', noop), 'duplicate_handler').join(',');
  }
  for (const item of [worker, api, payout]) await item.handles.close();
  expect(seen).toEqual({
    'unknown queue': 'QueueError unknown_queue',
    'unknown queue, bad handler': 'QueueError unknown_queue',
    'payout queue on worker': 'QueueError not_in_entry',
    'dead letter queue': 'QueueError not_in_entry',
    'not in entry, bad handler': 'QueueError not_in_entry',
    'handler not a function': 'QueueError invalid_option',
    first: 'returned',
    second: 'QueueError duplicate_handler',
    'second, bad handler': 'QueueError invalid_option',
    'other queue': 'returned',
    api: 'QueueError not_in_entry',
    'payout own': 'returned',
    'payout worker queue': 'QueueError not_in_entry',
    shape: '',
  });
});

it('[contract §6] 未启动就 stop：立即以 undefined 解决、可以再调；之后 start 拒绝 already_started，register 抛 already_started，合规的 send 拒绝 not_running；全程不连库', async () => {
  const sockets = watchSocketConnects();
  try {
    const { runtime, handles, reason } = runtimeFor('worker', 'stop.early');
    let seen: unknown = reason;
    if (runtime !== null) {
      const first = runtime.stop();
      const second = runtime.stop();
      const values = await Promise.all([first, second, runtime.stop()]);
      seen = {
        values,
        start: await rejectionProblems(runtime.start(), 'already_started'),
        register: thrown(() => runtime.register('t-std', async () => undefined)),
        send: await rejectionProblems(runtime.send('t-std', 'a', {}, { trx: null }), 'not_running'),
        stopAgain: await settled(runtime.stop()),
      };
    }
    await handles.close();
    expect(seen).toEqual({
      values: [undefined, undefined, undefined],
      start: [],
      register: 'QueueError already_started',
      send: [],
      stopAgain: 'resolved',
    });
    expect(sockets.count()).toBe(0);
  } finally {
    sockets.restore();
  }
});

/** Every .ts file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Runtime (non-type-only) imports of 'pg-boss' in `source`. */
function importsPgBoss(source: string): boolean {
  return (
    /^\s*import\s+(?!type\s)[^;]*?\sfrom\s+['"]pg-boss['"]/m.test(source) ||
    /\bimport\(\s*['"]pg-boss['"]\s*\)/.test(source) ||
    /^\s*import\s+['"]pg-boss['"]/m.test(source)
  );
}

it('[ADR-0001 §2 业务代码只依赖 JobQueue; 规划/02 §16.3 不要绕过 JobQueue] apps/api/src 里只有 platform/queue 目录导入 pg-boss（且确实用它实现），该目录的非测试源码不读时钟、不读 process.env、不用 console', () => {
  const files = tsFiles(API_SRC).filter((file) => !file.endsWith('.test.ts'));
  const importers = files
    .filter((file) => importsPgBoss(readFileSync(file, 'utf8')))
    .map((file) => path.relative(API_SRC, file));
  const queueFiles = tsFiles(QUEUE_DIR).filter((file) => !file.endsWith('.test.ts'));
  const forbidden =
    /\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bperformance\.now\s*\(|\bprocess\.env\b|\bconsole\./;
  const offenders = queueFiles
    .filter((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((text) => !/^\s*\/\//.test(text) && forbidden.test(text)),
    )
    .map((file) => path.relative(API_SRC, file));
  expect({
    outside: importers.filter((file) => !file.startsWith('modules/platform/queue/')),
    inside: importers.some((file) => file.startsWith('modules/platform/queue/')),
    offenders,
  }).toEqual({ outside: [], inside: true, offenders: [] });
});
