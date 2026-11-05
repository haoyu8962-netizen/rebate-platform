// B2-03q · 端口接进真实 settlement rebate（RebateDependencies.estimates，签名不改）：真实 bases 决定 R6 / R7，
// 真实 refresh 跟在迁移之后；CREDITED 分支在版本前进时调 refresh。结算后预估单独变化只存档，版本不动，
// 没有新行；结算额变化才推版本（BR-CALC-15，D10-578）。
// 默认单：预留 1500、N=1000 → B=850；N=800 → B=680。
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import type { DB } from '@couli/db';
import { expect, it, vi } from 'vitest';
import {
  planOrderSyncColumns,
  type OrderUpdatePlan,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { order as unionOrder } from '../../orders/attribution/kit.ts';
import {
  TIMEOUT,
  amountsAt,
  commission,
  databaseFixture,
  estimatesOf,
  fixture,
  moneyRows,
  orderRow,
  rebateOf,
  storedVersions,
  syncColumns,
  totalsAt,
  type PortOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

async function readCurrent(trx: Transaction<DB>, o: PortOrder, commissionVersion: number) {
  return commission.readCommissionSnapshot(trx, {
    appId: o.appId,
    orderId: o.orderId,
    commissionVersion,
  });
}

const SETTLED_SYNC: OrderUpdatePlan = {
  kind: 'update',
  platform_status: 'SETTLED',
  received_at: null,
  history: [],
  pending: null,
  rule: null,
};

/**
 * One sync of an already settled order. syncColumns moves the version on any estimate change, so
 * the commission columns come from the real column plan here, and so does commission_moved
 * (BR-CALC-15): the version moves only because the plan says so, as in update-step.
 */
async function plannedColumns(
  trx: Transaction<DB>,
  o: PortOrder,
  reported: { readonly estAfter?: bigint; readonly settleAfter?: bigint },
) {
  const { change, source } = await syncColumns(trx, o, { event: 'PLATFORM_SETTLED' });
  const current = await orderRow(trx, o);
  const columns = planOrderSyncColumns(
    current,
    unionOrder({
      est_commission_fen: reported.estAfter ?? null,
      settle_commission_fen: reported.settleAfter ?? null,
    }),
    SETTLED_SYNC,
  );
  await trx
    .updateTable('orders')
    .set({
      est_commission_fen: columns.est_commission_fen,
      settle_commission_fen: columns.settle_commission_fen,
      commission_version: columns.commission_version,
    })
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .execute();
  return {
    change: {
      ...change,
      est_after: columns.est_commission_fen,
      settle_commission_fen: columns.settle_commission_fen,
      commission_moved: columns.commission_version !== current.commission_version,
    },
    source,
  };
}

it('[AC-B2-03q#38] commission 公开出口给出端口，rebate.ts 的 TODO 已解', async () => {
  const f = await fixture(p.db);
  expect(typeof f.estimates.bases).toBe('function');
  expect(typeof f.estimates.refresh).toBe('function');
  const source = readFileSync(
    new URL(
      '../../../../apps/api/src/modules/settlement/rebate/application/rebate.ts',
      import.meta.url,
    ),
    'utf8',
  );
  expect(source).not.toContain('blocked on missing public writer port');
});

it('[AC-B2-03q#39][BR-FUND-01] R7 ESTIMATED：真实 bases 判 recalc，真实 refresh 写当前版本，状态不变', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { estAfter: 2000n });
    await rebate.onUpdated(trx, change, source);
  });

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1700n, 850n],
    ['direct', 1700n, 170n],
    ['indirect', 1700n, 85n],
  ]);
  const order = await p.db
    .selectFrom('orders')
    .select(['rebate_status', 'commission_version'])
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  expect(order).toEqual({ rebate_status: 'ESTIMATED', commission_version: 2 });
  expect((await moneyRows(p.db, o.appId)).vouchers).toEqual([]);
});

it('[AC-B2-03q#40][BR-FUND-01] R7 经 apply（部分退款）：入参的 estAfter 进 bases，refresh 写当前版本', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    await syncColumns(trx, o, { estAfter: 500n });
    await rebate.apply(
      trx,
      {
        appId: o.appId,
        orderId: o.orderId,
        attrAt: o.attrAt,
        estBefore: 1000n,
        estAfter: 500n,
        settleCommissionFen: null,
      },
      'PARTIAL_REFUND',
    );
  });

  // 500 × 85% = 425；212 / 42 / 21。
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 425n, 212n],
    ['direct', 425n, 42n],
    ['indirect', 425n, 21n],
  ]);
});

it('[AC-B2-03q#41][BR-FUND-07] R6：真实 bases 给出新基数 0，订单 VOID，版本行照写，B=0', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { estAfter: 0n });
    // kit 的 syncColumns 推了版本，补上真实同步会给出的标志（D10-650）。
    await rebate.onUpdated(trx, { ...change, commission_moved: true }, source);
  });

  const order = await p.db
    .selectFrom('orders')
    .select(['rebate_status', 'reason'])
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  expect(order).toEqual({ rebate_status: 'VOID', reason: 'COMMISSION_ZERO' });
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 0n, 0n],
    ['direct', 0n, 0n],
    ['indirect', 0n, 0n],
  ]);
});

it('[AC-B2-03q#42][BR-FUND-07] 无快照的单：bases 的 null 不当 0，佣金变 0 不作废；refresh 什么也不写', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ snapshot: false });
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { estAfter: 0n });
    await rebate.onUpdated(trx, change, source);
  });

  const order = await p.db
    .selectFrom('orders')
    .select(['rebate_status', 'commission_version'])
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  expect(order).toEqual({ rebate_status: 'ESTIMATED', commission_version: 2 });
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [], totals: [] });
});

it('[AC-B2-03q#43] R3a 跳号：未归因期间版本到 3、快照只写了 v1，归因时 refresh 直接写 v3', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    rebateStatus: 'UNATTRIBUTED',
    commissionVersion: 3,
    estFen: 1600n,
  });
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { attributedNow: true });
    await rebate.onUpdated(trx, change, source);
  });

  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 3], totals: [1, 3] });
  expect(await amountsAt(p.db, o, 3)).toEqual([
    ['self', 1360n, 680n],
    ['direct', 1360n, 136n],
    ['indirect', 1360n, 68n],
  ]);
  const read = await p.db.transaction().execute((trx) => readCurrent(trx, o, 3));
  expect(read).toMatchObject({ commissionVersion: 3, baseFen: 1360n });
});

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B2-03q#44][BR-FUND-03][BR-CALC-15] %s 结算后预估单独变化：不走 R7、结算额不变，est 只存档，版本不动，没有 v2 行，读取仍是 v1',
  async (rebateStatus) => {
    const f = await fixture(p.db);
    const o = await f.order({
      rebateStatus,
      platformStatus: 'SETTLED',
      estFen: 1000n,
      settleFen: 1000n,
      patch: { received_at: new Date('2026-10-25T01:00:00.000Z'), settle_period: '2026-10' },
    });
    const rebate = rebateOf(f.clock, f.estimates);

    await p.db.transaction().execute(async (trx) => {
      const { change, source } = await plannedColumns(trx, o, { estAfter: 3000n });
      await rebate.onUpdated(trx, change, source);
    });

    // 有效佣金仍是结算额 1000（①）：只有 est 存档。
    expect(await orderRow(p.db, o)).toMatchObject({
      est_commission_fen: 3000n,
      settle_commission_fen: 1000n,
      commission_version: 1,
    });
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
    expect(await amountsAt(p.db, o, 1)).toEqual([
      ['self', 850n, 425n],
      ['direct', 850n, 85n],
      ['indirect', 850n, 42n],
    ]);
    expect(await totalsAt(p.db, o, 1)).toMatchObject({ n_total_fen: 1000n, base_fen: 850n });
    const read = await p.db.transaction().execute((trx) => readCurrent(trx, o, 1));
    expect(read).toMatchObject({ commissionVersion: 1, baseFen: 850n });
    const history = await p.db
      .selectFrom('order_status_history')
      .select('event')
      .where('app_id', '=', o.appId)
      .where('order_id', '=', o.orderId)
      .execute();
    expect(history.map((row) => row.event)).not.toContain('COMMISSION_CHANGED');
  },
  TIMEOUT,
);

it('[AC-B2-03q#45][BR-FUND-01][BR-CALC-23] CREDITED 分支：结算额变化推版本时调一次 refresh，同一事务，新行按新 N，状态与 booked 不动', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    rebateStatus: 'CREDITED',
    platformStatus: 'SETTLED',
    estFen: 1000n,
    settleFen: 1000n,
    patch: { booked_base_fen: 850n, booked_n_fen: 1000n },
  });
  const real = estimatesOf(f.clock);
  const refresh = vi.fn<typeof real.refresh>((trx, input) => real.refresh(trx, input));
  const rebate = rebateOf(f.clock, {
    bases: (trx, input) => real.bases(trx, input),
    refresh,
  });
  const seen: Transaction<DB>[] = [];

  await p.db.transaction().execute(async (trx) => {
    seen.push(trx);
    const { change, source } = await plannedColumns(trx, o, { settleAfter: 800n });
    await rebate.onUpdated(trx, change, source);
  });

  expect(refresh.mock.calls).toEqual([
    [seen[0], { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt }],
  ]);
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 680n, 340n],
    ['direct', 680n, 68n],
    ['indirect', 680n, 34n],
  ]);
  const order = await p.db
    .selectFrom('orders')
    .select(['rebate_status', 'booked_base_fen', 'booked_n_fen', 'commission_version'])
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  expect(order).toEqual({
    rebate_status: 'CREDITED',
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
    commission_version: 2,
  });
});

it('[AC-B2-03q#46][BR-FUND-01] CREDITED 分支：版本没前进时没有新版本的行', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    rebateStatus: 'CREDITED',
    platformStatus: 'SETTLED',
    estFen: 1000n,
    settleFen: 1000n,
    commissionVersion: 2,
    patch: { booked_base_fen: 850n, booked_n_fen: 1000n },
  });
  await f.version(o, {
    version: 2,
    nTotalFen: 1000n,
    baseFen: 850n,
    amounts: [425n, 85n, 42n],
  });
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { event: 'PLATFORM_SETTLED' });
    await rebate.onUpdated(trx, change, source);
  });

  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
});

it('[AC-B2-03q#62][BR-FUND-01][BR-CALC-03] R7 拼多多：est 已是净额，真实 bases 与 refresh 都按这个 N，不再减服务费', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    platform: 'pdd',
    estFen: 1000n,
    patch: { service_fee_fen: 200n },
  });
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { estAfter: 1800n });
    await rebate.onUpdated(trx, change, source);
  });

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1530n, 765n],
    ['direct', 1530n, 153n],
    ['indirect', 1530n, 76n],
  ]);
});

it('[AC-B2-03q#63][BR-FUND-07][BR-CALC-03] R6 拼多多：est 变 0 时新基数是 0，订单 VOID，不走 R7；净额恰好等于服务费不是 0，不作废', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    platform: 'pdd',
    estFen: 1000n,
    patch: { service_fee_fen: 200n },
  });
  const rebate = rebateOf(f.clock, f.estimates);

  // 对照：净额 200 等于服务费，但已扣过，不再减：200 × 85% = 170，走 R7。
  const kept = await f.order({
    platform: 'pdd',
    estFen: 1000n,
    patch: { service_fee_fen: 200n },
  });
  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, kept, { estAfter: 200n });
    await rebate.onUpdated(trx, change, source);
  });
  const keptOrder = await p.db
    .selectFrom('orders')
    .select(['rebate_status', 'reason'])
    .where('app_id', '=', kept.appId)
    .where('order_id', '=', kept.orderId)
    .executeTakeFirstOrThrow();
  expect(keptOrder).toEqual({ rebate_status: 'ESTIMATED', reason: null });

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { estAfter: 0n });
    // kit 的 syncColumns 推了版本，补上真实同步会给出的标志（D10-650）。
    await rebate.onUpdated(trx, { ...change, commission_moved: true }, source);
  });

  const order = await p.db
    .selectFrom('orders')
    .select(['rebate_status', 'reason'])
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  expect(order).toEqual({ rebate_status: 'VOID', reason: 'COMMISSION_ZERO' });
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
});

it('[AC-B2-03q#64][BR-FUND-07][BR-CALC-02] R6 有补贴的单：佣金变 0 时新基数是 0，补贴不把订单留在 R7', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ subsidyFen: 111n });
  const rebate = rebateOf(f.clock, f.estimates);

  await p.db.transaction().execute(async (trx) => {
    const { change, source } = await syncColumns(trx, o, { estAfter: 0n });
    // kit 的 syncColumns 推了版本，补上真实同步会给出的标志（D10-650）。
    await rebate.onUpdated(trx, { ...change, commission_moved: true }, source);
  });

  const order = await p.db
    .selectFrom('orders')
    .select(['rebate_status', 'reason'])
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  expect(order).toEqual({ rebate_status: 'VOID', reason: 'COMMISSION_ZERO' });
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
});
