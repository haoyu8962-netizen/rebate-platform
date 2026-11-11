// B1-18c（BR-CALC-18、BR-CALC-25）：订单流水线首次入库。
// - orders.subsidy_commission_fen 写适配器给的补贴类佣金（有值写值，null 写 NULL）；分佣快照的
//   commission_splits.subsidy_commission_fen 等于该订单的补贴（null → 0，沿用 commission-snapshot.ts 的 `?? 0n`），
//   N（raw_n_fen）仍是 est，不含补贴。
// - 配置 union.<platform>.subsidy_itemized（boolean，未设值按 true，BR-CALC-25 细则）取订单所属 App 的 config_items；
//   为 false 时该平台新订单首次入库置 orders.credit_requires_settle=true，为 true、未设值、别的平台为 false。
//   后续同步不把 true 改回 false（库触发器本就拒绝：同步不报错、值仍 true）。credit.enabled.<platform> 不写。
//   为 false 时 N 照常整体计入 B：快照照常生成、raw_n_fen 仍是预估 N；不用 hold（orders.hold 仍 false）。
// - 更新路径：首次同步补贴缺失、后续同步补贴到达且该次首次具备快照资格 → 订单列与快照都取新补贴。
// - 幂等：同一报文投递两次 → 一行订单、一条快照，补贴不变，第二次不报错。
// 真实迁移后的库；流水线经 commission-snapshot 的只读 kit 搭（假端口，快照用真实 commission 端口）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  RegisteredPlatform,
  UnionOrder,
  UnionOrderAttrParams,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  beneficiaries as threeParties,
  seedVersion,
  version,
} from '../../commission/snapshot/fixtures.ts';
import {
  at,
  capture,
  fresh,
  runFresh,
  runUpdate,
  scenario,
  type SnapshotPort,
} from '../commission-snapshot/db-kit.ts';
import { realPort, splits } from '../commission-snapshot/real-kit.ts';
import { config } from '../source-wiring/db-kit.ts';

// Same public runtime import as commission-snapshot/real-kit.ts: avoid pulling Nest controllers
// into the test project's erasable-syntax-only type graph.
const { createCommissionSnapshot, createInMemoryBeneficiaryResolver } = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  createCommissionSnapshot: typeof import('../../../../apps/api/src/modules/commission/application/snapshot.ts').createCommissionSnapshot;
  createInMemoryBeneficiaryResolver: typeof import('../../../../apps/api/src/modules/commission/infra/in-memory-beneficiary-resolver.ts').createInMemoryBeneficiaryResolver;
};

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

const INSERTED = { ok: true, value: { kind: 'inserted' } };

/** A new order of `platform` in an App of its own, with `settings` as that App's config_items. */
async function inserted(
  platform: RegisteredPlatform,
  settings: Readonly<Record<string, boolean>> = {},
  patch: Partial<Omit<UnionOrder, 'platform'>> = {},
) {
  const f = await fresh(db, { ...patch, platform });
  for (const [key, value] of Object.entries(settings)) {
    await config(db, f.ctx.app_id, key, value);
  }
  expect(await runFresh(f)).toMatchObject(INSERTED);
  const { orders } = await f.read();
  expect(orders).toHaveLength(1);
  return { f, row: orders[0]! };
}

it('[AC-B1-18c#6][BR-CALC-18] 新订单首次入库：orders.subsidy_commission_fen 写适配器给的补贴（淘宝 200 → 200，0 → 0），null 或不给写 NULL；est 照写，不加补贴', async () => {
  const subsidy = { est_commission_fen: 800n, subsidy_commission_fen: 200n };
  const given = await inserted('taobao', {}, subsidy);
  expect(given.row).toMatchObject({ subsidy_commission_fen: 200n, est_commission_fen: 800n });

  const zero = await inserted('taobao', {}, { subsidy_commission_fen: 0n });
  expect(zero.row.subsidy_commission_fen).toBe(0n);

  const none = await inserted('taobao', {}, { subsidy_commission_fen: null });
  expect(none.row.subsidy_commission_fen).toBeNull();
  const absent = await inserted('pdd');
  expect(absent.row.subsidy_commission_fen).toBeNull();
});

it('[AC-B1-18c#7][BR-CALC-18] 首次入库即生成分佣快照：快照入参与 commission_splits.subsidy_commission_fen 等于订单补贴 200，raw_n_fen 仍是 est 789；订单没有补贴时快照记 0', async () => {
  const f = await fresh(db, { subsidy_commission_fen: 200n });
  const port = await realPort(db, f);
  expect(await runFresh(f, port)).toMatchObject(INSERTED);
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    nBaseFen: 789n,
    subsidyCommissionFen: 200n,
  });
  const rows = await splits(db, f.ctx.app_id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ raw_n_fen: 789n, subsidy_commission_fen: 200n });
  expect((await f.read()).orders[0]).toMatchObject({ subsidy_commission_fen: 200n });

  const plain = await fresh(db, { subsidy_commission_fen: null });
  expect(await runFresh(plain, await realPort(db, plain))).toMatchObject(INSERTED);
  expect(await splits(db, plain.ctx.app_id)).toEqual([
    expect.objectContaining({ raw_n_fen: 789n, subsidy_commission_fen: 0n }),
  ]);
});

const PLATFORMS: readonly {
  readonly platform: RegisteredPlatform;
  readonly other: RegisteredPlatform;
}[] = [
  { platform: 'taobao', other: 'pdd' },
  { platform: 'jd', other: 'taobao' },
  { platform: 'pdd', other: 'jd' },
];

it.each(PLATFORMS)(
  '[AC-B1-18c#9][AC-B1-18c#10][AC-B1-18c#11][BR-CALC-25] union.$platform.subsidy_itemized=false：该平台新订单首次入库 credit_requires_settle=true；true、未设值、只关了别的平台时为 false；后续同步不报错、值仍 true；不写 credit.enabled',
  async ({ platform, other }) => {
    const key = `union.${platform}.subsidy_itemized`;

    const off = await inserted(platform, { [key]: false });
    expect(off.row.credit_requires_settle).toBe(true);

    const on = await inserted(platform, { [key]: true });
    const unset = await inserted(platform);
    const otherKeyOff = await inserted(platform, { [`union.${other}.subsidy_itemized`]: false });
    const otherPlatform = await inserted(other, { [key]: false });
    for (const { row } of [on, unset, otherKeyOff, otherPlatform]) {
      expect(row.credit_requires_settle).toBe(false);
    }

    // 已入库的单：配置改回 true 后再同步一次（预估变了），标志不回 false，同步也不因触发器报错。
    await config(db, off.f.ctx.app_id, key, true);
    off.f.clock.advanceMs(80_000);
    const updateDeps: OrderUpdateDeps = {
      ...off.f.deps,
      rebate: { onUpdated: async () => {}, onUnmappedStatus: async () => {} },
      events: { publish: async () => ({ eventId: 'synthetic', duplicate: false }) },
    };
    const pipeline = createOrderPipeline({
      ...off.f.deps,
      updateStep: createOrderUpdateStep(updateDeps),
    });
    const later: UnionOrder = {
      ...off.f.incoming,
      est_commission_fen: 899n,
      modified_at: at('2026-10-17T18:00:00Z'),
    };
    expect(await capture(() => pipeline.process(later, off.f.ctx))).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    const after = await off.f.read();
    expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ credit_requires_settle: true });

    // credit.enabled.<platform> 不由本流程写。
    const credit = await db
      .selectFrom('config_items')
      .select('key')
      .where('app_id', '=', off.f.ctx.app_id)
      .where('key', 'like', 'credit.enabled.%')
      .execute();
    expect(credit).toEqual([]);
  },
);

type Flow = Awaited<ReturnType<typeof fresh>>;

/** Taobao attributes through the relation_id binding (BR-ATTR-07), not attr_code. */
const TAOBAO_RELATION: UnionOrderAttrParams = {
  relation_id: '3200000001',
  sub_union_id: null,
  custom_parameters: null,
};

/** The relation_id is bound to the fixture's user before the order's attr_at. */
function bindRelation(f: Pick<Flow, 'findBindings' | 'userId'>): void {
  f.findBindings.mockResolvedValue([
    {
      user_id: f.userId,
      bound_at: at('2026-10-10T01:02:03.000Z'),
      released_at: null,
      cooldown_until: null,
    },
  ]);
}

/** The real snapshot on a published version that covers taobao (real-kit's realPort is pdd only). */
async function taobaoSnapshots(f: Pick<Flow, 'ctx' | 'userId' | 'clock'>) {
  await seedVersion(db, f.ctx.app_id, version());
  const beneficiaries = createInMemoryBeneficiaryResolver([
    { appId: f.ctx.app_id, beneficiaries: threeParties(f.userId) },
  ]);
  const create = vi.fn<SnapshotPort['create']>((trx, input) =>
    createCommissionSnapshot(trx, input, {
      clock: f.clock,
      logger: { warn: vi.fn() },
      beneficiaries,
    }),
  );
  return { create };
}

it('[AC-B1-18c#12][BR-CALC-18] 更新路径：淘宝订单首次同步补贴缺失（NULL、未归属），后续同步补贴 200 且该次首次归属生成快照 → orders.subsidy_commission_fen 更新为 200，快照入参与 commission_splits.subsidy_commission_fen 为 200，raw_n_fen 仍是 est 789', async () => {
  const f = await scenario(db, {
    platform: 'taobao',
    attr_params: TAOBAO_RELATION,
    subsidy_commission_fen: null,
    service_fee_fen: 31n,
  });
  expect(f.original).toMatchObject({ user_id: null, subsidy_commission_fen: null });
  const port = await taobaoSnapshots(f);
  bindRelation(f);

  expect(await runUpdate(f, port, f.next({ subsidy_commission_fen: 200n }))).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    nBaseFen: 789n,
    subsidyCommissionFen: 200n,
  });
  const after = await f.read();
  expect(after.orders).toHaveLength(1);
  expect(after.orders[0]).toMatchObject({
    user_id: f.userId,
    subsidy_commission_fen: 200n,
    est_commission_fen: 789n,
  });
  const rows = await splits(db, f.ctx.app_id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ raw_n_fen: 789n, subsidy_commission_fen: 200n });
});

it('[AC-B1-18c#13][BR-CALC-25] union.pdd.subsidy_itemized=false、预估 N 1000、无结算值：credit_requires_settle=true，但 N 不置零、快照照常生成，raw_n_fen=1000、B>0', async () => {
  const f = await fresh(db, {
    commission_fen: 1000n,
    est_commission_fen: 1000n,
    settle_commission_fen: null,
  });
  await config(db, f.ctx.app_id, 'union.pdd.subsidy_itemized', false);
  const port = await realPort(db, f);
  expect(await runFresh(f, port)).toMatchObject(INSERTED);

  const { orders } = await f.read();
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({
    user_id: f.userId,
    est_commission_fen: 1000n,
    settle_commission_fen: null,
    credit_requires_settle: true,
    hold: false,
  });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 1000n });
  const rows = await splits(db, f.ctx.app_id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ raw_n_fen: 1000n });
  expect(rows[0]!.base_fen > 0n).toBe(true);
});

it.each(PLATFORMS)(
  '[AC-B1-18c#14][BR-CALC-25][BR-FUND-06] union.$platform.subsidy_itemized=false：新订单置 credit_requires_settle=true，不使用 hold（orders.hold 仍 false）',
  async ({ platform }) => {
    const { row } = await inserted(platform, { [`union.${platform}.subsidy_itemized`]: false });
    expect(row).toMatchObject({ credit_requires_settle: true, hold: false });
  },
);

it('[AC-B1-18c#15][BR-CALC-18] 幂等：同一淘宝补贴订单（同一报文）投递两次 → orders 一行、subsidy_commission_fen 仍 200，commission_splits 一条、快照只生成一次，第二次不报错', async () => {
  const f = await fresh(db, {
    platform: 'taobao',
    attr_params: TAOBAO_RELATION,
    subsidy_commission_fen: 200n,
  });
  bindRelation(f);
  const port = await taobaoSnapshots(f);
  expect(await runFresh(f, port)).toMatchObject(INSERTED);
  const first = await f.read();
  expect(first.orders).toHaveLength(1);
  expect(first.orders[0]).toMatchObject({ user_id: f.userId, subsidy_commission_fen: 200n });
  expect(port.create).toHaveBeenCalledTimes(1);

  // 第二次投递同一报文：流水线带上更新步与同一快照端口，按至少一次投递处理。
  f.clock.advanceMs(30_000);
  const updateDeps: OrderUpdateDeps = {
    ...f.deps,
    snapshots: port,
    rebate: { onUpdated: async () => {}, onUnmappedStatus: async () => {} },
    events: { publish: async () => ({ eventId: 'synthetic', duplicate: false }) },
  };
  const again = createOrderPipeline({
    ...f.deps,
    snapshots: port,
    updateStep: createOrderUpdateStep(updateDeps),
  });
  const second = await capture(() => again.process(f.incoming, f.ctx));
  expect(second.ok).toBe(true);
  expect(second).not.toMatchObject({ value: { kind: 'inserted' } });

  const after = await f.read();
  expect(after.orders).toHaveLength(1);
  expect(after.orders[0]).toMatchObject({ subsidy_commission_fen: 200n });
  expect(port.create).toHaveBeenCalledTimes(1);
  const rows = await splits(db, f.ctx.app_id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ subsidy_commission_fen: 200n });
});

/** The real taobao snapshot port before any rule version is published: calls come back pending until seeded. */
function unseededTaobaoSnapshots(f: Pick<Flow, 'ctx' | 'userId' | 'clock'>) {
  const beneficiaries = createInMemoryBeneficiaryResolver([
    { appId: f.ctx.app_id, beneficiaries: threeParties(f.userId) },
  ]);
  const create = vi.fn<SnapshotPort['create']>((trx, input) =>
    createCommissionSnapshot(trx, input, {
      clock: f.clock,
      logger: { warn: vi.fn() },
      beneficiaries,
    }),
  );
  return { create };
}

it('[AC-B1-18c#16][BR-CALC-18] 重试分支：淘宝订单已归属、首次同步因缺规则版本进待处理（RULE_VERSION_PLATFORM_MISSING，补贴 NULL）→ 补上规则版本后再同步、报文补贴 200 → orders.subsidy_commission_fen=200，补偿重试的快照入参与 commission_splits.subsidy_commission_fen 为 200，raw_n_fen 仍是 est 789', async () => {
  const f = await fresh(db, {
    platform: 'taobao',
    attr_params: TAOBAO_RELATION,
    subsidy_commission_fen: null,
  });
  bindRelation(f);
  const port = unseededTaobaoSnapshots(f);
  expect(await runFresh(f, port)).toMatchObject(INSERTED);
  expect(port.create).toHaveBeenCalledTimes(1);
  const first = await f.read();
  expect(first.orders).toHaveLength(1);
  expect(first.orders[0]).toMatchObject({
    user_id: f.userId,
    platform_status: 'PAID',
    subsidy_commission_fen: null,
  });
  expect(first.pending).toEqual([
    expect.objectContaining({
      reason: 'RULE_VERSION_PLATFORM_MISSING',
      status: 'open',
      order_id: first.orders[0]!.order_id,
    }),
  ]);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);

  // 规则版本补上后再同步：已归属、已付，本次不是首次跨入快照资格，快照只经补偿重试生成。
  await seedVersion(db, f.ctx.app_id, version());
  f.clock.advanceMs(60_000);
  const updateDeps: OrderUpdateDeps = {
    ...f.deps,
    snapshots: port,
    rebate: { onUpdated: async () => {}, onUnmappedStatus: async () => {} },
    events: { publish: async () => ({ eventId: 'synthetic', duplicate: false }) },
  };
  const retrying = createOrderPipeline({
    ...f.deps,
    snapshots: port,
    updateStep: createOrderUpdateStep(updateDeps),
  });
  const later: UnionOrder = {
    ...f.incoming,
    subsidy_commission_fen: 200n,
    modified_at: at('2026-10-17T17:20:00Z'),
    raw_payload_id: '202',
  };
  expect(await capture(() => retrying.process(later, f.ctx))).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });

  expect(port.create).toHaveBeenCalledTimes(2);
  expect(port.create.mock.calls[1]?.[1]).toMatchObject({
    nBaseFen: 789n,
    subsidyCommissionFen: 200n,
  });
  const after = await f.read();
  expect(after.orders).toHaveLength(1);
  expect(after.orders[0]).toMatchObject({
    user_id: f.userId,
    subsidy_commission_fen: 200n,
    est_commission_fen: 789n,
  });
  expect(after.pending).toEqual([
    expect.objectContaining({ id: first.pending[0]!.id, status: 'resolved' }),
  ]);
  const rows = await splits(db, f.ctx.app_id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ raw_n_fen: 789n, subsidy_commission_fen: 200n });
});
