// 解冻信号进待处理表（任务书 9.2 第 2、4、5 条；08 BR-FUND-22 决-06 实测前 A、BR-FUND-02）：生产的待处理写入
// （application/punish-pending.ts 的 createPunishPendingRecorder）落 app.order_sync_pending，与映射表外的状态码
// 同一张表；同键 open 记录只有一条，靠 order_sync_pending_open_key 唯一索引（不靠先查后插）：重复拉取、任务重投、
// 两个窗口并发都只留一条 open、都不抛错；该条被处置（resolved / dismissed）后再出现新开一条。我方有这张订单时
// order_id 填它，没有时为 null（仍留证据）。去重键含原因：同一子订单的 UNFREEZE_SIGNAL 与 UNMAPPED_STATUS
// 各自一条 open。并发用两个各自独立创建的记录器（各自的连接池）加库内屏障（另一事务先占住同键）确定性地造出
// 「两边都以为没有」的时序。待处理写入失败即停、重投补上；detected_at 取注入时钟，不取窗口结束时刻。
// 用例全部是顶层 it。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createPunishPendingRecorder,
  type PunishPendingSignal,
} from '../../../../apps/api/src/modules/orders/application/punish-pending.ts';
import { handlePunishWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import {
  closePending,
  dbHandler,
  lateWindowOf,
  newAppId,
  open,
  orderNo,
  pendingOf,
  rightsOf,
  seedOrder,
  unfreezeRow,
  windowOf,
  type Harness,
  type Order,
  type PendingRow,
} from './db-kit.ts';
import { NOW, PUNISH_JOB, job } from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

/** The columns of a pending row the signal decides. */
function view(row: PendingRow) {
  return {
    app_id: row.app_id,
    platform: row.platform,
    sub_order_id: row.sub_order_id,
    order_id: row.order_id,
    reason: row.reason,
    raw_status: row.raw_status,
    status: row.status,
    detected_at: row.detected_at,
  };
}

it.each([
  ['UNFREEZE_SIGNAL', '1'],
  ['UNMAPPED_STATUS', '2'],
] as const)(
  '[AC-B1-04zzab#14] 待处理写入（%s）：一条 open 记录，平台、订单号、raw_status 原值、detected_at 取信号时刻；我方有这张订单时 order_id 填它',
  async (reason, raw) => {
    const appId = newAppId();
    const order = await seedOrder(h.db, appId);
    const recorder = createPunishPendingRecorder({ db: h.db });
    await recorder.record({
      app_id: appId,
      platform: 'taobao',
      sub_order_id: order.sub_order_id,
      reason,
      raw_status: raw,
      detected_at: new Date(NOW),
    });
    const rows = await pendingOf(h.db, appId);
    expect(rows.map(view)).toEqual([
      {
        app_id: appId,
        platform: 'taobao',
        sub_order_id: order.sub_order_id,
        order_id: order.order_id,
        reason,
        raw_status: raw,
        status: 'open',
        detected_at: new Date(NOW),
      },
    ]);
    expect(rows[0]).toMatchObject({ resolved_by: null, resolved_at: null });
    expect(await rightsOf(h.db, appId)).toEqual([]);
  },
);

it('[AC-B1-04zzab#15] 我方没有这张订单（别家推广位）：照样留一条 open 记录，order_id 为 null，不抛错', async () => {
  const appId = newAppId();
  const elsewhere = newAppId();
  const theirs = await seedOrder(h.db, elsewhere);
  const unknown = orderNo();
  const recorder = createPunishPendingRecorder({ db: h.db });
  for (const sub of [unknown, theirs.sub_order_id]) {
    await expect(
      recorder.record({
        app_id: appId,
        platform: 'taobao',
        sub_order_id: sub,
        reason: 'UNFREEZE_SIGNAL',
        raw_status: '1',
        detected_at: new Date(NOW),
      }),
    ).resolves.toBeUndefined();
  }
  const rows = await pendingOf(h.db, appId);
  expect(rows.map((r) => [r.sub_order_id, r.order_id, r.reason, r.status])).toEqual([
    [unknown, null, 'UNFREEZE_SIGNAL', 'open'],
    [theirs.sub_order_id, null, 'UNFREEZE_SIGNAL', 'open'],
  ]);
  expect(await pendingOf(h.db, elsewhere)).toEqual([]);
});

it('[AC-B1-04zzab#16] 同一解冻行反复拉取、任务重投：同键 open 只有一条，都不抛错，不交写入方', async () => {
  const appId = newAppId();
  const order = await seedOrder(h.db, appId);
  const row = unfreezeRow(order.sub_order_id);
  const f = dbHandler(h.db, [[row]]);
  await handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps);
  await handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps);
  await expect(
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId), 2), f.deps),
  ).resolves.toBeUndefined();

  const rows = await pendingOf(h.db, appId);
  expect(rows.map((r) => [r.sub_order_id, r.order_id, r.reason, r.raw_status, r.status])).toEqual([
    [order.sub_order_id, order.order_id, 'UNFREEZE_SIGNAL', '1', 'open'],
  ]);
  expect(f.rightsRecord).not.toHaveBeenCalled();
  expect(await rightsOf(h.db, appId)).toEqual([]);
});

it('[AC-B1-04zzab#17] 两个窗口并发处理同一解冻行：仍只有一条 open 记录，两个都不抛错', async () => {
  const appId = newAppId();
  const order = await seedOrder(h.db, appId);
  const row = unfreezeRow(order.sub_order_id);
  const a = dbHandler(h.db, [[row]]);
  const b = dbHandler(h.db, [[row]]);
  const results = await Promise.allSettled([
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), a.deps),
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId), 2), b.deps),
    createPunishPendingRecorder({ db: h.db }).record({
      app_id: appId,
      platform: 'taobao',
      sub_order_id: order.sub_order_id,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      detected_at: new Date(NOW),
    }),
  ]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  const opened = (await pendingOf(h.db, appId)).filter((r) => r.status === 'open');
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({
    sub_order_id: order.sub_order_id,
    order_id: order.order_id,
    reason: 'UNFREEZE_SIGNAL',
  });
  expect(a.rightsRecord).not.toHaveBeenCalled();
  expect(b.rightsRecord).not.toHaveBeenCalled();
});

it.each(['resolved', 'dismissed'] as const)(
  '[AC-B1-04zzab#18] open 记录被处置（%s）后解冻行再出现：新开一条 open，处置过的那条不动',
  async (handled) => {
    const appId = newAppId();
    const order = await seedOrder(h.db, appId);
    const row = unfreezeRow(order.sub_order_id);
    const f = dbHandler(h.db, [[row]]);
    await handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps);
    const first = await pendingOf(h.db, appId);
    expect(first).toHaveLength(1);
    await closePending(h.db, first[0]!.id, handled);
    const closed = (await pendingOf(h.db, appId))[0]!;

    await handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps);
    const rows = await pendingOf(h.db, appId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(closed);
    expect(view(rows[1]!)).toEqual({
      app_id: appId,
      platform: 'taobao',
      sub_order_id: order.sub_order_id,
      order_id: order.order_id,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      status: 'open',
      detected_at: new Date(NOW),
    });
    expect(f.rightsRecord).not.toHaveBeenCalled();
  },
);

/** A Taobao signal of `appId` detected at NOW. */
function signalFor(
  appId: string,
  subOrderId: string,
  reason: PunishPendingSignal['reason'],
  raw: string,
): PunishPendingSignal {
  return {
    app_id: appId,
    platform: 'taobao',
    sub_order_id: subOrderId,
    reason,
    raw_status: raw,
    detected_at: new Date(NOW),
  };
}

type Keyed = readonly [string, string, string | null, string, string | null];

const byKey = (a: Keyed, b: Keyed) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`);

/** [sub_order_id, reason, raw_status, status, order_id] of the rows, in a stable order. */
function keyed(rows: readonly PendingRow[]): Keyed[] {
  return rows
    .map((r): Keyed => [r.sub_order_id, r.reason, r.raw_status, r.status, r.order_id])
    .sort(byKey);
}

/** One open UNFREEZE_SIGNAL ('1') and one open UNMAPPED_STATUS ('2') of each order. */
function bothReasons(...orders: readonly Order[]): Keyed[] {
  return orders
    .flatMap((o): Keyed[] => [
      [o.sub_order_id, 'UNFREEZE_SIGNAL', '1', 'open', o.order_id],
      [o.sub_order_id, 'UNMAPPED_STATUS', '2', 'open', o.order_id],
    ])
    .sort(byKey);
}

it('[AC-B1-04zzab#26] 去重键含原因：同一 app、平台、子订单先表外值后解冻、先解冻后表外值，两种原因各留一条 open；同一原因重复仍只一条', async () => {
  const appId = newAppId();
  const x = await seedOrder(h.db, appId);
  const y = await seedOrder(h.db, appId);
  const recorder = createPunishPendingRecorder({ db: h.db });
  const sequence = [
    signalFor(appId, x.sub_order_id, 'UNMAPPED_STATUS', '2'),
    signalFor(appId, x.sub_order_id, 'UNFREEZE_SIGNAL', '1'),
    signalFor(appId, y.sub_order_id, 'UNFREEZE_SIGNAL', '1'),
    signalFor(appId, y.sub_order_id, 'UNMAPPED_STATUS', '2'),
  ];
  for (const signal of [...sequence, ...sequence]) {
    await expect(recorder.record(signal)).resolves.toBeUndefined();
  }

  const rows = await pendingOf(h.db, appId);
  expect(rows).toHaveLength(4);
  expect(keyed(rows)).toEqual(bothReasons(x, y));
});

it('[AC-B1-04zzab#27] 去重键含原因（经窗口）：一窗里子订单 X 回传 2、Y 回传 1，下一窗 X 回传 1、Y 回传 2：X、Y 各有两条 open（每种原因一条），都不交写入方', async () => {
  const appId = newAppId();
  const x = await seedOrder(h.db, appId);
  const y = await seedOrder(h.db, appId);
  const first = dbHandler(h.db, [
    [
      unfreezeRow(x.sub_order_id, { punish_status: '2' }),
      unfreezeRow(y.sub_order_id, { punish_status: '1' }),
    ],
  ]);
  const second = dbHandler(h.db, [
    [
      unfreezeRow(x.sub_order_id, { punish_status: '1' }),
      unfreezeRow(y.sub_order_id, { punish_status: '2' }),
    ],
  ]);
  await handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), first.deps);
  await expect(
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), second.deps),
  ).resolves.toBeUndefined();

  const rows = await pendingOf(h.db, appId);
  expect(rows).toHaveLength(4);
  expect(keyed(rows)).toEqual(bothReasons(x, y));
  expect(first.rightsRecord).not.toHaveBeenCalled();
  expect(second.rightsRecord).not.toHaveBeenCalled();
  expect(await rightsOf(h.db, appId)).toEqual([]);
});

/** Ungranted locks held by sessions of this test database, polled until `count` wait (or ~5 s). */
async function waitForWaiters(count: number): Promise<number> {
  let seen = 0;
  for (let round = 0; round < 250; round += 1) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where not l.granted and a.datname = current_database()
    `.execute(h.db);
    seen = rows[0]?.n ?? 0;
    if (seen >= count) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return seen;
}

it('[AC-B1-04zzab#29] 并发靠库约束：两个各自独立创建的记录器（各自的连接池，不共享进程内状态）在另一事务占住同键时同时写入，放行后两边都成功、都不抛错、只留一条 open', async () => {
  const appId = newAppId();
  const order = await seedOrder(h.db, appId);
  const left = await open(database!);
  const right = await open(database!);
  try {
    const a = createPunishPendingRecorder({ db: left.db });
    const b = createPunishPendingRecorder({ db: right.db });
    const signal = signalFor(appId, order.sub_order_id, 'UNFREEZE_SIGNAL', '1');

    // The barrier: another transaction holds an open row of the same key, uncommitted, so both
    // recorders find nothing and then wait on the unique index; it rolls back once both wait.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const rollback = new Error('synthetic barrier rollback');
    const barrier = h.db
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto('order_sync_pending')
          .values({
            app_id: appId,
            platform: 'taobao',
            sub_order_id: order.sub_order_id,
            order_id: null,
            reason: 'UNFREEZE_SIGNAL',
            raw_status: '1',
            detected_at: new Date(NOW),
            status: 'open',
          })
          .execute();
        holding();
        await gate;
        throw rollback;
      })
      .then(
        () => 'committed',
        (error: unknown) => {
          if (error === rollback) return 'rolled back';
          throw error;
        },
      );
    await Promise.race([held, barrier]);

    const writes = Promise.allSettled([a.record(signal), b.record(signal)]);
    const waiting = await waitForWaiters(2);
    release();
    expect(await barrier).toBe('rolled back');
    const results = await writes;

    expect(waiting).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await pendingOf(h.db, appId);
    expect(rows.map(view)).toEqual([
      {
        app_id: appId,
        platform: 'taobao',
        sub_order_id: order.sub_order_id,
        order_id: order.order_id,
        reason: 'UNFREEZE_SIGNAL',
        raw_status: '1',
        status: 'open',
        detected_at: new Date(NOW),
      },
    ]);
  } finally {
    await left.close();
    await right.close();
  }
});

it.each([
  ['解冻', 'UNFREEZE_SIGNAL', '1', 'UNMAPPED_STATUS', '2'],
  ['表外值', 'UNMAPPED_STATUS', '2', 'UNFREEZE_SIGNAL', '1'],
] as const)(
  '[AC-B1-04zzab#30] 真实库表：待处理写入失败（%s 行）即停，其后的冻结行与下一页不动；重投后失败前写过的仍只一条、没写成的补上；窗口结束时刻 ≠ 注入时钟，detected_at 与冻结行 occurred_at 取注入时钟',
  async (_name, failReason, failRaw, okReason, okRaw) => {
    const appId = newAppId();
    const earlier = await seedOrder(h.db, appId);
    const failing = await seedOrder(h.db, appId);
    const after = await seedOrder(h.db, appId);
    const next = await seedOrder(h.db, appId);
    const earlierRow = unfreezeRow(earlier.sub_order_id, { punish_status: okRaw });
    const failingRow = unfreezeRow(failing.sub_order_id, { punish_status: failRaw });
    const afterRow = unfreezeRow(after.sub_order_id, { punish_status: '0' });
    const nextRow = unfreezeRow(next.sub_order_id, { punish_status: '0' });
    const broken = new Error('synthetic order_sync_pending failure');
    let failed = false;
    const f = dbHandler(h.db, [[earlierRow, failingRow, afterRow], [nextRow]], {
      wrap: (recorder) => ({
        async record(signal) {
          if (!failed && signal.sub_order_id === failing.sub_order_id) {
            failed = true;
            throw broken;
          }
          await recorder.record(signal);
        },
      }),
    });
    const win = lateWindowOf(appId);
    expect(Date.parse(win.window_end)).not.toBe(Date.parse(NOW));
    const pendingRow = (order: typeof earlier, reason: string, raw: string) => ({
      app_id: appId,
      platform: 'taobao',
      sub_order_id: order.sub_order_id,
      order_id: order.order_id,
      reason,
      raw_status: raw,
      status: 'open',
      detected_at: new Date(NOW),
    });

    await expect(handlePunishWindow(job(PUNISH_JOB, win), f.deps)).rejects.toBe(broken);
    expect(f.rightsRecord).not.toHaveBeenCalled();
    expect(f.listPunishments).toHaveBeenCalledTimes(1);
    expect((await pendingOf(h.db, appId)).map(view)).toEqual([
      pendingRow(earlier, okReason, okRaw),
    ]);

    await expect(handlePunishWindow(job(PUNISH_JOB, win, 2), f.deps)).resolves.toBeUndefined();
    const rows = await pendingOf(h.db, appId);
    expect(rows.map(view)).toEqual([
      pendingRow(earlier, okReason, okRaw),
      pendingRow(failing, failReason, failRaw),
    ]);
    expect(
      f.rightsRecord.mock.calls.map(([, input]) => [
        input.order_id,
        input.type,
        input.status,
        input.platform_rights_no,
        input.occurred_at,
      ]),
    ).toEqual([
      [after.order_id, 'PUNISH', 'SUCCEEDED', afterRow.punishment_id, new Date(NOW)],
      [next.order_id, 'PUNISH', 'SUCCEEDED', nextRow.punishment_id, new Date(NOW)],
    ]);
    expect(await rightsOf(h.db, appId)).toEqual([]);
  },
);
