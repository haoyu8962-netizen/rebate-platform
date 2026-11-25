// B1-04zzac 伴随测试（FU-B1-04ZZAB-SPEC-R3-GAP；08 BR-FUND-22 决-06 实测前 A、BR-FUND-02）：B1-04zzab 规则测试
// 评审 r3 / r4 剩的缺口与资金评审 r1 / r2 修出来的行为，在真实库表上钉住（实现已在主干，本文件在主干上应为绿）：
// - 已付款未收货（platform_status PAID、rebate_status ESTIMATED）的订单遇 punish_status 1（解冻）或 0 / 1 以外的值：
//   订单整行（platform_status、rebate_status、hold、金额列）逐列不变，不交写入方，只多一条对应原因的 open 待处理。
// - 同键（app、平台、子订单、原因）已有别的来源的 open 记录：原记录的原值（raw_status、raw_payload_id、created_at、
//   order_id、原说明）保留，违规信号的标记并进说明；同一信号再来不重复追加。
// - 订单后入库：order_id 为 null 的 open 记录在同一信号再来时补成我方订单；已有关联（非 null）的不改。
// - 两个窗口（注入时钟不同）先后或并发处理同一信号：detected_at 取较晚的，不回退。
// - 待处理写入第一条就失败：该类别照样一条 warn，原错误外抛，库里不留半截。
// 会抛的调用先 settle 再用普通断言判。用例全部是顶层 it。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPunishPendingRecorder } from '../../../../../apps/api/src/modules/orders/application/punish-pending.ts';
import { handlePunishWindow } from '../../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import { FixedClock } from '../../../../../apps/api/src/modules/platform/index.ts';
import {
  dbHandler,
  newAppId,
  open,
  orderNo,
  pendingOf,
  rightsOf,
  seedOrder,
  seedUser,
  stateOf,
  trailOf,
  unfreezeRow,
  windowOf,
  type Harness,
  type Order,
  type PendingRow,
  type Trail,
} from '../db-kit.ts';
import {
  NOW,
  PUNISH_JOB,
  UNFREEZE_COUNT,
  UNFREEZE_EVENT,
  UNMAPPED_EVENT,
  job,
  linesOf,
} from '../kit.ts';

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

/** Two hours before the injected Clock: an earlier detection / a slower window's Clock. */
const EARLIER = new Date(Date.parse(NOW) - 2 * 3_600_000);

/** What another source (the order sync's own UNMAPPED_STATUS) left on the open record. */
const OTHER_RAW = 'TB_TK_STATUS_99';
const OTHER_DETAIL = 'order sync: tk_status 99 not in specs/order-status-map/taobao.csv';

/** The punish signal's value as it shows in the merged detail. */
const MARK_OF_2 = 'punish_status=2';

/** A run's outcome, read after it settles (no .resolves / .rejects). */
async function settle(run: Promise<void>): Promise<PromiseSettledResult<void>> {
  const [out] = await Promise.allSettled([run] as const);
  return out;
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** The columns of a pending row a signal decides. */
function view(row: PendingRow) {
  return {
    sub_order_id: row.sub_order_id,
    order_id: row.order_id,
    reason: row.reason,
    raw_status: row.raw_status,
    status: row.status,
    detected_at: row.detected_at,
  };
}

/** platform_status, rebate_status, hold, hold_reason of each order. */
function statusOf(trail: Trail) {
  return stateOf(trail).map((o) => [o.platform_status, o.rebate_status, o.hold, o.hold_reason]);
}

/** The order, its status history, order_rights and events naming it: as they were. */
async function expectUntouched(appId: string, orders: readonly Order[], before: Trail) {
  const after = await trailOf(h.db, appId, orders);
  expect(stateOf(after)).toEqual(stateOf(before));
  expect(after).toEqual(before);
  expect([after.history, after.rights, after.events]).toEqual([[], [], []]);
}

it.each([
  ['解冻', '1', 'UNFREEZE_SIGNAL'],
  ['表外值', '2', 'UNMAPPED_STATUS'],
] as const)(
  '[AC-B1-04zzac#1] 已付款未收货订单（platform_status PAID、rebate_status ESTIMATED）遇违规接口%s（punish_status %s）：platform_status、rebate_status、hold 与金额列逐列不变，不交写入方，只多一条 %s 的 open 待处理',
  async (_name, raw, reason) => {
    const appId = newAppId();
    const userId = await seedUser(h.db, appId);
    const order = await seedOrder(h.db, appId, {
      platform_status: 'PAID',
      rebate_status: 'ESTIMATED',
      user_id: userId,
      received_at: null,
      settle_period: null,
    });
    const before = await trailOf(h.db, appId, [order]);
    expect(await pendingOf(h.db, appId)).toEqual([]);
    const f = dbHandler(h.db, [[unfreezeRow(order.sub_order_id, { punish_status: raw })]]);

    const out = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps));
    expect(out.status).toBe('fulfilled');

    const after = await trailOf(h.db, appId, [order]);
    expect(statusOf(after)).toEqual([['PAID', 'ESTIMATED', false, null]]);
    await expectUntouched(appId, [order], before);
    expect(f.rightsRecord).not.toHaveBeenCalled();
    expect(await rightsOf(h.db, appId)).toEqual([]);
    expect((await pendingOf(h.db, appId)).map(view)).toEqual([
      {
        sub_order_id: order.sub_order_id,
        order_id: order.order_id,
        reason,
        raw_status: raw,
        status: 'open',
        detected_at: new Date(NOW),
      },
    ]);
  },
);

it.each([
  ['原说明非空', OTHER_DETAIL],
  ['原说明为空', null],
] as const)(
  '[AC-B1-04zzac#2] 同键已有一条别的来源（订单同步）的 open UNMAPPED_STATUS 记录（%s）：表外值信号到来，原记录的 raw_status、raw_payload_id、created_at、order_id 与原说明保留，违规信号的标记并进说明；同一信号再来不重复追加',
  async (_name, detail) => {
    const appId = newAppId();
    const order = await seedOrder(h.db, appId);
    const before = await trailOf(h.db, appId, [order]);
    await h.db
      .insertInto('order_sync_pending')
      .values({
        app_id: appId,
        platform: 'taobao',
        sub_order_id: order.sub_order_id,
        order_id: order.order_id,
        reason: 'UNMAPPED_STATUS',
        raw_status: OTHER_RAW,
        raw_payload_id: null,
        detail,
        detected_at: EARLIER,
        status: 'open',
        created_at: EARLIER,
      })
      .execute();
    const original = await pendingOf(h.db, appId);
    expect(original).toHaveLength(1);
    const row = unfreezeRow(order.sub_order_id, { punish_status: '2' });
    const f = dbHandler(h.db, [[row]]);

    const first = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps));
    expect(first.status).toBe('fulfilled');
    const once = await pendingOf(h.db, appId);
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({
      id: original[0]!.id,
      app_id: appId,
      platform: 'taobao',
      sub_order_id: order.sub_order_id,
      order_id: order.order_id,
      reason: 'UNMAPPED_STATUS',
      raw_status: OTHER_RAW,
      raw_payload_id: null,
      status: 'open',
      created_at: EARLIER,
      detected_at: new Date(NOW),
      resolved_by: null,
      resolved_at: null,
    });
    const merged = once[0]!.detail ?? '';
    const kept = detail ?? '';
    expect(merged.slice(0, kept.length)).toBe(kept);
    expect(count(merged, MARK_OF_2)).toBe(1);

    // The same signal again: by the window and by the recorder directly.
    const again = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId), 2), f.deps));
    expect(again.status).toBe('fulfilled');
    const direct = await settle(
      createPunishPendingRecorder({ db: h.db }).record({
        app_id: appId,
        platform: 'taobao',
        sub_order_id: order.sub_order_id,
        reason: 'UNMAPPED_STATUS',
        raw_status: '2',
        detected_at: new Date(NOW),
      }),
    );
    expect(direct.status).toBe('fulfilled');
    const twice = await pendingOf(h.db, appId);
    expect(twice).toEqual(once);
    expect(count(twice[0]!.detail ?? '', MARK_OF_2)).toBe(1);

    expect(f.rightsRecord).not.toHaveBeenCalled();
    await expectUntouched(appId, [order], before);
  },
);

it('[AC-B1-04zzac#3] 订单后入库：先有一条 order_id 为 null 的 open 解冻记录，我方订单入库后同一信号再来，order_id 补成我方订单，其余列不变、仍只一条', async () => {
  const appId = newAppId();
  const sub = orderNo();
  const f = dbHandler(h.db, [[unfreezeRow(sub)]]);

  const first = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps));
  expect(first.status).toBe('fulfilled');
  const before = await pendingOf(h.db, appId);
  expect(before.map(view)).toEqual([
    {
      sub_order_id: sub,
      order_id: null,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      status: 'open',
      detected_at: new Date(NOW),
    },
  ]);

  const order = await seedOrder(h.db, appId, { sub_order_id: sub });
  const trailBefore = await trailOf(h.db, appId, [order]);
  const second = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId), 2), f.deps));
  expect(second.status).toBe('fulfilled');

  const after = await pendingOf(h.db, appId);
  expect(after).toHaveLength(1);
  expect(after[0]).toEqual({ ...before[0]!, order_id: order.order_id });
  expect(f.rightsRecord).not.toHaveBeenCalled();
  await expectUntouched(appId, [order], trailBefore);
});

it('[AC-B1-04zzac#4] 已有关联不改：open 解冻记录的 order_id 已非空时，同一信号再来（我方此时查得到这张子订单的订单）order_id 保持原值、仍只一条', async () => {
  const appId = newAppId();
  const order = await seedOrder(h.db, appId);
  const linked = await seedOrder(h.db, appId);
  const trailBefore = await trailOf(h.db, appId, [order, linked]);
  await h.db
    .insertInto('order_sync_pending')
    .values({
      app_id: appId,
      platform: 'taobao',
      sub_order_id: order.sub_order_id,
      order_id: linked.order_id,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      raw_payload_id: null,
      detail: null,
      detected_at: EARLIER,
      status: 'open',
      created_at: EARLIER,
    })
    .execute();
  const f = dbHandler(h.db, [[unfreezeRow(order.sub_order_id)]]);

  const out = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps));
  expect(out.status).toBe('fulfilled');

  const rows = await pendingOf(h.db, appId);
  expect(rows.map(view)).toEqual([
    {
      sub_order_id: order.sub_order_id,
      order_id: linked.order_id,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      status: 'open',
      detected_at: new Date(NOW),
    },
  ]);
  expect(f.rightsRecord).not.toHaveBeenCalled();
  await expectUntouched(appId, [order, linked], trailBefore);
});

it('[AC-B1-04zzac#5] 两个窗口先后处理同一解冻信号、注入时钟一早一晚：detected_at 取较晚的，较早的窗口后到不把它改回去；仍只一条 open', async () => {
  const appId = newAppId();
  const order = await seedOrder(h.db, appId);
  const trailBefore = await trailOf(h.db, appId, [order]);
  const row = unfreezeRow(order.sub_order_id);
  const fast = dbHandler(h.db, [[row]]);
  const slow = dbHandler(h.db, [[row]]);
  const slowDeps = { ...slow.deps, clock: new FixedClock(EARLIER) };
  const seen = async () => (await pendingOf(h.db, appId)).map((r) => [r.status, r.detected_at]);

  const a = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), slowDeps));
  expect(a.status).toBe('fulfilled');
  expect(await seen()).toEqual([['open', EARLIER]]);

  const b = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), fast.deps));
  expect(b.status).toBe('fulfilled');
  expect(await seen()).toEqual([['open', new Date(NOW)]]);

  const c = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId), 2), slowDeps));
  expect(c.status).toBe('fulfilled');
  expect(await seen()).toEqual([['open', new Date(NOW)]]);

  expect(fast.rightsRecord).not.toHaveBeenCalled();
  expect(slow.rightsRecord).not.toHaveBeenCalled();
  await expectUntouched(appId, [order], trailBefore);
});

it('[AC-B1-04zzac#6] 两个窗口并发处理同一解冻信号、注入时钟一早一晚：两个都不抛错，只留一条 open，detected_at 为较晚的那个', async () => {
  const appId = newAppId();
  const order = await seedOrder(h.db, appId);
  const trailBefore = await trailOf(h.db, appId, [order]);
  const row = unfreezeRow(order.sub_order_id);
  const fast = dbHandler(h.db, [[row]]);
  const slow = dbHandler(h.db, [[row]]);
  const slowDeps = { ...slow.deps, clock: new FixedClock(EARLIER) };

  const results = await Promise.allSettled([
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), slowDeps),
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId), 2), fast.deps),
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId), 3), slowDeps),
  ]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);

  expect((await pendingOf(h.db, appId)).map(view)).toEqual([
    {
      sub_order_id: order.sub_order_id,
      order_id: order.order_id,
      reason: 'UNFREEZE_SIGNAL',
      raw_status: '1',
      status: 'open',
      detected_at: new Date(NOW),
    },
  ]);
  expect(fast.rightsRecord).not.toHaveBeenCalled();
  expect(slow.rightsRecord).not.toHaveBeenCalled();
  await expectUntouched(appId, [order], trailBefore);
});

it('[AC-B1-04zzac#7] 真实库表：窗口里第一条待处理写入就失败（解冻行）：照样一条 warn（解冻计数 0），原错误外抛，库里不留记录、订单不动', async () => {
  const appId = newAppId();
  const order = await seedOrder(h.db, appId);
  const trailBefore = await trailOf(h.db, appId, [order]);
  const broken = new Error('synthetic order_sync_pending failure');
  const f = dbHandler(h.db, [[unfreezeRow(order.sub_order_id)]], {
    wrap: () => ({ record: () => Promise.reject(broken) }),
  });

  const out = await settle(handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps));
  expect(out.status).toBe('rejected');
  expect(out.status === 'rejected' ? out.reason : undefined).toBe(broken);

  const warns = linesOf(f.logger.warn, UNFREEZE_EVENT);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatchObject({ [UNFREEZE_COUNT]: 0 });
  expect(linesOf(f.logger.warn, UNMAPPED_EVENT)).toEqual([]);
  expect(await pendingOf(h.db, appId)).toEqual([]);
  expect(f.rightsRecord).not.toHaveBeenCalled();
  await expectUntouched(appId, [order], trailBefore);
});
