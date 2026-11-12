// B1-18k · 终态订单的有效联盟佣金再变化（BR-CALC-15 一览「rebate_status ∈ {VOID, CLAWED_BACK}（终态）」一路、
// BR-CALC-27「含已是 VOID、CLAWED_BACK 的终态订单」；D10-1272）。经生产 worker 的订单同步流水线（../../commission/
// version-rule/kit.ts 的 withRule：真实 pipeline、update step、rebate 端口、commission 估值、出账与入账），不注入替身。
// 规则：订单已是 VOID 或 CLAWED_BACK 时 N 再变化，commission_version 照常 +1，并在同一事务按新 N 用同一算法写该版本的
// 金额行与四段金额（负 N：B 0、金额 0，n_total 保留负的 N）；不改 rebate_status 与 reason，不写分录、通知、补差候选与
// 扣回。由负回正的那次同步另由 orders 登记 platform_restore 差错单（BR-FUND-22），这是唯一允许新增的差错单。
// 夹具：拼多多、服务费 0、预留 0、本人 50 %、无邀请人。手算：N 800 → B 800 → 400；N ≤ 0 → B 0 → 0。
// 负 N 的四段金额：① N，② N − 0 = N，③ 0，用户 0，④ N（淘礼金红包 0）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  moneyRows,
  received,
  settled,
  touched,
  withRule,
} from '../../commission/version-rule/kit.ts';

const p = databaseFixture(createTestDatabase);

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

/**
 * 终态订单佣金变化之后：新增事件只能是同步本身的 order.updated；站内信、补差候选、账本凭证、分录与余额原样；
 * 原有差错单原样，新增的只能是 orders 登记的 platform_restore。
 */
async function expectNothingBooked(appId: string, before: SideRows): Promise<void> {
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
  expect(after.money, '账本凭证、分录与余额').toEqual(before.money);
  const seen = new Set(before.diffs.map((d) => d.id));
  expect(
    after.diffs.filter((d) => seen.has(d.id)),
    '原有差错单',
  ).toEqual(before.diffs);
  expect(
    after.diffs
      .filter((d) => !seen.has(d.id))
      .map((d) => d.type)
      .filter((type) => type !== 'platform_restore'),
    '新增差错单只能是 platform_restore',
  ).toEqual([]);
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

/**
 * 原样重投同一报文之后（附带断言）：新增事件只能是 order.updated；站内信、补差候选、差错单（含 platform_restore）、
 * 账本凭证、分录与余额一条不多。
 */
async function expectResendInert(appId: string, before: SideRows): Promise<void> {
  const after = await sideRows(appId);
  const known = new Set(before.events.map((e) => e.event_id));
  expect(
    after.events
      .filter((e) => !known.has(e.event_id))
      .map((e) => e.name)
      .filter((name) => name !== 'order.updated'),
    '重投新增事件（通知、扣回、补差、入账）',
  ).toEqual([]);
  expect(after.inbox, '重投：站内信').toEqual(before.inbox);
  expect(after.adjustments, '重投：补差候选').toEqual(before.adjustments);
  expect(after.diffs, '重投：差错单').toEqual(before.diffs);
  expect(after.money, '重投：账本凭证、分录与余额').toEqual(before.money);
}

it(
  '[AC-B1-18k#1][BR-CALC-15][BR-CALC-27][BR-FUND-01] VOID（WAITING 单结算 -100 → BASE_ZERO，v2）后结算 -200：commission_version 3 且 v3 有金额行与合计行（B 0、金额 0，n_total -200）；再回正 800：v4 有行（B 800、本人 400、① 800 ④ 400）；仍 VOID、reason 不变，无分录、通知、补差候选、扣回',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app);
      await o.sync();
      await o.sync(received());
      await o.sync(settled(-100n));
      const voided = await o.row();
      expect(voided, '前置：BASE_ZERO 作废，v2').toMatchObject({
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
        settle_commission_fen: -100n,
        commission_version: 2,
      });
      expect(await o.versions(), '前置：v1、v2 有行').toEqual({
        amounts: [1, 2],
        totals: [1, 2],
      });
      const side = await sideRows(app.appId);

      // 负 → 更负。
      await o.sync(settled(-200n, touched(1)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
        settle_commission_fen: -200n,
        commission_version: 3,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await o.amounts(3)).toEqual([[0n, 0n]]);
      expect(await o.fourAmounts(3)).toEqual({
        n_total_fen: -200n,
        pre_base_deduct_fen: -200n,
        base_fen: 0n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: -200n,
      });

      // 附带：原样重投同一报文，版本不再增长，金额行与合计行逐行不变，无重复资金或通知效果。
      const rowsAtV3 = await versionRows(voided);
      const sideAtV3 = await sideRows(app.appId);
      await o.sync(settled(-200n, touched(1)));
      expect((await o.row()).commission_version, '重投不推版本').toBe(3);
      expect(await versionRows(voided), '重投：版本行逐行不变').toEqual(rowsAtV3);
      await expectResendInert(app.appId, sideAtV3);

      // 负 → 正：照推版本、按新 N 写行，状态不变（恢复只经 R12）。
      await o.sync(settled(800n, touched(2)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'COMMISSION_ZERO',
        settle_commission_fen: 800n,
        commission_version: 4,
        booked_base_fen: voided.booked_base_fen,
        booked_n_fen: voided.booked_n_fen,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3, 4], totals: [1, 2, 3, 4] });
      expect(await o.amounts(4)).toEqual([[800n, 400n]]);
      expect(await o.fourAmounts(4)).toEqual({
        n_total_fen: 800n,
        pre_base_deduct_fen: 0n,
        base_fen: 800n,
        user_share_total_fen: 400n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 400n,
      });
      // 终态期间这些行不计入任何待入账（BR-FUND-18 只算 WAITING 与「ESTIMATED 且 PAID」）。
      expect((await o.wallet()).estimated_total_fen).toBe(0n);
      await expectNothingBooked(app.appId, side);

      // 附带：原样重投回正的报文，不再推版本，不再登记 platform_restore，行逐行不变。
      const rowsAtV4 = await versionRows(voided);
      const sideAtV4 = await sideRows(app.appId);
      await o.sync(settled(800n, touched(2)));
      expect((await o.row()).commission_version, '重投不推版本').toBe(4);
      expect(await versionRows(voided), '重投：版本行逐行不变').toEqual(rowsAtV4);
      await expectResendInert(app.appId, sideAtV4);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18k#2][BR-CALC-15][BR-CALC-27][BR-FUND-01] CLAWED_BACK（入账后结算 0 → R8，v2）后结算 -50：commission_version 3 且 v3 有行（B 0、金额 0，n_total -50）；再回正 800：v4 有行（B 800、本人 400）；仍 CLAWED_BACK、reason 与入账基数不变，无分录、通知、补差候选、扣回，余额不变',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = await w.credited(app);
      await o.sync(settled(0n, touched(1)));
      const clawed = await o.row();
      expect(clawed, '前置：R8 整单扣回，v2').toMatchObject({
        rebate_status: 'CLAWED_BACK',
        settle_commission_fen: 0n,
        commission_version: 2,
      });
      expect(await o.versions(), '前置：v1、v2 有行').toEqual({
        amounts: [1, 2],
        totals: [1, 2],
      });
      const balance = await w.available(app);
      const side = await sideRows(app.appId);

      // 0 → 负。
      await o.sync(settled(-50n, touched(2)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        reason: clawed.reason,
        settle_commission_fen: -50n,
        commission_version: 3,
        booked_base_fen: clawed.booked_base_fen,
        booked_n_fen: clawed.booked_n_fen,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await o.amounts(3)).toEqual([[0n, 0n]]);
      expect(await o.fourAmounts(3)).toEqual({
        n_total_fen: -50n,
        pre_base_deduct_fen: -50n,
        base_fen: 0n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: -50n,
      });

      // 附带：原样重投同一报文，版本不再增长，行逐行不变，无重复资金或通知效果。
      const rowsAtV3 = await versionRows(clawed);
      const sideAtV3 = await sideRows(app.appId);
      await o.sync(settled(-50n, touched(2)));
      expect((await o.row()).commission_version, '重投不推版本').toBe(3);
      expect(await versionRows(clawed), '重投：版本行逐行不变').toEqual(rowsAtV3);
      await expectResendInert(app.appId, sideAtV3);

      // 负 → 正：照推版本、按新 N 写行，状态不变（恢复只经 R13）。
      await o.sync(settled(800n, touched(3)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        reason: clawed.reason,
        settle_commission_fen: 800n,
        commission_version: 4,
        booked_base_fen: clawed.booked_base_fen,
        booked_n_fen: clawed.booked_n_fen,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3, 4], totals: [1, 2, 3, 4] });
      expect(await o.amounts(4)).toEqual([[800n, 400n]]);
      expect(await o.fourAmounts(4)).toEqual({
        n_total_fen: 800n,
        pre_base_deduct_fen: 0n,
        base_fen: 800n,
        user_share_total_fen: 400n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 400n,
      });
      await expectNothingBooked(app.appId, side);
      expect(await w.available(app)).toBe(balance);

      // 附带：原样重投回正的报文，不再推版本，行逐行不变，余额不变。
      const rowsAtV4 = await versionRows(clawed);
      const sideAtV4 = await sideRows(app.appId);
      await o.sync(settled(800n, touched(3)));
      expect((await o.row()).commission_version, '重投不推版本').toBe(4);
      expect(await versionRows(clawed), '重投：版本行逐行不变').toEqual(rowsAtV4);
      await expectResendInert(app.appId, sideAtV4);
      expect(await w.available(app)).toBe(balance);
    });
  },
  TIMEOUT,
);
