// B1-18k · 终态订单仅补贴变化（BR-CALC-15 一览终态一路、BR-CALC-27 细则「仅补贴变化的版本」；D10-1272，D10-1258，
// D10-1270 ③）。经生产 worker 的订单同步流水线（../../commission/version-rule/kit.ts 的 withRule），不注入替身。
// 规则：订单已是 VOID 或 CLAWED_BACK、有效 N 不变而补贴与当前版本记录的补贴不同 → commission_version +1，并在同一事务
// 写该版本：各受益人份额与 base 与上一版本逐项相同，只按新补贴重算 n_total / 基数前扣除 / 平台预估利润；不改
// rebate_status 与 reason，不写分录、通知、补差候选与扣回。之后补贴仍是同值、只是平台更新时间更晚（内容不同）的报文
// 不再 +1：比的是当前版本记录的补贴。
// 夹具：拼多多、服务费 0、预留 0、本人 50 %、无邀请人，报文补贴 200。两种终态都由结算 0 进入（WAITING → BASE_ZERO
// → VOID；入账后 → R8 → CLAWED_BACK），v2 的 N 为 0、B 0、金额 0。手算补贴 350 的仅补贴版本：① 0 + 350 = 350，
// ② 350 − 0 = 350，③ 0，用户 0，④ 350 − 0 − 0 = 350（淘礼金红包 0）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BILL_AT,
  TIMEOUT,
  databaseFixture,
  moneyRows,
  received,
  settled,
  touched,
  withRule,
} from '../../commission/version-rule/kit.ts';
import type { App } from '../settlement-records/kit.ts';

const p = databaseFixture(createTestDatabase);

type Rule = Parameters<Parameters<typeof withRule>[1]>[0];
type Terminal = 'VOID' | 'CLAWED_BACK';

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

/** 该单全部版本的金额行与合计行整行（含 created_at），版本升序：原样重投前后逐行比较。 */
async function versionRows(row: { readonly app_id: string; readonly order_id: string }) {
  return {
    amounts: await p.db
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', row.app_id)
      .where('order_id', '=', row.order_id)
      .orderBy('commission_version')
      .orderBy('role')
      .orderBy('user_id')
      .execute(),
    totals: await p.db
      .selectFrom('commission_split_totals')
      .selectAll()
      .where('app_id', '=', row.app_id)
      .where('order_id', '=', row.order_id)
      .orderBy('commission_version')
      .execute(),
  };
}

/** 本 App 的事件、站内信、补差候选、对账差异与资金行：仅补贴变化的版本一条都不该新增或改动。 */
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

/** 之后新增的事件只能是同步本身的 order.updated；其余各类行原样。 */
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

/**
 * 补贴 200 的订单经结算 0 进入终态（v2）：VOID 是 WAITING 单 BASE_ZERO；CLAWED_BACK 是同 version-rule kit 的
 * credited()（只是带补贴 200）入账后 R8。
 */
async function terminalWithSubsidy(w: Rule, app: App, terminal: Terminal) {
  if (terminal === 'CLAWED_BACK') await w.setConfig(app, 'credit.enabled.pdd', true);
  const o = w.order(app, { subsidy_commission_fen: 200n });
  await o.sync();
  await o.sync(received());
  if (terminal === 'CLAWED_BACK') {
    await o.sync(settled(1000n));
    w.clock.set(BILL_AT);
    await w.bill(app);
    await w.confirmAndExecute(app);
    expect(await o.row(), '前置：已入账').toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 1000n,
      booked_n_fen: 1000n,
      commission_version: 1,
    });
  } else {
    expect((await o.row()).rebate_status, '前置：已收货').toBe('WAITING');
  }
  await o.sync(settled(0n, touched(1)));
  const row = await o.row();
  expect(row, '前置：结算 0 进入终态，v2').toMatchObject({
    rebate_status: terminal,
    settle_commission_fen: 0n,
    subsidy_commission_fen: 200n,
    commission_version: 2,
  });
  expect(await o.versions(), '前置：v1、v2 有行').toEqual({ amounts: [1, 2], totals: [1, 2] });
  expect(await o.amounts(2), '前置：v2 的 B 与金额为 0').toEqual([[0n, 0n]]);
  return { o, row };
}

it.each(['VOID', 'CLAWED_BACK'] as const)(
  '[AC-B1-18k#3][BR-CALC-15][BR-CALC-27] %s：N 不变（结算仍 0）、补贴 200 → 350 → commission_version 3，v3 份额与 base 与 v2 逐项相同，合计行补贴 350、① 350 ② 350 ④ 350；状态与 reason 不变，无分录、通知、补差候选、扣回；之后补贴仍 350、平台更新时间更晚的报文不再 +1',
  async (terminal) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const { o, row } = await terminalWithSubsidy(w, app, terminal);
      const balance = await w.available(app);
      const side = await sideRows(app.appId);

      await o.sync(settled(0n, { ...touched(2), subsidy_commission_fen: 350n }));

      expect(await o.row()).toMatchObject({
        rebate_status: terminal,
        reason: row.reason,
        settle_commission_fen: 0n,
        subsidy_commission_fen: 350n,
        commission_version: 3,
        booked_base_fen: row.booked_base_fen,
        booked_n_fen: row.booked_n_fen,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await o.amounts(3)).toEqual(await o.amounts(2));
      expect(await o.amounts(3)).toEqual([[0n, 0n]]);
      expect((await totalsOf(row)).find((t) => t.commission_version === 3)).toEqual({
        commission_version: 3,
        n_total_fen: 350n,
        pre_base_deduct_fen: 350n,
        base_fen: 0n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 350n,
        subsidy_commission_fen: 350n,
      });
      await expectNoSideEffects(app.appId, side);
      expect(await w.available(app)).toBe(balance);

      // 附带：原样重投同一报文，版本不再增长，金额行与合计行逐行不变，无重复资金或通知效果。
      const rowsAtV3 = await versionRows(row);
      await o.sync(settled(0n, { ...touched(2), subsidy_commission_fen: 350n }));
      expect((await o.row()).commission_version, '重投不推版本').toBe(3);
      expect(await versionRows(row), '重投：版本行逐行不变').toEqual(rowsAtV3);
      await expectNoSideEffects(app.appId, side);
      expect(await w.available(app)).toBe(balance);

      // 补贴仍 350，只是平台更新时间更晚（报文内容不同）：比的是 v3 记录的补贴，不再 +1、不写新版本。
      await o.sync(settled(0n, { ...touched(3), subsidy_commission_fen: 350n }));

      expect(await o.row()).toMatchObject({
        rebate_status: terminal,
        subsidy_commission_fen: 350n,
        commission_version: 3,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      await expectNoSideEffects(app.appId, side);
    });
  },
  TIMEOUT,
);

// 上一版本份额非零的仅补贴版本（Codex spec-test r1 S1-2）：终态期间结算先回正 800（补贴仍 200），v3 按新 N 写行、
// 订单仍是终态；再 N 不变、补贴 200 → 350 → v4 的 (user_id, role, base_fen, amount_fen) 与 v3 整行相同。手算：
//   v3：① 800 + 200 = 1000，② 1000 − 800 = 200，③ 800，本人 800 × 50 % = 400，④ 1000 − 400 − 0 = 600，补贴 200；
//   v4：① 800 + 350 = 1150，② 1150 − 800 = 350，③ 800，本人 400（照抄 v3），④ 1150 − 400 − 0 = 750，补贴 350。
// 「全写 0」或「按订单佣金重分」的实现都过不了：base 必须是 800、份额必须是 400。
it.each(['VOID', 'CLAWED_BACK'] as const)(
  '[AC-B1-18k#3][BR-CALC-15][BR-CALC-27] %s：终态期间结算回正 800（v3 B 800、本人 400，仍终态）后 N 不变、补贴 200 → 350 → commission_version 4，v4 各受益人 (user_id, role, base_fen, amount_fen) 与 v3 整行相同（800 / 400），合计行补贴 350、① 1150 ② 350 ③ 800 ④ 750；状态与 reason 不变，无分录、通知、补差候选、扣回；原样重投不再 +1',
  async (terminal) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const { o, row } = await terminalWithSubsidy(w, app, terminal);

      // 终态期间回正：N 800，补贴仍 200（订单夹具的报文补贴）。
      await o.sync(settled(800n, touched(2)));
      expect(await o.row(), '前置：回正后仍终态，v3').toMatchObject({
        rebate_status: terminal,
        reason: row.reason,
        settle_commission_fen: 800n,
        subsidy_commission_fen: 200n,
        commission_version: 3,
      });
      const share = { user_id: app.userId, role: 'share', base_fen: 800n, amount_fen: 400n };
      expect(await sharesOf(row, 3), '前置：v3 按新 N 800 写行').toEqual([share]);
      expect(
        (await totalsOf(row)).find((t) => t.commission_version === 3),
        '前置：v3 合计行',
      ).toEqual({
        commission_version: 3,
        n_total_fen: 1000n,
        pre_base_deduct_fen: 200n,
        base_fen: 800n,
        user_share_total_fen: 400n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 600n,
        subsidy_commission_fen: 200n,
      });
      const balance = await w.available(app);
      const side = await sideRows(app.appId);
      const report = settled(800n, { ...touched(3), subsidy_commission_fen: 350n });

      await o.sync(report);

      expect(await o.row()).toMatchObject({
        rebate_status: terminal,
        reason: row.reason,
        settle_commission_fen: 800n,
        subsidy_commission_fen: 350n,
        commission_version: 4,
        booked_base_fen: row.booked_base_fen,
        booked_n_fen: row.booked_n_fen,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3, 4], totals: [1, 2, 3, 4] });
      expect(await sharesOf(row, 4), 'v4 份额与 base 逐项同 v3').toEqual(await sharesOf(row, 3));
      expect(await sharesOf(row, 4)).toEqual([share]);
      expect((await totalsOf(row)).find((t) => t.commission_version === 4)).toEqual({
        commission_version: 4,
        n_total_fen: 1150n,
        pre_base_deduct_fen: 350n,
        base_fen: 800n,
        user_share_total_fen: 400n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 750n,
        subsidy_commission_fen: 350n,
      });
      await expectNoSideEffects(app.appId, side);
      expect(await w.available(app)).toBe(balance);

      // 附带：原样重投同一报文，版本不再增长，行逐行不变，无重复资金或通知效果。
      const rowsAtV4 = await versionRows(row);
      await o.sync(report);
      expect((await o.row()).commission_version, '重投不推版本').toBe(4);
      expect(await versionRows(row), '重投：版本行逐行不变').toEqual(rowsAtV4);
      await expectNoSideEffects(app.appId, side);
      expect(await w.available(app)).toBe(balance);
    });
  },
  TIMEOUT,
);
