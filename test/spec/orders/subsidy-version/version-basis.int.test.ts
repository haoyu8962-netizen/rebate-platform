// B1-18i 第 2 轮（Codex spec-test r1 的四条 S1）· 补贴类佣金单独变化推版本（BR-CALC-15 一览、BR-CALC-27 细则
// 「仅补贴变化的版本」；D10-1257、D10-1258）：比较基准、份额沿用、乐观锁、同事务。
// 同 subsidy-version.int.test.ts，经生产 worker 的订单同步流水线（../../commission/version-rule/kit.ts 的 withRule）。
// - 存量状态（B1-18c 只写列不推版本；B1-18f 加列前写的合计行，补贴列为空）用 SQL 直接造，触发一律走同步入口。
// - R7 维权重定价走 worker 装配的维权同步写入方（createRightsSyncWriter 的返回值：找单 → 锁 → 重读 → 生产
//   rights.record → rebate.apply → commission refresh），不注入替身。
// - 版本冲突：update step 在 CAS 之前、同一事务里调 settlement 结算记录端口的 latestStatementFen；在那一刻以同一
//   事务写入「另一路径已推到 v2」（R7 形状：N 1000 → 600、补贴 200），确定性地让第一次 CAS 落空。
// - 写入失败：测试库角色没有 DDL 权限（couli_migrator 不对测试开放），两张版本表又只追加，建不了触发器、也删不掉
//   预置行；改用 worker 数据库句柄上的 Kysely 插件（同 notification/push-send 的写法），只在被测那次同步里让
//   commission_split_totals 的插入抛错。
// 夹具：拼多多、服务费 0、预留 0、本人 50 %，有邀请人时直推 10 %。期望金额全部手写：
//   N 1000 → B 1000 → 500（直推 100）；N 600 → B 600 → 300（直推 60）；N 1200 → B 1200 → 600。
//   合计行：① = N + 补贴，② = ① − B，④ = ① − Σ用户份额（淘礼金红包 0）。
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import * as rightsSync from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import * as settlementRecords from '../../../../apps/api/src/modules/settlement/settlements/index.ts';
import { estimatesOf } from '../../commission/estimate-port/kit.ts';
import { level, relation, user as member } from '../../commission/resolver/kit.ts';
import {
  BILL_AT,
  TIMEOUT,
  capture,
  databaseFixture,
  moneyRows,
  withRule,
} from '../../commission/version-rule/kit.ts';

const p = databaseFixture(createTestDatabase);

const INJECTED = 'injected commission_split_totals insert failure (B1-18i rule test)';

interface OrderRef {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
}

/**
 * 一个版本的合计行：版本、① n_total、② 基数前扣除、③ base、Σ用户份额、④ 平台预估利润、该版本所用补贴；
 * 淘礼金红包 0。各值由用例手写。
 */
function totals(
  version: number,
  nTotal: bigint,
  preBase: bigint,
  base: bigint,
  users: bigint,
  profit: bigint,
  subsidy: bigint | null,
) {
  return {
    commission_version: version,
    n_total_fen: nTotal,
    pre_base_deduct_fen: preBase,
    base_fen: base,
    user_share_total_fen: users,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: profit,
    subsidy_commission_fen: subsidy,
  };
}

/** 该单每个版本的合计行，版本升序。 */
async function totalsOf(row: OrderRef) {
  return p.db
    .selectFrom('commission_split_totals')
    .select([
      'commission_version',
      'n_total_fen',
      'pre_base_deduct_fen',
      'base_fen',
      'user_share_total_fen',
      'tlj_redpacket_fen',
      'platform_est_profit_fen',
      'subsidy_commission_fen',
    ])
    .where('app_id', '=', row.app_id)
    .where('order_id', '=', row.order_id)
    .orderBy('commission_version')
    .execute();
}

/** 一个版本的金额行整行 (user_id, role, base_fen, amount_fen)，按角色、用户排序。 */
async function sharesOf(row: OrderRef, version: number) {
  return p.db
    .selectFrom('commission_split_amounts')
    .select(['user_id', 'role', 'base_fen', 'amount_fen'])
    .where('app_id', '=', row.app_id)
    .where('order_id', '=', row.order_id)
    .where('commission_version', '=', version)
    .orderBy('role')
    .orderBy('user_id')
    .execute();
}

/** 本 App 的事件、站内信、补差候选、对账差异与资金行。 */
async function sideRows(appId: string) {
  return {
    events: await p.db
      .selectFrom('event_log')
      .select(['event_id', 'name'])
      .where('app_id', '=', appId)
      .execute(),
    inbox: await p.db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', appId)
      .execute(),
    adjustments: await p.db
      .selectFrom('settle_adjustments')
      .selectAll()
      .where('app_id', '=', appId)
      .execute(),
    diffs: await p.db.selectFrom('recon_diffs').selectAll().where('app_id', '=', appId).execute(),
    money: await moneyRows(p.db, appId),
  };
}

type SideRows = Awaited<ReturnType<typeof sideRows>>;

/** 之后新增的事件只能是同步本身的 order.updated；其余各类行原样（不写分录、不通知、不补差、不扣回）。 */
async function expectNoSideEffects(appId: string, before: SideRows): Promise<void> {
  const after = await sideRows(appId);
  const known = new Set(before.events.map((e) => e.event_id));
  const added = after.events.filter((e) => !known.has(e.event_id)).map((e) => e.name);
  expect(
    added.filter((name) => name !== 'order.updated'),
    '新增事件（通知、扣回、补差、入账）',
  ).toEqual([]);
  expect(after.inbox, '站内信').toEqual(before.inbox);
  expect(after.adjustments, '补差候选 settle_adjustments').toEqual(before.adjustments);
  expect(after.diffs, '对账差异 recon_diffs').toEqual(before.diffs);
  expect(after.money, '账本凭证、分录与余额').toEqual(before.money);
}

/** R7 维权重定价问的那一句（compareN）：N 与最新版本存的 N 是否不同（B1-18f storedN）。 */
const estimates = estimatesOf(new FixedClock(BILL_AT));
async function nChanged(row: OrderRef, n: bigint) {
  const bases = await p.db.transaction().execute((trx) =>
    estimates.bases(trx, {
      appId: row.app_id,
      orderId: row.order_id,
      attrAt: row.attr_at,
      estBefore: n,
      estAfter: n,
      settleCommissionFen: null,
      compareN: true,
    }),
  );
  return bases.nChanged;
}

/**
 * 另一路径（R7 形状：N 1000 → 600，补贴 200）在调用方事务里把版本推到 v2：v2 金额行 600 / 300、合计行
 * ① 800 ② 200 ④ 500，订单 commission_version 2、row_version + 1（佣金列不动，同 R7）。
 */
async function racedToV2(
  trx: Transaction<DB>,
  row: OrderRef,
  ownerId: string,
  at: Date,
): Promise<void> {
  await trx
    .insertInto('commission_split_amounts')
    .values({
      app_id: row.app_id,
      order_id: row.order_id,
      commission_version: 2,
      user_id: ownerId,
      role: 'share',
      base_fen: 600n,
      amount_fen: 300n,
      created_at: at,
    })
    .execute();
  await trx
    .insertInto('commission_split_totals')
    .values({
      app_id: row.app_id,
      order_id: row.order_id,
      commission_version: 2,
      n_total_fen: 800n,
      pre_base_deduct_fen: 200n,
      base_fen: 600n,
      user_share_total_fen: 300n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 500n,
      subsidy_commission_fen: 200n,
      created_at: at,
    })
    .execute();
  const current = await trx
    .selectFrom('orders')
    .select('row_version')
    .where('app_id', '=', row.app_id)
    .where('order_id', '=', row.order_id)
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('orders')
    .set({ commission_version: 2, row_version: current.row_version + 1, updated_at: at })
    .where('app_id', '=', row.app_id)
    .where('order_id', '=', row.order_id)
    .execute();
}

it(
  '[AC-B1-18i#1][AC-B1-18i#5][BR-CALC-15][BR-CALC-27] 比较基准是当前版本合计行记的补贴，不是订单列：v1 合计行补贴 200、订单列已是 350（B1-18c 只写列不推版本，SQL 造）、N 1000；收到补贴 350 的报文 → 按 v1 的 200 判定，commission_version 变 2，v2 合计行补贴 350、① 1350 ② 350 ④ 850，份额与 base 同 v1；同一报文重投不再 +1',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, { subsidy_commission_fen: 200n });
      await o.sync();
      const row = await o.row();
      expect(await totalsOf(row), '前置：v1 合计行补贴 200').toEqual([
        totals(1, 1200n, 200n, 1000n, 500n, 700n, 200n),
      ]);
      // B1-18c 留下的存量：报文补贴已写进订单列，版本没推。
      await p.db
        .updateTable('orders')
        .set({ subsidy_commission_fen: 350n, row_version: row.row_version + 1 })
        .where('app_id', '=', row.app_id)
        .where('order_id', '=', row.order_id)
        .execute();
      expect(await o.row(), '前置：订单列 350、仍在 v1').toMatchObject({
        subsidy_commission_fen: 350n,
        commission_version: 1,
      });
      const side = await sideRows(app.appId);

      const report = { subsidy_commission_fen: 350n };
      await o.sync(report);

      expect(await o.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        est_commission_fen: 1000n,
        subsidy_commission_fen: 350n,
        commission_version: 2,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(2)).toEqual([[1000n, 500n]]);
      expect(await totalsOf(row)).toEqual([
        totals(1, 1200n, 200n, 1000n, 500n, 700n, 200n),
        totals(2, 1350n, 350n, 1000n, 500n, 850n, 350n),
      ]);
      expect(w.moves().at(-1), '本次 commission_moved').toBe(true);
      await expectNoSideEffects(app.appId, side);

      // 同一报文重投：不 +1、不写新版本。
      await o.sync(report);
      expect((await o.row()).commission_version).toBe(2);
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18i#1][AC-B1-18i#3][BR-CALC-27][BR-CALC-15] 当前版本合计行补贴为空（B1-18f 加列前写的 v2，N 1200，SQL 造）→ 回退该单分佣快照的补贴 200 参与判定，不按订单列 350、也不按 0：N 不变、报文补贴 200 不 +1；补贴 350 才 +1，v3 份额与 base 同 v2（1200 / 600），合计行补贴 350、① 1550 ② 350 ④ 950，v2 行原样',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, { subsidy_commission_fen: 200n });
      await o.sync();
      const row = await o.row();
      expect(await sharesOf(row, 1), '前置：v1 一位受益人').toEqual([
        { user_id: app.userId, role: 'share', base_fen: 1000n, amount_fen: 500n },
      ]);
      // 存量：加列前写的 v2（合计行补贴列为空，读时回退快照补贴 200）；订单列补贴已是 350（B1-18c）。
      const at = w.clock.now();
      await p.db
        .insertInto('commission_split_amounts')
        .values({
          app_id: row.app_id,
          order_id: row.order_id,
          commission_version: 2,
          user_id: app.userId,
          role: 'share',
          base_fen: 1200n,
          amount_fen: 600n,
          created_at: at,
        })
        .execute();
      await p.db
        .insertInto('commission_split_totals')
        .values({
          app_id: row.app_id,
          order_id: row.order_id,
          commission_version: 2,
          n_total_fen: 1400n,
          pre_base_deduct_fen: 200n,
          base_fen: 1200n,
          user_share_total_fen: 600n,
          tlj_redpacket_fen: 0n,
          platform_est_profit_fen: 800n,
          subsidy_commission_fen: null,
          created_at: at,
        })
        .execute();
      await p.db
        .updateTable('orders')
        .set({
          est_commission_fen: 1200n,
          commission_version: 2,
          subsidy_commission_fen: 350n,
          row_version: row.row_version + 1,
        })
        .where('app_id', '=', row.app_id)
        .where('order_id', '=', row.order_id)
        .execute();
      const legacy = totals(2, 1400n, 200n, 1200n, 600n, 800n, null);
      const side = await sideRows(app.appId);

      // 快照补贴 200 = 报文 200：不因补贴推版本（订单列照 B1-18c 改回 200）。
      await o.sync({ est_commission_fen: 1200n, subsidy_commission_fen: 200n });
      expect(await o.row()).toMatchObject({
        est_commission_fen: 1200n,
        subsidy_commission_fen: 200n,
        commission_version: 2,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });

      await o.sync({ est_commission_fen: 1200n, subsidy_commission_fen: 350n });

      expect(await o.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        est_commission_fen: 1200n,
        subsidy_commission_fen: 350n,
        commission_version: 3,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await sharesOf(row, 3)).toEqual(await sharesOf(row, 2));
      expect(await sharesOf(row, 3)).toEqual([
        { user_id: app.userId, role: 'share', base_fen: 1200n, amount_fen: 600n },
      ]);
      expect((await totalsOf(row)).slice(1)).toEqual([
        legacy,
        totals(3, 1550n, 350n, 1200n, 600n, 950n, 350n),
      ]);
      expect(w.moves().slice(-2), 'commission_moved：200 不推、350 推').toEqual([false, true]);
      await expectNoSideEffects(app.appId, side);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18i#1][AC-B1-18i#7][BR-CALC-27][BR-CALC-15][BR-FUND-01] 份额逐项沿用上一版本，不按订单佣金重分：两位受益人（本人 50 %、直推 10 %），经 worker 的维权同步写入方部分维权成功（应扣 400，R7）→ v2 base 600、300 / 60，订单佣金列仍 1000；再 N 不变、补贴 200 → 350 → v3 各受益人 (user_id, role, base_fen, amount_fen) 与 v2 整行相同（不是 1000 / 500 / 100），合计行 ① 950 ② 350 ④ 590；R7 的同 N 判定不误判',
  async () => {
    const writers = vi.spyOn(rightsSync, 'createRightsSyncWriter');
    try {
      await withRule(p.db, async (w) => {
        expect(writers, 'the rights-sync writer of the worker entry').toHaveBeenCalledTimes(1);
        const made = writers.mock.results[0];
        if (made?.type !== 'return') {
          throw new Error('B1-18i: the worker built no rights-sync writer');
        }
        const writer = made.value;
        const app = await w.app();
        // 邀请人：付款时（2026-10-20）已是本人的上级，等级 L1；他自己没有上级（无间推）。
        const inviter = await member(p.db, app.appId);
        await level(p.db, app.appId, inviter, 'L1');
        await relation(p.db, app.appId, app.userId, inviter);
        const o = w.order(app, { subsidy_commission_fen: 200n });
        await o.sync();
        const row = await o.row();
        expect(await sharesOf(row, 1), '前置：v1 两位受益人').toEqual([
          { user_id: inviter, role: 'direct', base_fen: 1000n, amount_fen: 100n },
          { user_id: app.userId, role: 'share', base_fen: 1000n, amount_fen: 500n },
        ]);

        // R7：联盟报部分维权成功、应扣 400（只有预估的单）。
        expect(
          await writer.write(
            { app_id: app.appId, platform: 'pdd', sub_order_id: o.subOrderId },
            {
              type: 'RIGHTS',
              status: 'SUCCEEDED',
              amount_fen: null,
              deduction_commission_fen: 400n,
              occurred_at: w.clock.now(),
              platform_rights_no: 'synthetic-b1-18i-rights-1',
            },
          ),
        ).toEqual({ kind: 'applied' });
        expect(await o.row(), '前置：R7 推到 v2，佣金列不动').toMatchObject({
          rebate_status: 'ESTIMATED',
          est_commission_fen: 1000n,
          subsidy_commission_fen: 200n,
          commission_version: 2,
        });
        const repriced = [
          { user_id: inviter, role: 'direct', base_fen: 600n, amount_fen: 60n },
          { user_id: app.userId, role: 'share', base_fen: 600n, amount_fen: 300n },
        ];
        expect(await sharesOf(row, 2), '前置：v2 按 N_new 600').toEqual(repriced);
        expect((await totalsOf(row))[1], '前置：v2 合计行').toEqual(
          totals(2, 800n, 200n, 600n, 360n, 440n, 200n),
        );
        const side = await sideRows(app.appId);

        await o.sync({ subsidy_commission_fen: 350n });

        expect(await o.row()).toMatchObject({
          rebate_status: 'ESTIMATED',
          est_commission_fen: 1000n,
          subsidy_commission_fen: 350n,
          commission_version: 3,
        });
        expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
        expect(await sharesOf(row, 3), 'v3 份额与 base 逐项同 v2').toEqual(await sharesOf(row, 2));
        expect(await sharesOf(row, 3)).toEqual(repriced);
        expect((await totalsOf(row))[2]).toEqual(totals(3, 950n, 350n, 600n, 360n, 590n, 350n));
        expect(w.moves().at(-1), '本次 commission_moved').toBe(true);
        await expectNoSideEffects(app.appId, side);
        // B1-18f storedN：v3 存的 N 是 950 − 350 = 600，同 N 的 R7 不判变化。
        expect(await nChanged(row, 600n)).toBe(false);
        expect(await nChanged(row, 1000n)).toBe(true);
      });
    } finally {
      writers.mockRestore();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-18i#1][BR-CALC-15][BR-CALC-27] 补贴分支的乐观锁：同步读到 v1 之后、写入之前，另一路径（R7 形状：N 1000 → 600，补贴 200）已把版本推到 v2 → 第一次 CAS 落空，重读后按 v2 重算：版本到 3，v3 份额与 base 同 v2（600 / 300），合计行补贴 350、① 950 ② 350 ④ 650；每个版本恰好一行金额、一行合计，订单补贴列 350',
  async () => {
    const records = vi.spyOn(settlementRecords, 'createSettlementRecords');
    try {
      await withRule(p.db, async (w) => {
        expect(records, 'the settlement records port of the worker').toHaveBeenCalled();
        const app = await w.app();
        const o = w.order(app, { subsidy_commission_fen: 200n });
        await o.sync();
        const row = await o.row();
        expect(row, '前置：v1').toMatchObject({
          subsidy_commission_fen: 200n,
          commission_version: 1,
        });

        // update step 在 CAS 之前调 latestStatementFen：武装后的第一次调用里先让「另一路径」推到 v2。
        let armed = false;
        let raced = 0;
        for (const made of records.mock.results) {
          if (made.type !== 'return') continue;
          const port = made.value;
          const latest = port.latestStatementFen.bind(port);
          vi.spyOn(port, 'latestStatementFen').mockImplementation(async (trx, ref) => {
            if (armed) {
              armed = false;
              raced += 1;
              await racedToV2(trx, row, app.userId, w.clock.now());
            }
            return latest(trx, ref);
          });
        }

        armed = true;
        await o.sync({ subsidy_commission_fen: 350n });
        armed = false;

        expect(raced, '另一路径恰在读与写之间推了一次版本').toBe(1);
        expect(await o.row()).toMatchObject({
          rebate_status: 'ESTIMATED',
          est_commission_fen: 1000n,
          subsidy_commission_fen: 350n,
          commission_version: 3,
        });
        expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
        expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
        expect(await o.amounts(2)).toEqual([[600n, 300n]]);
        expect(await o.amounts(3), 'v3 恰好一行，份额与 base 同 v2').toEqual([[600n, 300n]]);
        expect(await totalsOf(row)).toEqual([
          totals(1, 1200n, 200n, 1000n, 500n, 700n, 200n),
          totals(2, 800n, 200n, 600n, 300n, 500n, 200n),
          totals(3, 950n, 350n, 600n, 300n, 650n, 350n),
        ]);
        expect(w.moves().at(-1), '本次 commission_moved').toBe(true);
      });
    } finally {
      records.mockRestore();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-18i#1][AC-B1-18i#2][BR-CALC-27][BR-CALC-15] 同一事务：仅补贴变化的新版本合计行写入失败（只在这次同步里注入）→ 同步报错，订单补贴列、commission_version、新版本金额行与合计行、order.updated 一起回滚；去掉故障后重投同一报文 → 恰好生成一套完整 v2（一行金额、一行合计，补贴 350）',
  async () => {
    let armed = false;
    let injected = 0;
    const faulty = p.db.withPlugin({
      transformQuery(args) {
        if (
          armed &&
          args.node.kind === 'InsertQueryNode' &&
          args.node.into?.table.identifier.name === 'commission_split_totals'
        ) {
          injected += 1;
          throw new Error(INJECTED);
        }
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    await withRule(faulty, async (w) => {
      const app = await w.app();
      const o = w.order(app, { subsidy_commission_fen: 200n });
      await o.sync();
      const before = await o.row();
      expect(before, '前置：v1').toMatchObject({
        subsidy_commission_fen: 200n,
        commission_version: 1,
      });
      const side = await sideRows(app.appId);
      const report = { subsidy_commission_fen: 350n };

      armed = true;
      const failed = await capture(() => o.report(report));
      armed = false;

      expect(failed, '新版本合计行写入失败，这次同步报错').toMatchObject({ ok: false });
      expect(injected, '故障落在新版本合计行的写入上').toBeGreaterThan(0);
      expect(await o.row(), '订单行整行回滚（补贴列、版本、row_version、content_hash）').toEqual(
        before,
      );
      expect(await o.versions(), '新版本金额行与合计行一起回滚').toEqual({
        amounts: [1],
        totals: [1],
      });
      expect(
        await sideRows(app.appId),
        '事件（含 order.updated）、站内信、补差、对账差异、资金行',
      ).toEqual(side);

      const failures = injected;
      await o.sync(report);

      expect(injected, '故障已去掉').toBe(failures);
      expect(await o.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        est_commission_fen: 1000n,
        subsidy_commission_fen: 350n,
        commission_version: 2,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(2), 'v2 恰好一行，份额与 base 同 v1').toEqual([[1000n, 500n]]);
      expect(await totalsOf(before)).toEqual([
        totals(1, 1200n, 200n, 1000n, 500n, 700n, 200n),
        totals(2, 1350n, 350n, 1000n, 500n, 850n, 350n),
      ]);
      await expectNoSideEffects(app.appId, side);
    });
  },
  TIMEOUT,
);
