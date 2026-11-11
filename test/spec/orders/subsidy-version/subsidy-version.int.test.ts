// B1-18i · 补贴类佣金单独变化让 commission_version +1（BR-CALC-15 一览、BR-CALC-27 细则「仅补贴变化的版本」；
// D10-1257、D10-1258）。经生产 worker 的订单同步流水线（../../commission/version-rule/kit.ts 的 withRule：真实
// pipeline、update step、rebate 端口、commission 估值、出账与入账），不注入替身。
// 规则：有效 N 不变而订单补贴与当前版本记录的补贴不同 → +1；新版本各受益人份额与 base 与上一版本逐项相同，只按新
// 补贴重算 n_total / 基数前扣除 / 平台预估利润；不改 rebate_status，不写分录，不发通知，不生成补差候选，不扣回。
// 空值与 0 相同；报文平台更新时间早于订单当前记录的不因补贴写新版本（相等照常处理）；同一报文重投不写。
// 夹具：拼多多、服务费 0、预留 0、本人 50 %、无邀请人。手算：N 1000 → B 1000 → 500；N 1200 → B 1200 → 600。
// 补贴 S 的版本：① 1000 + S，② S，③ 1000，用户 500，④ 500 + S（淘礼金红包 0）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { estimatesOf } from '../../commission/estimate-port/kit.ts';
import {
  BILL_AT,
  TIMEOUT,
  databaseFixture,
  moneyRows,
  received,
  settled,
  withRule,
} from '../../commission/version-rule/kit.ts';

const p = databaseFixture(createTestDatabase);

/** 默认报文的平台更新时间（settlement-records kit 的 order() 默认 modified_at）。 */
const MODIFIED_AT = '2026-10-20T03:00:00.000Z';
/** 早于订单当前记录的平台更新时间。 */
const EARLIER_AT = '2026-10-20T02:00:00.000Z';

interface OrderRef {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
}

/** 该单每个版本的合计行（四段金额与该版本所用补贴），版本升序。 */
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

/** 补贴 S、N 1000 的一个版本的合计行（见文件头手算）。 */
function totalsWithSubsidy(version: number, subsidy: bigint) {
  return {
    commission_version: version,
    n_total_fen: 1000n + subsidy,
    pre_base_deduct_fen: subsidy,
    base_fen: 1000n,
    user_share_total_fen: 500n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: 500n + subsidy,
    subsidy_commission_fen: subsidy,
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
    diffs: await p.db.selectFrom('recon_diffs').selectAll().where('app_id', '=', appId).execute(),
    money: await moneyRows(p.db, appId),
  };
}

type SideRows = Awaited<ReturnType<typeof sideRows>>;

/** 之后新增的事件只能是同步本身的 order.updated；其余各类行原样。 */
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

/** R7 维权重定价问的那一句（compareN）：以 N 问 bases，N 与最新版本存的 N 是否不同（B1-18f storedN）。 */
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

it.each(['WAITING', 'ESTIMATED'] as const)(
  '[AC-B1-18i#1][AC-B1-18i#2][AC-B1-18i#5][BR-CALC-15][BR-CALC-27] %s：N 不变（结算 1000 = 预估）、补贴 200 → 350 → commission_version 变 2；v2 合计行补贴 350、① 1350 ② 350 ④ 850，份额与 base 与 v1 逐项相同；返利状态不变，无分录、通知、补差候选；同一报文重投不再 +1',
  async (state) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      // 不认的 period_basis 让订单留在 ESTIMATED（AC-B1-09n#11，同 AC-B2-03s#5）。
      if (state === 'ESTIMATED') await w.setConfig(app, 'settle.period_basis.pdd', 'settled_at');
      const o = w.order(app, { subsidy_commission_fen: 200n });
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      const before = await o.row();
      expect(before, '前置：已结算、N 1000 未推版本').toMatchObject({
        rebate_status: state,
        est_commission_fen: 1000n,
        settle_commission_fen: 1000n,
        subsidy_commission_fen: 200n,
        commission_version: 1,
      });
      expect(await totalsOf(before), '前置：v1 合计行').toEqual([totalsWithSubsidy(1, 200n)]);
      const side = await sideRows(app.appId);

      const report = settled(1000n, { subsidy_commission_fen: 350n });
      await o.sync(report);

      expect(await o.row()).toMatchObject({
        rebate_status: state,
        est_commission_fen: 1000n,
        settle_commission_fen: 1000n,
        subsidy_commission_fen: 350n,
        commission_version: 2,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(2)).toEqual(await o.amounts(1));
      expect(await o.amounts(2)).toEqual([[1000n, 500n]]);
      expect(await totalsOf(before)).toEqual([
        totalsWithSubsidy(1, 200n),
        totalsWithSubsidy(2, 350n),
      ]);
      expect(w.moves(), 'commission_moved：收货、结算不推，补贴变化推').toEqual([
        false,
        false,
        true,
      ]);
      await expectNoSideEffects(app.appId, side);
      // R7 维权重定价（B1-18f storedN）：v2 存的 N 是 1350 − 350 = 1000，同 N 不判变化。
      expect(await nChanged(before, 1000n)).toBe(false);
      expect(await nChanged(before, 1350n)).toBe(true);

      // 同一报文重投：不 +1、不写新版本。
      await o.sync(report);
      expect((await o.row()).commission_version).toBe(2);
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      await expectNoSideEffects(app.appId, side);
    });
  },
  TIMEOUT,
);

it.each([
  { start: null, other: 0n },
  { start: 0n, other: null },
])(
  '[AC-B1-18i#3][BR-CALC-27][BR-CALC-15] 补贴空值与 0 相同：$start ↔ $other 来回变不 +1；变成 350 才 +1（v2 补贴 350、① 1350），再变为空 +1（v3 补贴记 0、① 1000），之后 0 ↔ 空仍不 +1',
  async ({ start, other }) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, { subsidy_commission_fen: start });
      await o.sync();
      const row = await o.row();
      expect(row, '前置：PAID、未结算').toMatchObject({
        rebate_status: 'ESTIMATED',
        subsidy_commission_fen: start,
        commission_version: 1,
      });
      expect(await totalsOf(row), '前置：v1 合计行补贴记 0').toEqual([totalsWithSubsidy(1, 0n)]);

      await o.sync({ subsidy_commission_fen: other });
      await o.sync({ subsidy_commission_fen: start });
      await o.sync({ subsidy_commission_fen: other });
      expect(await o.row()).toMatchObject({ subsidy_commission_fen: other, commission_version: 1 });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });

      await o.sync({ subsidy_commission_fen: 350n });
      expect(await o.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        subsidy_commission_fen: 350n,
        commission_version: 2,
      });
      expect(await o.amounts(2)).toEqual([[1000n, 500n]]);

      await o.sync({ subsidy_commission_fen: null });
      expect(await o.row()).toMatchObject({ subsidy_commission_fen: null, commission_version: 3 });
      expect(await o.amounts(3)).toEqual([[1000n, 500n]]);

      await o.sync({ subsidy_commission_fen: 0n });
      await o.sync({ subsidy_commission_fen: null });
      expect((await o.row()).commission_version).toBe(3);
      expect(await totalsOf(row)).toEqual([
        totalsWithSubsidy(1, 0n),
        totalsWithSubsidy(2, 350n),
        totalsWithSubsidy(3, 0n),
      ]);
      expect(w.moves()).toEqual([false, false, false, true, true, false, false]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18i#4][BR-CALC-27][BR-FUND-02] 平台更新时间与订单当前记录相等、只补贴不同 → 照常 +1；N 与补贴同变只 +1 一次（取当时补贴）；更早的报文只补贴不同 → 不 +1',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, {
        subsidy_commission_fen: 200n,
        modified_at: new Date(MODIFIED_AT),
      });
      await o.sync();
      const row = await o.row();
      expect(row, '前置：订单当前记录的平台更新时间').toMatchObject({
        platform_modified_at: new Date(MODIFIED_AT),
        commission_version: 1,
      });

      // 时间相等、内容不同（只补贴）：照常处理。
      await o.sync({ subsidy_commission_fen: 350n, modified_at: new Date(MODIFIED_AT) });
      expect(await o.row()).toMatchObject({ subsidy_commission_fen: 350n, commission_version: 2 });
      expect(await o.amounts(2)).toEqual([[1000n, 500n]]);
      expect(await totalsOf(row)).toEqual([totalsWithSubsidy(1, 200n), totalsWithSubsidy(2, 350n)]);

      // N 与补贴同变：只 +1 一次，v3 按 N 1200、当时补贴 400。
      await o.sync({
        est_commission_fen: 1200n,
        subsidy_commission_fen: 400n,
        modified_at: new Date(MODIFIED_AT),
      });
      expect(await o.row()).toMatchObject({
        est_commission_fen: 1200n,
        subsidy_commission_fen: 400n,
        commission_version: 3,
      });
      expect(await o.amounts(3)).toEqual([[1200n, 600n]]);
      expect((await totalsOf(row))[2]).toEqual({
        commission_version: 3,
        n_total_fen: 1600n,
        pre_base_deduct_fen: 400n,
        base_fen: 1200n,
        user_share_total_fen: 600n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 1000n,
        subsidy_commission_fen: 400n,
      });

      // 更早的报文（N 不变）只补贴不同：不因补贴写新版本。
      await o.sync({
        est_commission_fen: 1200n,
        subsidy_commission_fen: 500n,
        modified_at: new Date(EARLIER_AT),
      });
      expect((await o.row()).commission_version).toBe(3);
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(w.moves().slice(0, 2)).toEqual([true, true]);
      expect(w.moves().slice(2), '更早的报文不推版本').not.toContain(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18i#6][AC-B1-18i#2][BR-CALC-15][BR-CALC-27][BR-CALC-23] CREDITED：已入账单 N 不变、补贴 200 → 350 → commission_version 变 2，份额与 base 与 v1 相同，v2 补贴 350、① 1350 ④ 850；仍 CREDITED、入账基数不变，无分录、扣回、补差候选、通知，余额不变',
  async () => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      // 同 version-rule kit 的 credited()，只是 v1 带补贴 200：付款、收货、结算 1000、出账、确认执行。
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app, { subsidy_commission_fen: 200n });
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      w.clock.set(BILL_AT);
      await w.bill(app);
      await w.confirmAndExecute(app);
      const before = await o.row();
      expect(before, '前置：已入账').toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
        subsidy_commission_fen: 200n,
        commission_version: 1,
      });
      expect(await w.available(app), '前置：本人到账 500').toBe(500n);
      expect(await totalsOf(before), '前置：v1 合计行').toEqual([totalsWithSubsidy(1, 200n)]);
      const side = await sideRows(app.appId);

      await o.sync(settled(1000n, { subsidy_commission_fen: 350n }));

      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
        settle_commission_fen: 1000n,
        subsidy_commission_fen: 350n,
        commission_version: 2,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(2)).toEqual(await o.amounts(1));
      expect(await o.amounts(2)).toEqual([[1000n, 500n]]);
      expect(await totalsOf(before)).toEqual([
        totalsWithSubsidy(1, 200n),
        totalsWithSubsidy(2, 350n),
      ]);
      expect(w.moves().at(-1), '本次 commission_moved').toBe(true);
      await expectNoSideEffects(app.appId, side);
      expect(await w.available(app)).toBe(500n);
    });
  },
  TIMEOUT,
);
