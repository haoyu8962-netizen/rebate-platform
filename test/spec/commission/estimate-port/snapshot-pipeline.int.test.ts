// B2-03q · D10-568，入库流水线：不变量「订单 commission_version ≥ 1 时，该版本的金额行与 totals 一定存在」。
// 走真实 createOrderPipeline / createOrderUpdateStep（都经 runCommissionSnapshot）、真实 commission、真实 rebate。
// 规则版本：京东预留 1500，本人 5000。N=1000 → B=850，本人 425；N=2000 → B=1700，本人 850。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { RECEIVED, at, fixture as orderFixture } from '../../orders/attribution/kit.ts';
import {
  TIMEOUT,
  amountsAt,
  commission,
  databaseFixture,
  estimatesOf,
  portOrderOf,
  rebateOf,
  snapshotPortOf,
  snapshotRules,
  storedVersions,
  totalsAt,
  tracing,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** One attributable jd order of a new app, through the real pipeline, snapshot and rebate. */
async function harness(options: { readonly rules?: boolean } = {}) {
  const traced = tracing(p.db);
  const f = await orderFixture(traced.db, {
    platform: 'jd',
    service_fee_fen: null,
    est_commission_fen: 1000n,
    attr_params: { relation_id: null, sub_union_id: 'n_abcd1234', custom_parameters: null },
  });
  f.findPid.mockResolvedValue([{ pid_scene: 'self_buy', status: 'active', site_id: null }]);
  if (options.rules !== false) await snapshotRules(p.db, f.ctx.app_id);
  const rebate = rebateOf(f.clock, estimatesOf(f.clock));
  const snapshots = snapshotPortOf(f.clock, f.ctx.app_id, f.userId);
  const updateDeps: OrderUpdateDeps = {
    clock: f.clock,
    users: f.deps.users,
    bindings: f.deps.bindings,
    statusMaps: f.deps.statusMaps,
    pids: f.deps.pids,
    logger: f.logger,
    rebate,
    snapshots,
    events: { publish: async () => ({ eventId: randomUUID(), duplicate: false }) },
  };
  const pipeline = createOrderPipeline({
    ...f.deps,
    rebate,
    snapshots,
    updateStep: createOrderUpdateStep(updateDeps),
  });

  /** A later report of the same sub-order. */
  function next(change: Partial<UnionOrder>): UnionOrder {
    f.clock.advanceMs(60_000);
    const modified = new FixedClock(f.clock.now().toISOString());
    modified.advanceMs(-11_000);
    return { ...f.incoming, modified_at: modified.now(), raw_payload_id: '202', ...change };
  }

  async function stored() {
    const row = await p.db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .executeTakeFirstOrThrow();
    return { row, order: portOrderOf(row) };
  }

  return {
    ...f,
    queries: traced.queries,
    process: (order: UnionOrder) => pipeline.process(order, f.ctx),
    next,
    stored,
  };
}

it(
  '[AC-B2-03q#65] 已归因入库：快照 created、版本 0 → 同事务置 1，金额行就是这一版，读取端口按版本 1 正常',
  async () => {
    const h = await harness();

    expect(await h.process(h.incoming)).toMatchObject({ kind: 'inserted' });

    const { row, order } = await h.stored();
    expect(row).toMatchObject({ commission_version: 1, rebate_status: 'ESTIMATED' });
    expect(await amountsAt(p.db, order, 1)).toEqual([['self', 850n, 425n]]);
    expect(await totalsAt(p.db, order, 1)).toEqual({
      n_total_fen: 1000n,
      pre_base_deduct_fen: 150n,
      base_fen: 850n,
      user_share_total_fen: 425n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 575n,
    });
    expect(await storedVersions(p.db, order)).toEqual({ amounts: [1], totals: [1] });
    const read = await p.db.transaction().execute((trx) =>
      commission.readCommissionSnapshot(trx, {
        appId: order.appId,
        orderId: order.orderId,
        commissionVersion: 1,
      }),
    );
    expect(read).toMatchObject({ commissionVersion: 1, baseFen: 850n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#66] 版本置 1 带乐观锁：写版本的语句按 commission_version = 0 匹配',
  async () => {
    const h = await harness();
    h.queries.length = 0;

    await h.process(h.incoming);

    const writes = h.queries
      .filter((q) => /^\s*update\s+(?:"?app"?\.)?"?orders"?/i.test(q.sql))
      .filter((q) => /\bset\b[\s\S]*commission_version[\s\S]*\bwhere\b/i.test(q.sql));
    expect(writes).toHaveLength(1);
    const where = writes[0]!.sql.split(/\bwhere\b/i)[1]!;
    expect(where).toMatch(/commission_version"?\s*=\s*(?:\$\d+|0\b)/i);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#67] 第一次改佣金：版本到 2、写 v2，v1 仍是入库时的金额，不再出现「版本 1 的行是旧值」',
  async () => {
    const h = await harness();
    await h.process(h.incoming);

    const result = await h.process(h.next({ est_commission_fen: 2000n }));

    expect(result).toMatchObject({ kind: 'updated' });
    const { row, order } = await h.stored();
    expect(row).toMatchObject({ commission_version: 2, est_commission_fen: 2000n });
    expect(await amountsAt(p.db, order, 1)).toEqual([['self', 850n, 425n]]);
    expect(await amountsAt(p.db, order, 2)).toEqual([['self', 1700n, 850n]]);
    expect(await storedVersions(p.db, order)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#68] 未归因期间版本已到 3，同步归因时快照 created：照写 v1，同事务写 v3，不补 v2，版本不动',
  async () => {
    const h = await harness();
    h.findUser.mockResolvedValue(null);
    await h.process(h.incoming);
    await h.process(h.next({ est_commission_fen: 1200n }));
    await h.process(h.next({ est_commission_fen: 1600n }));
    expect((await h.stored()).row).toMatchObject({ user_id: null, commission_version: 2 });

    h.findUser.mockResolvedValue(h.userId);
    await h.process(h.next({ est_commission_fen: 2000n }));

    const { row, order } = await h.stored();
    expect(row).toMatchObject({ user_id: h.userId, commission_version: 3 });
    expect(await storedVersions(p.db, order)).toEqual({ amounts: [1, 3], totals: [1, 3] });
    expect(await amountsAt(p.db, order, 1)).toEqual([['self', 1700n, 850n]]);
    expect(await amountsAt(p.db, order, 3)).toEqual([['self', 1700n, 850n]]);
    expect(await totalsAt(p.db, order, 3)).toEqual(await totalsAt(p.db, order, 1));
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#69] 未归因期间版本恰到 1，同步归因时快照 created：v1 就是当前版本，不多行，版本不动',
  async () => {
    const h = await harness();
    h.findUser.mockResolvedValue(null);
    await h.process(h.incoming);

    h.findUser.mockResolvedValue(h.userId);
    await h.process(h.next({ est_commission_fen: 2000n }));

    const { row, order } = await h.stored();
    expect(row).toMatchObject({ user_id: h.userId, commission_version: 1 });
    expect(await storedVersions(p.db, order)).toEqual({ amounts: [1], totals: [1] });
    expect(await amountsAt(p.db, order, 1)).toEqual([['self', 1700n, 850n]]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#70] 入库时快照 pending：版本留 0、无金额行；补偿重试 created 后版本同样置 1',
  async () => {
    const h = await harness({ rules: false });
    await h.process(h.incoming);
    const first = await h.stored();
    expect(first.row.commission_version).toBe(0);
    expect(await storedVersions(p.db, first.order)).toEqual({ amounts: [], totals: [] });

    await snapshotRules(p.db, h.ctx.app_id);
    await h.process(h.next({ raw_status: 'received', received_at: at(RECEIVED) }));

    const { row, order } = await h.stored();
    expect(row).toMatchObject({ commission_version: 1, platform_status: 'RECEIVED' });
    expect(await amountsAt(p.db, order, 1)).toEqual([['self', 850n, 425n]]);
  },
  TIMEOUT,
);
