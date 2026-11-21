// 解冻信号进待处理表（任务书 9.2 第 2、4、5 条；08 BR-FUND-22 决-06 实测前 A、BR-FUND-02）：生产的待处理写入
// （application/punish-pending.ts 的 createPunishPendingRecorder）落 app.order_sync_pending，与映射表外的状态码
// 同一张表；同键 open 记录只有一条，靠 order_sync_pending_open_key 唯一索引（不靠先查后插）：重复拉取、任务重投、
// 两个窗口并发都只留一条 open、都不抛错；该条被处置（resolved / dismissed）后再出现新开一条。我方有这张订单时
// order_id 填它，没有时为 null（仍留证据）。用例全部是顶层 it。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPunishPendingRecorder } from '../../../../apps/api/src/modules/orders/application/punish-pending.ts';
import { handlePunishWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import {
  closePending,
  dbHandler,
  newAppId,
  open,
  orderNo,
  pendingOf,
  rightsOf,
  seedOrder,
  unfreezeRow,
  windowOf,
  type Harness,
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
