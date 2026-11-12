// B1-18k 第 2 轮（Codex spec-test r1 S1-1）· 终态订单佣金再变化时版本行与订单列同一事务（BR-CALC-15 一览终态一路
// 「照常 +1，并在同一事务写该版本的金额行与四段金额」、BR-CALC-27「在同一事务按该版本落四段金额」；D10-1272）。
// 经生产 worker 的订单同步流水线（../../commission/version-rule/kit.ts 的 withRule），不注入替身。
// 写入失败的做法同 ../../orders/subsidy-version/version-basis.int.test.ts：测试库角色没有 DDL 权限、两张版本表只追加，
// 建不了触发器；改用 worker 数据库句柄上的 Kysely 插件，只在被测那次同步里、只对该单该版本的金额行或合计行插入抛错。
// 要钉：写入失败 → 这次同步报错，订单列（含佣金列、补贴列、commission_version、row_version、content_hash）、新版本
// 金额行与合计行、事件（含 order.updated）一起回滚；去掉故障后重投同一报文 → 恰好生成一套完整的新版本（一行金额、一行
// 合计），状态与 reason 不变，不记账、不通知。
// 夹具：拼多多、服务费 0、预留 0、本人 50 %、无邀请人。手算：
//   VOID 结算 -100 → -200：v3 B 0、金额 0；① -200 ② -200 − 0 = -200 ③ 0，用户 0，④ -200 − 0 − 0 = -200。
//   CLAWED_BACK（补贴 200，结算 0）仅补贴 200 → 350：v3 份额与 base 同 v2（0 / 0）；① 0 + 350 = 350，② 350 − 0 = 350，
//   ③ 0，用户 0，④ 350 − 0 − 0 = 350，补贴 350。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BILL_AT,
  TIMEOUT,
  capture,
  databaseFixture,
  moneyRows,
  received,
  settled,
  touched,
  withRule,
} from '../../commission/version-rule/kit.ts';

const p = databaseFixture(createTestDatabase);

const INJECTED = 'injected terminal version row insert failure (B1-18k rule test)';

type VersionTable = 'commission_split_amounts' | 'commission_split_totals';

interface FaultTarget {
  readonly table: VersionTable;
  readonly orderId: string;
  readonly version: number;
}

/** 语法树（或其中的值）里是否出现 wanted：插入的值列表里带该单 order_id 与该版本号。 */
function carries(node: unknown, wanted: string | number): boolean {
  if (node === wanted) return true;
  if (Array.isArray(node)) return node.some((child) => carries(child, wanted));
  if (node !== null && typeof node === 'object' && !(node instanceof Date)) {
    return Object.values(node).some((child) => carries(child, wanted));
  }
  return false;
}

/** p.db 加一个只在武装期间、只对目标表该单该版本的插入抛错的插件；其余查询原样通过。 */
function faultInjector() {
  const state: { target: FaultTarget | undefined; injected: number } = {
    target: undefined,
    injected: 0,
  };
  const db = p.db.withPlugin({
    transformQuery(args) {
      const node = args.node;
      const target = state.target;
      if (
        target !== undefined &&
        node.kind === 'InsertQueryNode' &&
        node.into?.table.identifier.name === target.table &&
        carries(node.values, target.orderId) &&
        carries(node.values, target.version)
      ) {
        state.injected += 1;
        throw new Error(INJECTED);
      }
      return node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db, state };
}

/** 该单每个版本的合计行（四段金额与该版本所用补贴），版本升序。 */
async function totalsOf(row: { readonly app_id: string; readonly order_id: string }) {
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
async function sharesOf(
  row: { readonly app_id: string; readonly order_id: string },
  version: number,
) {
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
      .orderBy('event_id')
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
    diffs: await p.db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    money: await moneyRows(p.db, appId),
  };
}

type SideRows = Awaited<ReturnType<typeof sideRows>>;

/** 之后新增的事件只能是同步本身的 order.updated；其余各类行原样（不写分录、不通知、不补差、不扣回、无新差错单）。 */
async function expectNoSideEffects(appId: string, before: SideRows): Promise<void> {
  const after = await sideRows(appId);
  const known = new Set(before.events.map((e) => e.event_id));
  expect(
    after.events
      .filter((e) => !known.has(e.event_id))
      .map((e) => e.name)
      .filter((name) => name !== 'order.updated'),
    '新增事件（通知、扣回、补差、入账）',
  ).toEqual([]);
  expect(after.inbox, '站内信').toEqual(before.inbox);
  expect(after.adjustments, '补差候选 settle_adjustments').toEqual(before.adjustments);
  expect(after.diffs, '对账差异 recon_diffs').toEqual(before.diffs);
  expect(after.money, '账本凭证、分录与余额').toEqual(before.money);
}

it(
  '[AC-B1-18k#1][BR-CALC-15][BR-CALC-27][BR-FUND-01] 同一事务：VOID（WAITING 单结算 -100 → BASE_ZERO，v2）后结算 -200，v3 金额行写入失败（只在这次同步里、只对该单 v3 注入）→ 同步报错，订单行整行、v3 金额行与合计行、事件一起回滚；去掉故障后重投同一报文 → 恰好一套完整 v3（一行金额 0 / 0、一行合计 ① -200 ② -200 ④ -200），仍 VOID、reason 不变，不记账、不通知',
  async () => {
    const fault = faultInjector();
    await withRule(fault.db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(-100n));
      const before = await o.row();
      expect(before, '前置：BASE_ZERO 作废，v2').toMatchObject({
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
        settle_commission_fen: -100n,
        commission_version: 2,
      });
      expect(await o.versions(), '前置：v1、v2 有行').toEqual({ amounts: [1, 2], totals: [1, 2] });
      const side = await sideRows(app.appId);
      const report = settled(-200n, touched(1));

      fault.state.target = {
        table: 'commission_split_amounts',
        orderId: before.order_id,
        version: 3,
      };
      const failed = await capture(() => o.report(report));
      fault.state.target = undefined;

      expect(failed, 'v3 金额行写入失败，这次同步报错').toMatchObject({ ok: false });
      expect(fault.state.injected, '故障落在该单 v3 金额行的写入上').toBeGreaterThan(0);
      expect(
        await o.row(),
        '订单行整行回滚（结算列、commission_version、row_version、content_hash）',
      ).toEqual(before);
      expect(await o.versions(), 'v3 金额行与合计行一起回滚').toEqual({
        amounts: [1, 2],
        totals: [1, 2],
      });
      expect(
        await sideRows(app.appId),
        '事件（含 order.updated）、站内信、补差、差错单、资金行',
      ).toEqual(side);

      const failures = fault.state.injected;
      await o.sync(report);

      expect(fault.state.injected, '故障已去掉').toBe(failures);
      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
        settle_commission_fen: -200n,
        commission_version: 3,
        booked_base_fen: before.booked_base_fen,
        booked_n_fen: before.booked_n_fen,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await sharesOf(before, 3), 'v3 恰好一行金额').toEqual([
        { user_id: app.userId, role: 'share', base_fen: 0n, amount_fen: 0n },
      ]);
      expect(
        (await totalsOf(before)).filter((t) => t.commission_version === 3),
        'v3 恰好一行合计',
      ).toHaveLength(1);
      expect(await o.fourAmounts(3)).toEqual({
        n_total_fen: -200n,
        pre_base_deduct_fen: -200n,
        base_fen: 0n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: -200n,
      });
      await expectNoSideEffects(app.appId, side);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18k#3][BR-CALC-15][BR-CALC-27][BR-FUND-01] 同一事务：CLAWED_BACK（补贴 200，入账后结算 0 → R8，v2）后仅补贴 200 → 350，v3 合计行写入失败（只在这次同步里、只对该单 v3 注入）→ 同步报错，订单补贴列、commission_version、v3 金额行与合计行、事件一起回滚；去掉故障后重投同一报文 → 恰好一套完整 v3（份额与 base 同 v2，合计行补贴 350、① 350 ② 350 ④ 350），仍 CLAWED_BACK，余额不变',
  async () => {
    const fault = faultInjector();
    await withRule(fault.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app, { subsidy_commission_fen: 200n });
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      w.clock.set(BILL_AT);
      await w.bill(app);
      await w.confirmAndExecute(app);
      expect(await o.row(), '前置：已入账').toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        commission_version: 1,
      });
      await o.sync(settled(0n, touched(1)));
      const before = await o.row();
      expect(before, '前置：R8 整单扣回，v2').toMatchObject({
        rebate_status: 'CLAWED_BACK',
        settle_commission_fen: 0n,
        subsidy_commission_fen: 200n,
        commission_version: 2,
      });
      expect(await o.versions(), '前置：v1、v2 有行').toEqual({ amounts: [1, 2], totals: [1, 2] });
      const v2Shares = await sharesOf(before, 2);
      expect(v2Shares, '前置：v2 一行，B 0、金额 0').toEqual([
        { user_id: app.userId, role: 'share', base_fen: 0n, amount_fen: 0n },
      ]);
      const balance = await w.available(app);
      const side = await sideRows(app.appId);
      const report = settled(0n, { ...touched(2), subsidy_commission_fen: 350n });

      fault.state.target = {
        table: 'commission_split_totals',
        orderId: before.order_id,
        version: 3,
      };
      const failed = await capture(() => o.report(report));
      fault.state.target = undefined;

      expect(failed, 'v3 合计行写入失败，这次同步报错').toMatchObject({ ok: false });
      expect(fault.state.injected, '故障落在该单 v3 合计行的写入上').toBeGreaterThan(0);
      expect(
        await o.row(),
        '订单行整行回滚（补贴列、commission_version、row_version、content_hash）',
      ).toEqual(before);
      expect(await o.versions(), 'v3 金额行与合计行一起回滚').toEqual({
        amounts: [1, 2],
        totals: [1, 2],
      });
      expect(
        await sideRows(app.appId),
        '事件（含 order.updated）、站内信、补差、差错单、资金行',
      ).toEqual(side);
      expect(await w.available(app)).toBe(balance);

      const failures = fault.state.injected;
      await o.sync(report);

      expect(fault.state.injected, '故障已去掉').toBe(failures);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        reason: before.reason,
        settle_commission_fen: 0n,
        subsidy_commission_fen: 350n,
        commission_version: 3,
        booked_base_fen: before.booked_base_fen,
        booked_n_fen: before.booked_n_fen,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await sharesOf(before, 3), 'v3 恰好一行，份额与 base 同 v2').toEqual(v2Shares);
      expect((await totalsOf(before)).filter((t) => t.commission_version === 3)).toEqual([
        {
          commission_version: 3,
          n_total_fen: 350n,
          pre_base_deduct_fen: 350n,
          base_fen: 0n,
          user_share_total_fen: 0n,
          tlj_redpacket_fen: 0n,
          platform_est_profit_fen: 350n,
          subsidy_commission_fen: 350n,
        },
      ]);
      await expectNoSideEffects(app.appId, side);
      expect(await w.available(app)).toBe(balance);
    });
  },
  TIMEOUT,
);
