// BR-CALC-10/11/12/13/27 与任务 §9：验证写入端口，不扩展到订单触发器或真实身份解析器。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  CreateCommissionSnapshotInput,
  SnapshotBeneficiaries,
} from '../../../../apps/api/src/modules/commission/application/snapshot.ts';
import {
  beneficiaries,
  commission,
  CREATED_AT,
  dependencies,
  input,
  readRows,
  seedOrder,
  seedVersion,
  version,
} from './fixtures.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 5 });
}, 60_000);

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

const empty = { splits: [], amounts: [], events: [], totals: [] };

it('[AC-B2-03g#1] BR-CALC-10/27 快照、v1 金额、初始事件、四段金额同事务落库并保留元数据', async () => {
  const order = input({ activityType: 'synthetic-activity', paidAtSource: 'platform_modified' });
  const people = beneficiaries(order.ownerUserId);
  const f = dependencies(people);
  const v = version();
  await seedOrder(db, order);
  await seedVersion(db, order.appId, v);
  await db.transaction().execute(async (trx) => {
    const result = await commission.createCommissionSnapshot(trx, order, f.deps);
    expect(result.kind).toBe('created');
    const rows = await readRows(trx, order);
    expect(rows.splits).toHaveLength(1);
    expect(rows.splits[0]).toMatchObject({
      app_id: order.appId,
      order_id: order.orderId,
      rule_version_id: v.rule_version_id,
      order_type: 'self',
      activity_type: order.activityType,
      rebate_mode: null,
      paid_at: order.paidAt,
      paid_at_source: 'platform_modified',
      raw_n_fen: 1234n,
      subsidy_commission_fen: 0n,
      reserve_bp: 0,
      reserve_fen: 0n,
      tlj_deduct_fen: 0n,
      base_fen: 1234n,
      platform_retain_fen: 433n,
      created_at: CREATED_AT,
    });
    if (result.kind !== 'pending') expect(result.split).toEqual(rows.splits[0]);
    const expected = [
      { person: people.owner, role: 'self', ratio: 5000, amount: 617n },
      { person: people.direct!, role: 'direct', ratio: 1000, amount: 123n },
      { person: people.indirect!, role: 'indirect', ratio: 500, amount: 61n },
    ];
    expect(rows.splits[0]?.beneficiaries).toEqual(
      expected.map(({ person, role, ratio }) => ({
        user_id: person.userId,
        role,
        ratio_bp: ratio,
        level: person.level,
        initial_status: 'active',
        forfeit_reason: null,
      })),
    );
    expect(rows.amounts).toHaveLength(3);
    expect(rows.events).toHaveLength(3);
    for (const { person, role, amount } of expected) {
      expect(rows.amounts.find((r) => r.role === role)).toEqual({
        app_id: order.appId,
        order_id: order.orderId,
        commission_version: 1,
        user_id: person.userId,
        role,
        base_fen: 1234n,
        amount_fen: amount,
        created_at: CREATED_AT,
      });
      expect(rows.events.find((r) => r.role === role)).toMatchObject({
        app_id: order.appId,
        order_id: order.orderId,
        user_id: person.userId,
        role,
        status: 'active',
        reason: null,
        created_at: CREATED_AT,
      });
    }
    expect(rows.totals).toEqual([
      {
        app_id: order.appId,
        order_id: order.orderId,
        commission_version: 1,
        n_total_fen: 1234n,
        pre_base_deduct_fen: 0n,
        base_fen: 1234n,
        user_share_total_fen: 801n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 433n,
        subsidy_commission_fen: 0n,
        created_at: CREATED_AT,
      },
    ]);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(trx, {
      appId: order.appId,
      ownerUserId: order.ownerUserId,
      paidAt: order.paidAt,
    });
  });
});

it.each([
  {
    title: '边界前一秒',
    paidAt: '2026-11-01T00:00:00.999+08:00',
    effective: '2026-11-01T00:00:01+08:00',
    second: false,
  },
  {
    title: '边界等号',
    paidAt: '2026-11-01T00:00:01+08:00',
    effective: '2026-11-01T00:00:01+08:00',
    second: true,
  },
  {
    title: '同秒毫秒较早仍取新版',
    paidAt: '2026-11-01T00:00:01.001+08:00',
    effective: '2026-11-01T00:00:01.999+08:00',
    second: true,
  },
  {
    title: '等价 UTC 时刻',
    paidAt: '2026-10-31T16:00:01Z',
    effective: '2026-11-01T00:00:01+08:00',
    second: true,
  },
])(
  '[AC-B2-03g#2] BR-CALC-11 按 paid_at 秒精度选版：$title',
  async ({ paidAt, effective, second }) => {
    const order = input({ paidAt: new Date(paidAt) });
    const f = dependencies(beneficiaries(order.ownerUserId));
    const first = version();
    const next = version({ effective_from: new Date(effective) });
    // 非时间顺序入库，且 Clock 在多年以后：不能取插入顺序、最新发布或当前时刻。
    await seedOrder(db, order);
    await seedVersion(db, order.appId, next);
    await seedVersion(db, order.appId, first);
    await seedVersion(
      db,
      order.appId,
      version({ effective_from: new Date('2026-12-01T00:00:00+08:00') }),
    );
    const result = await db
      .transaction()
      .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
    expect(result.kind).toBe('created');
    expect(result.kind !== 'pending' && result.split.rule_version_id).toBe(
      second ? next.rule_version_id : first.rule_version_id,
    );
    expect(f.warn).not.toHaveBeenCalled();
  },
);

it('[AC-B2-03g#3] BR-CALC-11 早于首版取本 app 最早有效版并告警，排除草稿、撤销与其他 app', async () => {
  const order = input({ paidAt: new Date('2020-01-01T00:00:00+08:00') });
  const f = dependencies(beneficiaries(order.ownerUserId));
  const first = version();
  await seedOrder(db, order);
  await seedVersion(
    db,
    order.appId,
    version({ effective_from: new Date('2026-12-01T00:00:00+08:00') }),
  );
  await seedVersion(db, order.appId, first);
  for (const status of ['draft', 'revoked'] as const) {
    await seedVersion(
      db,
      order.appId,
      version({ effective_from: new Date('2019-01-01T00:00:00+08:00') }),
      status,
    );
  }
  await seedVersion(
    db,
    order.appId,
    version({ effective_from: new Date('2018-01-01T00:00:00+08:00') }),
    'published',
    CREATED_AT,
  );
  await seedVersion(
    db,
    `${order.appId}-other`,
    version({ effective_from: new Date('2017-01-01T00:00:00+08:00') }),
  );
  const result = await db
    .transaction()
    .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
  expect(result.kind).toBe('created');
  expect(result.kind !== 'pending' && result.split.rule_version_id).toBe(first.rule_version_id);
  expect(f.warn).toHaveBeenCalled();
});

it('[AC-B2-03g#4] BR-CALC-11 正常选版忽略更晚的草稿、撤销版和其他 app', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  const v = version();
  await seedOrder(db, order);
  await seedVersion(db, order.appId, v);
  const later = new Date('2026-10-19T00:00:00+08:00');
  await seedVersion(db, order.appId, version({ effective_from: later }), 'draft');
  await seedVersion(db, order.appId, version({ effective_from: later }), 'revoked', later);
  await seedVersion(db, order.appId, version({ effective_from: later }), 'published', later);
  await seedVersion(db, `${order.appId}-other`, version({ effective_from: later }));
  const result = await db
    .transaction()
    .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
  expect(result.kind).toBe('created');
  expect(result.kind !== 'pending' && result.split.rule_version_id).toBe(v.rule_version_id);
});

it.each([
  'no-version',
  'platform-rules',
  'owner-level',
  'direct-level',
  'indirect-level',
  'reserve',
] as const)(
  '[AC-B2-03g#5] BR-CALC-10/11 缺 %s 返回 pending、告警且四表零写入，不向旧版借配置',
  async (missing) => {
    const order = input();
    const f = dependencies(beneficiaries(order.ownerUserId));
    await seedOrder(db, order);
    if (missing !== 'no-version') {
      await seedVersion(db, order.appId, version());
      const v = version({ effective_from: new Date('2026-10-15T00:00:00+08:00') });
      const missingLevel = { 'owner-level': 'L1', 'direct-level': 'L2', 'indirect-level': 'L3' };
      const level =
        missing in missingLevel ? missingLevel[missing as keyof typeof missingLevel] : undefined;
      await seedVersion(db, order.appId, {
        ...v,
        rules: v.rules.filter(
          (r) =>
            r.platform !== order.platform ||
            (missing !== 'platform-rules' &&
              !(r.level === level && r.order_type === order.orderType)),
        ),
        reserves: v.reserves.filter((r) => missing !== 'reserve' || r.platform !== order.platform),
      });
    } else {
      // 别的 app 有完整版本也不能用于本 app。
      await seedVersion(db, `${order.appId}-other`, version());
      await seedVersion(db, order.appId, version(), 'draft');
      await seedVersion(db, order.appId, version(), 'revoked');
    }
    await db.transaction().execute(async (trx) => {
      const result = await commission.createCommissionSnapshot(trx, order, f.deps);
      expect(result.kind).toBe('pending');
      expect(result.kind === 'pending' && result.reason.length > 0).toBe(true);
      expect(await readRows(trx, order)).toEqual(empty);
      expect(f.warn).toHaveBeenCalled();
    });
    expect(await readRows(db, order)).toEqual(empty);
  },
);

it('[AC-B2-03g#6] BR-CALC-11 同秒两个候选版本必须报错，不任取一版', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  await seedOrder(db, order);
  for (const ms of ['001', '999']) {
    await seedVersion(
      db,
      order.appId,
      version({ effective_from: new Date(`2026-10-01T00:00:00.${ms}+08:00`) }),
    );
  }
  const error: unknown = await db
    .transaction()
    .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps))
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  // 不能让只抛 NotImplemented 的骨架意外满足负测。
  expect((error as Error).message).not.toMatch(/NotImplemented/);
  expect(await readRows(db, order)).toEqual(empty);
});

interface MoneyCase {
  name: string;
  patch: Partial<CreateCommissionSnapshotInput>;
  reserve: number;
  base: bigint;
  reserveFen: bigint;
  own: bigint;
  direct: bigint;
  total: bigint;
  deduct: bigint;
  redpacket: bigint | null;
  profit: bigint | null;
}

// 独立手算的 BR-CALC-27 算例，不调用生产 splitCommission 生成期望值。
const moneyCases: MoneyCase[] = [
  {
    name: '普通单逐份向下取整',
    patch: {},
    reserve: 0,
    base: 1234n,
    reserveFen: 0n,
    own: 617n,
    direct: 123n,
    total: 1234n,
    deduct: 0n,
    redpacket: 0n,
    profit: 494n,
  },
  {
    name: '平台预留',
    patch: { nBaseFen: 1000n },
    reserve: 1500,
    base: 850n,
    reserveFen: 150n,
    own: 425n,
    direct: 85n,
    total: 1000n,
    deduct: 150n,
    redpacket: 0n,
    profit: 490n,
  },
  {
    name: '预留含尾差',
    patch: { nBaseFen: 1234n },
    reserve: 1500,
    base: 1048n,
    reserveFen: 186n,
    own: 524n,
    direct: 104n,
    total: 1234n,
    deduct: 186n,
    redpacket: 0n,
    profit: 606n,
  },
  {
    name: '补贴不进基数',
    patch: { nBaseFen: 800n, subsidyCommissionFen: 200n },
    reserve: 0,
    base: 800n,
    reserveFen: 0n,
    own: 400n,
    direct: 80n,
    total: 1000n,
    deduct: 200n,
    redpacket: 0n,
    profit: 520n,
  },
  {
    name: '淘礼金 none',
    patch: { nBaseFen: 500n, rebateMode: 'none', tljRedpacketFen: 300n },
    reserve: 0,
    base: 500n,
    reserveFen: 0n,
    own: 0n,
    direct: 0n,
    total: 500n,
    deduct: 0n,
    redpacket: 300n,
    profit: 200n,
  },
  {
    name: '淘礼金 normal',
    patch: { nBaseFen: 500n, rebateMode: 'normal', tljDeductFen: 300n, tljRedpacketFen: 300n },
    reserve: 0,
    base: 200n,
    reserveFen: 0n,
    own: 100n,
    direct: 20n,
    total: 500n,
    deduct: 300n,
    redpacket: 300n,
    profit: 80n,
  },
  {
    name: '净扣红包不重复扣利润',
    patch: { nBaseFen: 200n, rebateMode: 'normal', tljRedpacketFen: 0n },
    reserve: 0,
    base: 200n,
    reserveFen: 0n,
    own: 100n,
    direct: 20n,
    total: 200n,
    deduct: 0n,
    redpacket: 0n,
    profit: 80n,
  },
  {
    name: '淘礼金未匹配双 null',
    patch: { nBaseFen: 500n, rebateMode: 'normal', tljRedpacketFen: null },
    reserve: 0,
    base: 500n,
    reserveFen: 0n,
    own: 250n,
    direct: 50n,
    total: 500n,
    deduct: 0n,
    redpacket: null,
    profit: null,
  },
  {
    name: '非淘礼金红包按零',
    patch: { tljRedpacketFen: null },
    reserve: 0,
    base: 1234n,
    reserveFen: 0n,
    own: 617n,
    direct: 123n,
    total: 1234n,
    deduct: 0n,
    redpacket: 0n,
    profit: 494n,
  },
  {
    name: '负 N 冲正',
    patch: { nBaseFen: -320n },
    reserve: 1500,
    base: 0n,
    reserveFen: 0n,
    own: 0n,
    direct: 0n,
    total: -320n,
    deduct: -320n,
    redpacket: 0n,
    profit: -320n,
  },
  {
    name: '零基数仍落完整 v1',
    patch: { nBaseFen: 0n },
    reserve: 0,
    base: 0n,
    reserveFen: 0n,
    own: 0n,
    direct: 0n,
    total: 0n,
    deduct: 0n,
    redpacket: 0n,
    profit: 0n,
  },
  {
    name: '红包大于佣金允许负利润',
    patch: { nBaseFen: 100n, rebateMode: 'normal', tljDeductFen: 300n, tljRedpacketFen: 300n },
    reserve: 0,
    base: 0n,
    reserveFen: 0n,
    own: 0n,
    direct: 0n,
    total: 100n,
    deduct: 100n,
    redpacket: 300n,
    profit: -200n,
  },
  {
    name: '大于 JS 安全整数仍精确',
    patch: { nBaseFen: 9007199254740993n },
    reserve: 0,
    base: 9007199254740993n,
    reserveFen: 0n,
    own: 4503599627370496n,
    direct: 900719925474099n,
    total: 9007199254740993n,
    deduct: 0n,
    redpacket: 0n,
    profit: 3602879701896398n,
  },
];

it.each(moneyCases)('[AC-B2-03g#7] BR-CALC-27 四段金额：$name', async (c) => {
  const order = input(c.patch);
  const f = dependencies(beneficiaries(order.ownerUserId));
  const v = version({ indirect_enabled: false });
  await seedOrder(db, order);
  await seedVersion(db, order.appId, {
    ...v,
    rules: v.rules.map((r) => ({ ...r, r_indirect_bp: 0 })),
    reserves: v.reserves.map((r) => ({ ...r, reserve_bp: c.reserve })),
  });
  const result = await db
    .transaction()
    .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
  expect(result.kind).toBe('created');
  const rows = await readRows(db, order);
  expect(rows.splits).toHaveLength(1);
  expect(rows.splits[0]).toMatchObject({
    raw_n_fen: order.nBaseFen,
    subsidy_commission_fen: order.subsidyCommissionFen,
    rebate_mode: order.rebateMode,
    tlj_deduct_fen: order.tljDeductFen,
    reserve_bp: c.reserve,
    reserve_fen: c.reserveFen,
    base_fen: c.base,
    platform_retain_fen: c.base - c.own - c.direct,
  });
  expect(rows.amounts).toHaveLength(2);
  expect(rows.amounts.find((r) => r.role === 'self')?.amount_fen).toBe(c.own);
  expect(rows.amounts.find((r) => r.role === 'direct')?.amount_fen).toBe(c.direct);
  for (const row of rows.amounts) {
    expect(row.base_fen).toBe(c.base);
    expect(row.commission_version).toBe(1);
  }
  expect(rows.events).toHaveLength(2);
  expect(rows.totals).toHaveLength(1);
  expect(rows.totals[0]).toMatchObject({
    commission_version: 1,
    n_total_fen: c.total,
    pre_base_deduct_fen: c.deduct,
    base_fen: c.base,
    user_share_total_fen: c.own + c.direct,
    tlj_redpacket_fen: c.redpacket,
    platform_est_profit_fen: c.profit,
  });
  if (c.redpacket === null) expect(f.warn).toHaveBeenCalled();
});

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B2-03g#8] BR-CALC-12 按 %s 与各受益人 paid_at 等级分别取 share 三比例',
  async (platform) => {
    const order = input({ platform, orderType: 'share', paidAtSource: 'observed' });
    const people = beneficiaries(order.ownerUserId);
    const f = dependencies(people);
    const v = version();
    await seedOrder(db, order);
    await seedVersion(db, order.appId, {
      ...v,
      rules: v.rules.map((r) => ({
        ...r,
        r_own_bp:
          r.platform === platform && r.order_type === 'share' && r.level === 'L1' ? 4000 : 2000,
        r_direct_bp:
          r.platform === platform && r.order_type === 'share' && r.level === 'L2' ? 1500 : 700,
        r_indirect_bp:
          r.platform === platform && r.order_type === 'share' && r.level === 'L3' ? 800 : 200,
      })),
      reserves: v.reserves.map((r) => ({
        ...r,
        reserve_bp: r.platform === platform ? 1500 : 8000,
      })),
    });
    await db
      .transaction()
      .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
    const rows = await readRows(db, order);
    expect(rows.amounts.map((r) => [r.role, r.amount_fen])).toEqual([
      ['direct', 157n],
      ['indirect', 83n],
      ['share', 419n],
    ]);
    expect(rows.splits[0]).toMatchObject({
      paid_at_source: 'observed',
      reserve_bp: 1500,
      base_fen: 1048n,
      platform_retain_fen: 389n,
    });
    expect(rows.splits[0]?.beneficiaries).toEqual([
      {
        user_id: people.owner.userId,
        role: 'share',
        ratio_bp: 4000,
        level: 'L1',
        initial_status: 'active',
        forfeit_reason: null,
      },
      {
        user_id: people.direct!.userId,
        role: 'direct',
        ratio_bp: 1500,
        level: 'L2',
        initial_status: 'active',
        forfeit_reason: null,
      },
      {
        user_id: people.indirect!.userId,
        role: 'indirect',
        ratio_bp: 800,
        level: 'L3',
        initial_status: 'active',
        forfeit_reason: null,
      },
    ]);
  },
);

it.each(['owner', 'direct', 'indirect'] as const)(
  '[AC-B2-03g#9] BR-CALC-13 %s forfeited 归平台，其他受益人不承接份额',
  async (role) => {
    const order = input();
    const initial = beneficiaries(order.ownerUserId);
    const people: SnapshotBeneficiaries = {
      ...initial,
      [role]: { ...initial[role]!, status: 'forfeited', forfeitReason: 'deleted' },
    };
    const f = dependencies(people);
    await seedOrder(db, order);
    await seedVersion(db, order.appId, version());
    await db
      .transaction()
      .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
    const rows = await readRows(db, order);
    const amounts = {
      self: role === 'owner' ? 0n : 617n,
      direct: role === 'direct' ? 0n : 123n,
      indirect: role === 'indirect' ? 0n : 61n,
    };
    expect(rows.amounts).toHaveLength(3);
    for (const [r, amount] of Object.entries(amounts))
      expect(rows.amounts.find((a) => a.role === r)?.amount_fen).toBe(amount);
    const forfeitedRole = role === 'owner' ? 'self' : role;
    expect(rows.events).toHaveLength(3);
    expect(rows.events.find((e) => e.role === forfeitedRole)).toMatchObject({
      status: 'forfeited',
      reason: 'deleted',
    });
    expect(rows.events.filter((e) => e.role !== forfeitedRole).map((e) => e.status)).toEqual([
      'active',
      'active',
    ]);
    expect(rows.splits[0]?.beneficiaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: people[role]!.userId,
          role: forfeitedRole,
          initial_status: 'forfeited',
          forfeit_reason: 'deleted',
          ratio_bp: role === 'owner' ? 5000 : role === 'direct' ? 1000 : 500,
        }),
      ]),
    );
    const total = amounts.self + amounts.direct + amounts.indirect;
    expect(rows.splits[0]?.platform_retain_fen).toBe(1234n - total);
    expect(rows.totals[0]).toMatchObject({
      user_share_total_fen: total,
      platform_est_profit_fen: 1234n - total,
    });
  },
);

it.each(['none', 'direct-only', 'indirect-without-direct'] as const)(
  '[AC-B2-03g#10] BR-CALC-12 paid_at 关系缺层不补发：%s',
  async (shape) => {
    const order = input();
    const initial = beneficiaries(order.ownerUserId);
    const people = {
      ...initial,
      direct: shape === 'direct-only' ? initial.direct : null,
      indirect: shape === 'indirect-without-direct' ? initial.indirect : null,
    };
    const f = dependencies(people);
    await seedOrder(db, order);
    await seedVersion(db, order.appId, version());
    await db
      .transaction()
      .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
    const rows = await readRows(db, order);
    expect(rows.amounts.map((r) => [r.role, r.amount_fen])).toEqual(
      shape === 'direct-only'
        ? [
            ['direct', 123n],
            ['self', 617n],
          ]
        : [['self', 617n]],
    );
    expect(rows.events).toHaveLength(shape === 'direct-only' ? 2 : 1);
    expect(rows.splits[0]?.platform_retain_fen).toBe(shape === 'direct-only' ? 494n : 617n);
  },
);

it('[AC-B2-03g#11] BR-CALC-12 解析器返回的 L1 与逐条告警被保留，不查询当前等级替换', async () => {
  const order = input();
  const initial = beneficiaries(order.ownerUserId);
  const people = {
    ...initial,
    direct: { ...initial.direct!, level: 'L1' as const },
    warnings: [
      { code: 'OWNER_LEVEL_LOG_MISSING', userId: order.ownerUserId },
      { code: 'DIRECT_LEVEL_LOG_MISSING', userId: initial.direct!.userId },
    ],
  };
  const f = dependencies(people);
  await seedOrder(db, order);
  await seedVersion(db, order.appId, version());
  await db.transaction().execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
  expect(f.warn).toHaveBeenCalledTimes(2);
  const warnings = JSON.stringify(f.warn.mock.calls);
  for (const warning of people.warnings) expect(warnings).toContain(warning.code);
  const rows = await readRows(db, order);
  expect(rows.splits[0]?.beneficiaries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'self', level: 'L1' }),
      expect.objectContaining({ role: 'direct', level: 'L1' }),
    ]),
  );
});

it('[AC-B2-03g#12] BR-CALC-10 重放返回原快照；新版、金额、关系与时钟变化均不重写任何行', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  await seedOrder(db, order);
  await seedVersion(db, order.appId, version());
  const first = await db
    .transaction()
    .execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
  expect(first.kind).toBe('created');
  const before = await readRows(db, order);
  await seedVersion(
    db,
    order.appId,
    version({ effective_from: new Date('2026-10-19T00:00:00+08:00') }),
  );
  f.clock.set('2040-01-01T00:00:00+08:00');
  f.resolve.mockRejectedValue(new Error('replay must not resolve beneficiaries again'));
  const changed = {
    ...order,
    ownerUserId: randomUUID(),
    paidAt: new Date('2039-01-01T00:00:00+08:00'),
    paidAtSource: 'observed' as const,
    nBaseFen: 99999n,
    orderType: 'share' as const,
    activityType: 'changed',
    rebateMode: 'none' as const,
  };
  const replay = await db
    .transaction()
    .execute((trx) => commission.createCommissionSnapshot(trx, changed, f.deps));
  expect(replay.kind).toBe('existing');
  expect(replay.kind !== 'pending' && replay.split).toEqual(before.splits[0]);
  expect(await readRows(db, order)).toEqual(before);
  expect(f.resolve).toHaveBeenCalledTimes(1);
});

it('[AC-B2-03g#13] BR-CALC-10 同一调用方事务内重放也只生成一次', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  await seedOrder(db, order);
  await seedVersion(db, order.appId, version());
  await db.transaction().execute(async (trx) => {
    const first = await commission.createCommissionSnapshot(trx, order, f.deps);
    const before = await readRows(trx, order);
    const second = await commission.createCommissionSnapshot(trx, order, f.deps);
    expect([first.kind, second.kind]).toEqual(['created', 'existing']);
    expect(second.kind !== 'pending' && second.split).toEqual(before.splits[0]);
    expect(await readRows(trx, order)).toEqual(before);
  });
});

it('[AC-B2-03g#14] BR-CALC-10 调用方回滚时四表全部消失，写入器不另开事务', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  await seedOrder(db, order);
  await seedVersion(db, order.appId, version());
  const rollback = new Error('caller rolls back');
  await expect(
    db.transaction().execute(async (trx) => {
      const result = await commission.createCommissionSnapshot(trx, order, f.deps);
      expect(result.kind).toBe('created');
      expect((await readRows(trx, order)).amounts).toHaveLength(3);
      expect(await readRows(db, order)).toEqual(empty);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await readRows(db, order)).toEqual(empty);
});

it('[AC-B2-03g#15] BR-CALC-10/11 能读到调用方未提交的订单键与规则行', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  const v = version();
  await db.transaction().execute(async (trx) => {
    await seedOrder(trx, order);
    await seedVersion(trx, order.appId, v);
    const result = await commission.createCommissionSnapshot(trx, order, f.deps);
    expect(result.kind).toBe('created');
    expect(result.kind !== 'pending' && result.split.rule_version_id).toBe(v.rule_version_id);
    expect((await readRows(trx, order)).totals).toHaveLength(1);
  });
});

it('[AC-B2-03g#16] BR-CALC-10 并发重放只一份四表记录，失败竞争者仍能在原事务继续查询', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  await seedOrder(db, order);
  await seedVersion(db, order.appId, version());
  // 两个独立连接都 BEGIN 后一起放行，不在解析器中设屏障（允许实现先锁订单）。
  let arrivals = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = () =>
    db.transaction().execute(async (trx) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothStarted;
      const result = await commission.createCommissionSnapshot(trx, order, f.deps);
      expect((await sql<{ ok: number }>`select 1 as ok`.execute(trx)).rows).toEqual([{ ok: 1 }]);
      return result;
    });
  const results = await Promise.all([write(), write()]);
  expect(results.map((r) => r.kind).sort()).toEqual(['created', 'existing']);
  const rows = await readRows(db, order);
  expect(rows.splits).toHaveLength(1);
  expect(rows.amounts).toHaveLength(3);
  expect(rows.events).toHaveLength(3);
  expect(rows.totals).toHaveLength(1);
  for (const result of results)
    expect(result.kind !== 'pending' && result.split).toEqual(rows.splits[0]);
});

it('[AC-B2-03g#17] BR-CALC-11 所选版本在调用方提交前持有共享行锁，与撤销互斥', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  const v = version();
  await seedOrder(db, order);
  await seedVersion(db, order.appId, v);
  await db.transaction().execute(async (trx) => {
    const result = await commission.createCommissionSnapshot(trx, order, f.deps);
    expect(result.kind).toBe('created');
    // FOR NO KEY UPDATE 与外键带来的 KEY SHARE 兼容，却与任务要求的 SHARE 冲突。
    // 因此不能只依赖快照外键碰巧加上的锁；NOWAIT 保证不靠超时或 sleep 判断。
    await expect(
      db
        .transaction()
        .execute((other) =>
          other
            .withSchema('app')
            .selectFrom('commission_rule_versions')
            .select('rule_version_id')
            .where('app_id', '=', order.appId)
            .where('rule_version_id', '=', v.rule_version_id)
            .forNoKeyUpdate()
            .noWait()
            .execute(),
        ),
    ).rejects.toMatchObject({ code: '55P03' });
  });
  await expect(
    db
      .transaction()
      .execute((trx) =>
        trx
          .withSchema('app')
          .selectFrom('commission_rule_versions')
          .select('rule_version_id')
          .where('app_id', '=', order.appId)
          .where('rule_version_id', '=', v.rule_version_id)
          .forNoKeyUpdate()
          .noWait()
          .execute(),
      ),
  ).resolves.toHaveLength(1);
});

it('[AC-B2-03g#18] BR-CALC-10 app_id 不同不能读回其他 app 的已有快照', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  await seedOrder(db, order);
  await seedVersion(db, order.appId, version());
  await db.transaction().execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps));
  const before = await readRows(db, order);
  const foreign = { ...order, appId: `${order.appId}-other` };
  const outcome: unknown = await db
    .transaction()
    .execute((trx) => commission.createCommissionSnapshot(trx, foreign, f.deps))
    .catch((e: unknown) => e);
  // 无本 app 版本可 pending；显式拒绝租户不匹配也可，绝不能返回 created/existing 泄露快照。
  expect(
    outcome instanceof Error ||
      (typeof outcome === 'object' &&
        outcome !== null &&
        'kind' in outcome &&
        outcome.kind === 'pending'),
  ).toBe(true);
  expect(await readRows(db, order)).toEqual(before);
  expect(await readRows(db, foreign)).toEqual(empty);
});

it('[AC-B2-03g#19] BR-CALC-12 解析器失败不以当前用户或默认关系生成半份快照', async () => {
  const order = input();
  const f = dependencies(beneficiaries(order.ownerUserId));
  const failure = new Error('synthetic beneficiary resolver unavailable');
  f.resolve.mockRejectedValue(failure);
  await seedOrder(db, order);
  await seedVersion(db, order.appId, version());
  await expect(
    db.transaction().execute((trx) => commission.createCommissionSnapshot(trx, order, f.deps)),
  ).rejects.toBe(failure);
  expect(await readRows(db, order)).toEqual(empty);
});
