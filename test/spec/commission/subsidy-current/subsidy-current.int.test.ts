// B1-18f · 合计表补贴列与「新版本取订单当时补贴」（BR-CALC-27 细则「仅补贴变化的版本」末句与存储、BR-CALC-15；
// D10-1258 / D10-1259）。迁移 0138 给 commission_split_totals 加 subsidy_commission_fen（bigint，可空）；快照 v1 记冻结
// 补贴；N 变化写的新版本取写入时 orders.subsidy_commission_fen（空当 0），n_total = N + 当时补贴，各方份额与 base 仍按 N
// 与冻结比例，不受补贴影响；「N 是否变化」用 n_total − 该版本合计行的补贴（列为空的旧行回退快照冻结补贴）。
// 本单不改版本触发条件：补贴单独变化不推版本（B1-18i）。
// 列是新加的：先查 information_schema，值经 selectAll 读，缺列时以断言失败出现，不以 SQL 报错出现。
// 默认单（estimate-port kit）：预留 1500，self 5000 / direct 1000 / indirect 500，快照 N 1000。
// 手算：N 1000 → B 850 → 425 / 85 / 42，合计 552；N 2000 → B 1700 → 850 / 170 / 85，合计 1105；
// N 3000 → B 2550 → 1275 / 255 / 127，合计 1657；N 600 → B 510 → 255 / 51 / 25，合计 331。
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  TIMEOUT,
  amountsAt,
  databaseFixture,
  fixture,
  moneyRows,
  orderRow,
  snapshotPortOf,
  storedVersions,
  type PortOrder,
} from '../estimate-port/kit.ts';
import { portHarness } from '../version-rule/kit.ts';
import {
  beneficiaries,
  commission as snapshotEntry,
  dependencies,
  input,
  seedOrder,
  seedVersion,
  version as ruleVersion,
} from '../snapshot/fixtures.ts';

const p = databaseFixture(createTestDatabase);

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** app.commission_split_totals.subsidy_commission_fen 的列定义；没有这一列时是空数组。 */
async function subsidyColumn(db: Kysely<DB>) {
  const { rows } = await sql<{
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>`select data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'app' and table_name = 'commission_split_totals'
      and column_name = 'subsidy_commission_fen'`.execute(db);
  return rows;
}

/** 合计行的补贴列；库里没有这一列时读出 undefined（断言失败，不是 SQL 报错）。 */
function subsidyOf(row: object): unknown {
  return Reflect.get(row, 'subsidy_commission_fen');
}

/** 该单每个版本的合计行（四段金额与补贴列），版本升序。 */
async function totalsWithSubsidy(db: Kysely<DB>, appId: string, orderId: string) {
  const rows = await db
    .selectFrom('commission_split_totals')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .orderBy('commission_version')
    .execute();
  return rows.map((row) => ({
    commission_version: row.commission_version,
    n_total_fen: row.n_total_fen,
    pre_base_deduct_fen: row.pre_base_deduct_fen,
    base_fen: row.base_fen,
    user_share_total_fen: row.user_share_total_fen,
    tlj_redpacket_fen: row.tlj_redpacket_fen,
    platform_est_profit_fen: row.platform_est_profit_fen,
    subsidy_commission_fen: subsidyOf(row),
  }));
}

async function totalsAtVersion(o: PortOrder, version: number) {
  return (await totalsWithSubsidy(p.db, o.appId, o.orderId)).find(
    (row) => row.commission_version === version,
  );
}

/** 订单当前的补贴类佣金：只改这一列，不推版本（补贴单独变化推版本属 B1-18i）。 */
async function setCurrentSubsidy(o: PortOrder, fen: bigint | null): Promise<void> {
  await p.db
    .updateTable('orders')
    .set({ subsidy_commission_fen: fen })
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .execute();
}

/** 只把 orders.commission_version 推到 version（R7 由 rebate 推版本，这里手写）。 */
async function setOrderVersion(o: PortOrder, version: number): Promise<void> {
  await p.db
    .updateTable('orders')
    .set({ commission_version: version })
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .execute();
}

/** R7 维权重定价问的那一句：以 N 调 bases（compareN），N 与最新版本存的 N 是否不同。 */
async function nChanged(f: Fixture, o: PortOrder, n: bigint) {
  const bases = await p.db.transaction().execute((trx) =>
    f.estimates.bases(trx, {
      appId: o.appId,
      orderId: o.orderId,
      attrAt: o.attrAt,
      estBefore: n,
      estAfter: n,
      settleCommissionFen: null,
      compareN: true,
    }),
  );
  return bases.nChanged;
}

/** R7 的 refresh：在持订单锁的事务里带 { commissionFen }。 */
async function refreshWithValue(f: Fixture, o: PortOrder, commissionFen: bigint): Promise<void> {
  await p.db.transaction().execute(async (trx) => {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    await f.estimates.refresh(
      trx,
      { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt },
      { commissionFen },
    );
  });
}

it(
  '[AC-B1-18f#1][BR-CALC-27] 迁移后合计表有补贴列：bigint、可空、无默认值（空 = 加列前写的旧行）',
  async () => {
    expect(await subsidyColumn(p.db), 'commission_split_totals.subsidy_commission_fen').toEqual([
      { data_type: 'bigint', is_nullable: 'YES', column_default: null },
    ]);
  },
  TIMEOUT,
);

it.each([
  {
    name: '补贴 200',
    subsidy: 200n,
    // n_base 800、补贴 200、预留 0：① 1000 ② 200 ③ 800，用户 400 + 80 + 40 = 520，④ 480。
    totals: { n: 1000n, pre: 200n, profit: 480n },
  },
  {
    name: '补贴 0',
    subsidy: 0n,
    // ① 800 ② 0 ③ 800，用户 520，④ 280；补贴列记 0，不是空。
    totals: { n: 800n, pre: 0n, profit: 280n },
  },
])(
  '[AC-B1-18f#2][BR-CALC-27][BR-CALC-10] 快照 v1 的合计行补贴列等于快照冻结补贴（$name）',
  async ({ subsidy, totals }) => {
    expect(await subsidyColumn(p.db), '前置：补贴列已迁移').toHaveLength(1);
    const order = input({ nBaseFen: 800n, subsidyCommissionFen: subsidy });
    const f = dependencies(beneficiaries(order.ownerUserId));
    await seedOrder(p.db, order);
    await seedVersion(p.db, order.appId, ruleVersion());

    await p.db.transaction().execute(async (trx) => {
      const result = await snapshotEntry.createCommissionSnapshot(trx, order, f.deps);
      expect(result.kind).toBe('created');
    });

    const split = await p.db
      .selectFrom('commission_splits')
      .select(['subsidy_commission_fen'])
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .executeTakeFirstOrThrow();
    expect(split.subsidy_commission_fen).toBe(subsidy);
    expect(await totalsWithSubsidy(p.db, order.appId, order.orderId)).toEqual([
      {
        commission_version: 1,
        n_total_fen: totals.n,
        pre_base_deduct_fen: totals.pre,
        base_fen: 800n,
        user_share_total_fen: 520n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: totals.profit,
        subsidy_commission_fen: subsidy,
      },
    ]);
  },
  TIMEOUT,
);

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B1-18f#3][BR-CALC-27][BR-CALC-15] %s：v1 冻结补贴 111、订单当前补贴 350，N 变 2000 → v2 用 350（不是 111），n_total 2350；份额与 base 只按 N 与冻结比例',
  async (rebateStatus) => {
    const f = await fixture(p.db);
    const o = await f.order({
      rebateStatus,
      subsidyFen: 111n,
      patch: { subsidy_commission_fen: 350n },
    });
    await f.move(o, { estAfter: 2000n });

    await f.refresh(o);

    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 1700n, 850n],
      ['direct', 1700n, 170n],
      ['indirect', 1700n, 85n],
    ]);
    // ① 2000 + 350；② 2350 − 1700；④ 2350 − 1105 − 0。
    expect(await totalsAtVersion(o, 2)).toEqual({
      commission_version: 2,
      n_total_fen: 2350n,
      pre_base_deduct_fen: 650n,
      base_fen: 1700n,
      user_share_total_fen: 1105n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 1245n,
      subsidy_commission_fen: 350n,
    });
    // 上一版本原样留着：只追加，不回写。
    expect(await amountsAt(p.db, o, 1)).toEqual([
      ['self', 850n, 425n],
      ['direct', 850n, 85n],
      ['indirect', 850n, 42n],
    ]);
    expect(await totalsAtVersion(o, 1)).toMatchObject({ n_total_fen: 1111n, base_fen: 850n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18f#4][BR-CALC-15][BR-CALC-27] storedN 用该版本合计行的补贴：v2（N 2000、补贴 350）之后同 N 不判变化，订单补贴再变也不影响判断；旧行（列为空）回退快照冻结补贴；此后 N 变写 v3 取当时补贴',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({ subsidyFen: 111n, patch: { subsidy_commission_fen: 350n } });

    // v1 是加列前那种行（kit 不写补贴列）：判断回退快照冻结补贴 111，不用订单当前的 350。
    expect(await totalsAtVersion(o, 1)).toMatchObject({
      n_total_fen: 1111n,
      subsidy_commission_fen: null,
    });
    expect(await nChanged(f, o, 1000n)).toBe(false);
    expect(await nChanged(f, o, 761n)).toBe(true);

    await f.move(o, { estAfter: 2000n });
    await f.refresh(o);
    expect(await totalsAtVersion(o, 2), '前置：v2 用订单当时补贴 350').toMatchObject({
      n_total_fen: 2350n,
      subsidy_commission_fen: 350n,
    });

    // 2350 − 350 = 2000：同 N 不是变化（按冻结 111 算成 2239 就会误判）。
    expect(await nChanged(f, o, 2000n)).toBe(false);
    expect(await nChanged(f, o, 2239n)).toBe(true);
    expect(await nChanged(f, o, 2001n)).toBe(true);

    // 订单当前补贴变成 400（不推版本）：判断仍用 v2 合计行记的 350。
    await setCurrentSubsidy(o, 400n);
    expect(await nChanged(f, o, 2000n)).toBe(false);
    expect(await nChanged(f, o, 1950n)).toBe(true);
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });

    // 此后 N 变写 v3：取写入时订单的补贴 400，不回到冻结值 111，也不沿用 v2 的 350。
    await f.move(o, { estAfter: 3000n });
    await f.refresh(o);
    expect(await amountsAt(p.db, o, 3)).toEqual([
      ['self', 2550n, 1275n],
      ['direct', 2550n, 255n],
      ['indirect', 2550n, 127n],
    ]);
    expect(await totalsAtVersion(o, 3)).toEqual({
      commission_version: 3,
      n_total_fen: 3400n,
      pre_base_deduct_fen: 850n,
      base_fen: 2550n,
      user_share_total_fen: 1657n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 1743n,
      subsidy_commission_fen: 400n,
    });
    expect(await nChanged(f, o, 3000n)).toBe(false);
    // 前面的版本不动。
    expect(await totalsAtVersion(o, 2)).toMatchObject({
      n_total_fen: 2350n,
      subsidy_commission_fen: 350n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18f#5][BR-CALC-15][BR-CALC-27] R7 带 { commissionFen } 的 refresh 也取订单当时补贴；同 N 再问不判变化，同版本重放不再写',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({ subsidyFen: 111n, patch: { subsidy_commission_fen: 350n } });
    await setOrderVersion(o, 2);

    await refreshWithValue(f, o, 600n);

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 510n, 255n],
      ['direct', 510n, 51n],
      ['indirect', 510n, 25n],
    ]);
    // ① 600 + 350；② 950 − 510；④ 950 − 331。
    expect(await totalsAtVersion(o, 2)).toEqual({
      commission_version: 2,
      n_total_fen: 950n,
      pre_base_deduct_fen: 440n,
      base_fen: 510n,
      user_share_total_fen: 331n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 619n,
      subsidy_commission_fen: 350n,
    });
    expect(await nChanged(f, o, 600n)).toBe(false);

    const before = await totalsWithSubsidy(p.db, o.appId, o.orderId);
    await refreshWithValue(f, o, 600n);
    expect(await totalsWithSubsidy(p.db, o.appId, o.orderId)).toEqual(before);
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18f#6][BR-CALC-27] orders 快照步的端口 refresh（settleVersion 走的那条）同样取订单当时补贴',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({ subsidyFen: 111n, patch: { subsidy_commission_fen: 350n } });
    await f.move(o, { estAfter: 2000n });
    const port = snapshotPortOf(f.clock, o.appId, o.user('self'));

    await p.db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      await port.refresh(trx, { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt });
    });

    expect(await totalsAtVersion(o, 2)).toEqual({
      commission_version: 2,
      n_total_fen: 2350n,
      pre_base_deduct_fen: 650n,
      base_fen: 1700n,
      user_share_total_fen: 1105n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 1245n,
      subsidy_commission_fen: 350n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18f#7][BR-CALC-27][BR-CALC-18] 订单当前补贴为空当 0：v2 补贴列记 0，n_total 就是 N；同 N 不判变化',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({ subsidyFen: 111n, patch: { subsidy_commission_fen: null } });
    await f.move(o, { estAfter: 2000n });

    await f.refresh(o);

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 1700n, 850n],
      ['direct', 1700n, 170n],
      ['indirect', 1700n, 85n],
    ]);
    expect(await totalsAtVersion(o, 2)).toEqual({
      commission_version: 2,
      n_total_fen: 2000n,
      pre_base_deduct_fen: 300n,
      base_fen: 1700n,
      user_share_total_fen: 1105n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 895n,
      subsidy_commission_fen: 0n,
    });
    expect(await nChanged(f, o, 2000n)).toBe(false);
  },
  TIMEOUT,
);

it(
  '[AC-B1-18f#8][BR-CALC-27][BR-CALC-19] 预留、淘礼金扣除与红包面额照冻结值，只有补贴取当时值：n_total、基数前扣除与利润按 350',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      reserveBp: 2000,
      tljDeductFen: 30n,
      subsidyFen: 111n,
      redpacketFen: 50n,
      rebateMode: 'normal',
      patch: { subsidy_commission_fen: 350n },
    });
    await f.move(o, { estAfter: 2000n });

    await f.refresh(o);

    // 2000 × 80% = 1600，扣 30 → B 1570；785 / 157 / 78，合计 1020。
    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 1570n, 785n],
      ['direct', 1570n, 157n],
      ['indirect', 1570n, 78n],
    ]);
    // ① 2000 + 350；② 2350 − 1570；④ 2350 − 1020 − 50。
    expect(await totalsAtVersion(o, 2)).toEqual({
      commission_version: 2,
      n_total_fen: 2350n,
      pre_base_deduct_fen: 780n,
      base_fen: 1570n,
      user_share_total_fen: 1020n,
      tlj_redpacket_fen: 50n,
      platform_est_profit_fen: 1280n,
      subsidy_commission_fen: 350n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18f#9][BR-CALC-27][BR-CALC-02] 负 N：基数与份额为 0，n_total 是负 N 加当时补贴（−50 + 350），同 N 不判变化',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({ subsidyFen: 111n, patch: { subsidy_commission_fen: 350n } });
    await f.move(o, { estAfter: -50n });

    await f.refresh(o);

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 0n, 0n],
      ['direct', 0n, 0n],
      ['indirect', 0n, 0n],
    ]);
    expect(await totalsAtVersion(o, 2)).toEqual({
      commission_version: 2,
      n_total_fen: 300n,
      pre_base_deduct_fen: 300n,
      base_fen: 0n,
      user_share_total_fen: 0n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 300n,
      subsidy_commission_fen: 350n,
    });
    expect(await nChanged(f, o, -50n)).toBe(false);
  },
  TIMEOUT,
);

it(
  '[AC-B1-18f#10][BR-CALC-27][BR-CALC-23][BR-CALC-15] CREDITED：v1 冻结补贴 111、订单当前补贴 350，结算佣金变 2000 推版本 → v2 用 350，n_total 2350；份额与 base 只按 N，入账与账本不动',
  async () => {
    // version-rule 的 CREDITED 单（AC-B2-03s#29 / #34）：真实 rebate 端口的 CREDITED 分支经 commission_moved 调 refresh。
    const h = await portHarness(p.db);
    const o = await h.order({
      rebateStatus: 'CREDITED',
      platformStatus: 'SETTLED',
      estFen: 1000n,
      settleFen: 1000n,
      subsidyFen: 111n,
      patch: { booked_base_fen: 850n, booked_n_fen: 1000n, subsidy_commission_fen: 350n },
    });
    const money = await moneyRows(p.db, o.appId);

    await h.sync(o, { settleAfter: 2000n, moved: true });

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    // 2000 × 85% = 1700；850 / 170 / 85，合计 1105。
    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 1700n, 850n],
      ['direct', 1700n, 170n],
      ['indirect', 1700n, 85n],
    ]);
    // ① 2000 + 350；② 2350 − 1700；④ 2350 − 1105 − 0。
    expect(await totalsAtVersion(o, 2)).toEqual({
      commission_version: 2,
      n_total_fen: 2350n,
      pre_base_deduct_fen: 650n,
      base_fen: 1700n,
      user_share_total_fen: 1105n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 1245n,
      subsidy_commission_fen: 350n,
    });
    expect(await totalsAtVersion(o, 1)).toMatchObject({ n_total_fen: 1111n, base_fen: 850n });
    expect(await orderRow(p.db, o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      commission_version: 2,
      subsidy_commission_fen: 350n,
    });
    expect(await moneyRows(p.db, o.appId)).toEqual(money);
  },
  TIMEOUT,
);
