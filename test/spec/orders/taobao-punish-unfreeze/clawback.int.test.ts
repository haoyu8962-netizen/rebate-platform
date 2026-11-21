// 已有的扣回不撤销、不恢复（任务书 9.2 第 2 条；08 BR-FUND-22：处罚被平台解冻在 规划/09 实测证实前不恢复、
// 不补钱，决-06 实测前 A；因 PUNISH 作废 / 扣回的订单不自动复活，不告警、不生成差错单）：同一张订单此前已因
// 冻结行记过 PUNISH 并 VOID / CLAWED_BACK，之后同一违规单变成解冻（或 0 / 1 以外的值）→ order_rights 那一行、
// 订单返利状态与金额列、分录、账户余额（可用、冻结）都一字不变，recon_diffs 不多任何一行（特别是「已作废订单
// 被平台恢复」platform_restore），只多一条待处理记录。CLAWED_BACK 夹具带归因用户、入账与扣回分录和余额；VOID
// 夹具未入账。写入方是真实的 createRightsSyncWriter，settlement 的 rights.record 是只记调用的替身：解冻行不得
// 走到它。用例全部是顶层 it。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { handlePunishWindow } from '../../../../apps/api/src/modules/orders/jobs/rights-sync.ts';
import {
  dbHandler,
  ledgerOf,
  moneyOf,
  newAppId,
  open,
  orderRow,
  pendingOf,
  rightsOf,
  seedClawedBackLedger,
  seedOrder,
  seedPunishRow,
  seedUser,
  unfreezeRow,
  windowOf,
  type Harness,
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

const CREDITED = new Date('2026-10-20T02:00:00.000Z');
const CLAWED = new Date('2026-11-01T04:00:00.000Z');

const STATES = [
  [
    'CLAWED_BACK（入账后 R8 扣回）',
    {
      platform_status: 'SETTLED',
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      settle_commission_fen: 321n,
      booked_base_fen: 300n,
      booked_n_fen: 321n,
      credited_at: CREDITED,
      settled_at: CREDITED,
      updated_at: CLAWED,
      row_version: 3,
    },
  ],
  [
    'VOID（入账前 R6 作废）',
    {
      platform_status: 'RECEIVED',
      rebate_status: 'VOID',
      reason: 'PUNISH',
      updated_at: CLAWED,
      row_version: 2,
    },
  ],
] as const;

type State = (typeof STATES)[number][1];

/**
 * One order punished earlier (PUNISH row; CLAWED_BACK: attributed member, credit and clawback
 * vouchers, balance), then a window whose row for the same punishment says `punishStatus`:
 * everything but order_sync_pending stays as it was, and one open record of `reason` is added.
 */
async function punishedThenReported(
  state: State,
  punishStatus: string,
  reason: 'UNFREEZE_SIGNAL' | 'UNMAPPED_STATUS',
) {
  const appId = newAppId();
  const credited = state.rebate_status === 'CLAWED_BACK';
  const userId = credited ? await seedUser(h.db, appId) : null;
  const order = await seedOrder(h.db, appId, { ...state, user_id: userId });
  const row = unfreezeRow(order.sub_order_id, { punish_status: punishStatus });
  await seedPunishRow(h.db, order, row.punishment_id);
  const ledger =
    userId === null
      ? null
      : await seedClawedBackLedger(h.db, order, userId, {
          n: 321n,
          base: 300n,
          credited: CREDITED,
          clawed: CLAWED,
        });

  const rightsBefore = await rightsOf(h.db, appId);
  const orderBefore = await orderRow(h.db, appId, order.order_id);
  const moneyBefore = await moneyOf(h.db, appId);
  expect(rightsBefore).toHaveLength(1);
  expect(moneyBefore.diffs).toEqual([]);
  if (ledger !== null) {
    expect(moneyBefore.entries).toHaveLength(6);
    expect(moneyBefore.balances).toHaveLength(1);
  }

  const f = dbHandler(h.db, [[row]]);
  await expect(
    handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps),
  ).resolves.toBeUndefined();

  expect(f.rightsRecord).not.toHaveBeenCalled();
  expect(await rightsOf(h.db, appId)).toEqual(rightsBefore);
  const orderAfter = await orderRow(h.db, appId, order.order_id);
  expect(orderAfter).toEqual(orderBefore);
  expect({
    rebate_status: orderAfter.rebate_status,
    platform_status: orderAfter.platform_status,
    reason: orderAfter.reason,
    user_id: orderAfter.user_id,
    est_commission_fen: orderAfter.est_commission_fen,
    settle_commission_fen: orderAfter.settle_commission_fen,
    booked_base_fen: orderAfter.booked_base_fen,
    booked_n_fen: orderAfter.booked_n_fen,
    row_version: orderAfter.row_version,
  }).toEqual({
    rebate_status: state.rebate_status,
    platform_status: state.platform_status,
    reason: 'PUNISH',
    user_id: userId,
    est_commission_fen: order.est_commission_fen,
    settle_commission_fen: order.settle_commission_fen,
    booked_base_fen: order.booked_base_fen,
    booked_n_fen: order.booked_n_fen,
    row_version: state.row_version,
  });

  const moneyAfter = await moneyOf(h.db, appId);
  expect(moneyAfter.entries).toHaveLength(moneyBefore.entries.length);
  expect(moneyAfter.entries).toEqual(moneyBefore.entries);
  expect(moneyAfter.vouchers).toEqual(moneyBefore.vouchers);
  expect(moneyAfter.accounts).toEqual(moneyBefore.accounts);
  expect(moneyAfter.balances).toEqual(moneyBefore.balances);
  // No recon diff of any type: no platform_restore (已作废订单被平台恢复), nothing else either.
  expect(moneyAfter.diffs).toEqual([]);
  if (ledger !== null) {
    expect(
      moneyAfter.balances.map((b) => [b.account_id, b.available_fen, b.frozen_fen, b.version]),
    ).toEqual([[ledger.userAccountId, ledger.availableFen, ledger.frozenFen, 2n]]);
  }
  expect(await ledgerOf(h.db, appId)).toEqual(moneyBefore.entries);

  const pending = await pendingOf(h.db, appId);
  expect(
    pending.map((p) => ({
      sub_order_id: p.sub_order_id,
      order_id: p.order_id,
      reason: p.reason,
      raw_status: p.raw_status,
      status: p.status,
      detected_at: p.detected_at,
    })),
  ).toEqual([
    {
      sub_order_id: order.sub_order_id,
      order_id: order.order_id,
      reason,
      raw_status: punishStatus,
      status: 'open',
      detected_at: new Date(NOW),
    },
  ]);
}

it.each(STATES)(
  '[AC-B1-04zzab#19] 已因冻结记过 PUNISH 并 %s 的订单，同一违规单变成解冻：order_rights、订单返利状态与金额列、分录、账户余额逐列不变，不多任何差错单，只多一条待处理',
  async (_name, state) => {
    await punishedThenReported(state, '1', 'UNFREEZE_SIGNAL');
  },
);

it('[AC-B1-04zzab#20] 同页里的冻结行照旧走写入方，解冻行只进待处理：两张订单互不影响', async () => {
  const appId = newAppId();
  const punished = await seedOrder(h.db, appId, {
    rebate_status: 'VOID',
    reason: 'PUNISH',
    updated_at: CLAWED,
    row_version: 2,
  });
  const fresh = await seedOrder(h.db, appId);
  const unfreeze = unfreezeRow(punished.sub_order_id);
  await seedPunishRow(h.db, punished, unfreeze.punishment_id);
  const freeze = unfreezeRow(fresh.sub_order_id, { punish_status: '0' });
  const rightsBefore = await rightsOf(h.db, appId);

  const f = dbHandler(h.db, [[unfreeze, freeze]]);
  await handlePunishWindow(job(PUNISH_JOB, windowOf(appId)), f.deps);

  expect(f.rightsRecord).toHaveBeenCalledTimes(1);
  expect(f.rightsRecord.mock.calls[0]![1]).toMatchObject({
    order_id: fresh.order_id,
    type: 'PUNISH',
    status: 'SUCCEEDED',
    platform_rights_no: freeze.punishment_id,
  });
  expect(await rightsOf(h.db, appId)).toEqual(rightsBefore);
  expect(await orderRow(h.db, appId, punished.order_id)).toEqual(punished);
  expect((await pendingOf(h.db, appId)).map((p) => [p.sub_order_id, p.reason])).toEqual([
    [punished.sub_order_id, 'UNFREEZE_SIGNAL'],
  ]);
});

it.each(STATES)(
  '[AC-B1-04zzab#25] 已因冻结记过 PUNISH 并 %s 的订单，同一违规单回传 0 / 1 以外的值（2）：同样不补钱、不出差错单，order_rights、订单、分录、余额逐列不变，只多一条 UNMAPPED_STATUS 待处理',
  async (_name, state) => {
    await punishedThenReported(state, '2', 'UNMAPPED_STATUS');
  },
);
