// B1-18k 第 3 次（D10-1273，Codex spec-test r2 余下的 S1）· 终态订单仅补贴变化的版本，份额逐项沿用上一版本、不按订单
// 佣金重分（BR-CALC-15 一览终态一路、BR-CALC-27 细则「仅补贴变化的版本」；D10-1272、D10-1258）。
// subsidy.int.test.ts 里上一版本的份额（800 / 400）恰好等于按订单佣金列重分的结果，终态仅补贴分支错调普通 refresh
// 也能过；这里让上一版本的 N 与订单佣金列不同：R7 维权重定价后 v2 base 600、本人 300，订单佣金列仍 1000。
// 经生产 worker 的订单同步流水线（../../commission/version-rule/kit.ts 的 withRule），不注入替身；R7 走 worker 装配的
// 维权同步写入方（createRightsSyncWriter 的返回值，驱动方式只读借鉴 ../../orders/subsidy-version/version-basis.int.test.ts），
// 失效走拼多多原始码 4（specs/order-status-map/pdd.csv：PLATFORM_INVALID → R6 VOID，reason REFUND，不改佣金）。
// 夹具：拼多多、服务费 0、预留 0、本人 50 %、无邀请人，报文补贴 200、佣金 1000。手算：
//   v1：N 1000 → B 1000，本人 500；① 1000 + 200 = 1200，② 1200 − 1000 = 200，④ 1200 − 500 − 0 = 700，补贴 200。
//   v2（R7，应扣 400）：N_new 600 → B 600，本人 300；① 600 + 200 = 800，② 800 − 600 = 200，④ 800 − 300 − 0 = 500，补贴 200。
//   VOID（R6）不推版本：佣金列 1000、补贴 200 都没变，仍是 v2。
//   v3（终态、仅补贴 200 → 350）：份额与 base 照抄 v2（600 / 300）；上一版存的 N = v2 的 ① − 补贴 = 800 − 200 = 600；
//   ① 600 + 350 = 950，② 950 − 600 = 350，③ 600，用户 300，④ 950 − 300 − 0 = 650，补贴 350。
//   按订单佣金列错误重分会得 B 1000、本人 500（① 1350 ② 350 ④ 850），本例据此区分。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import * as rightsSync from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import {
  TIMEOUT,
  databaseFixture,
  moneyRows,
  touched,
  withRule,
} from '../../commission/version-rule/kit.ts';

const p = databaseFixture(createTestDatabase);

/** specs/order-status-map/pdd.csv：4 = 审核失败，PLATFORM_INVALID。 */
const PDD_INVALID = '4';

interface OrderRef {
  readonly app_id: string;
  readonly order_id: string;
}

/** 一个版本的合计行：版本、① n_total、② 基数前扣除、③ base、Σ用户份额、④ 平台预估利润、该版本所用补贴；淘礼金红包 0。 */
function totals(
  version: number,
  nTotal: bigint,
  preBase: bigint,
  base: bigint,
  users: bigint,
  profit: bigint,
  subsidy: bigint,
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

/** 之后新增的事件只能是同步本身的 order.updated；其余各类行原样（不写分录、不通知、不补差、不扣回）。 */
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
  '[AC-B1-18k#3][BR-CALC-15][BR-CALC-27][BR-FUND-01] VOID：预估 1000 的单经 worker 的维权同步写入方部分维权成功（应扣 400，R7）→ v2 base 600、本人 300，订单佣金列仍 1000；平台失效（拼多多 4，R6 → VOID，不推版本）；再 N 不变、补贴 200 → 350 → commission_version 3，v3 (user_id, role, base_fen, amount_fen) 与 v2 整行相同（600 / 300，不是 1000 / 500），合计行补贴 350、① 950 ② 350 ③ 600 ④ 650；仍 VOID、reason 不变，无分录、通知、补差候选、扣回',
  async () => {
    const writers = vi.spyOn(rightsSync, 'createRightsSyncWriter');
    try {
      await withRule(p.db, async (w) => {
        expect(writers, 'the rights-sync writer of the worker entry').toHaveBeenCalledTimes(1);
        const made = writers.mock.results[0];
        if (made?.type !== 'return') {
          throw new Error('B1-18k: the worker built no rights-sync writer');
        }
        const writer = made.value;
        const app = await w.app();
        const o = w.order(app, { subsidy_commission_fen: 200n });
        await o.sync();
        const row = await o.row();
        expect(row, '前置：v1').toMatchObject({
          rebate_status: 'ESTIMATED',
          est_commission_fen: 1000n,
          subsidy_commission_fen: 200n,
          commission_version: 1,
        });
        expect(await sharesOf(row, 1), '前置：v1 本人 1000 / 500').toEqual([
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
              platform_rights_no: `synthetic-b1-18k-rights-${o.subOrderId}`,
            },
          ),
          '前置：R7 写入成功',
        ).toEqual({ kind: 'applied' });
        expect(await o.row(), '前置：R7 推到 v2，佣金列不动').toMatchObject({
          rebate_status: 'ESTIMATED',
          est_commission_fen: 1000n,
          subsidy_commission_fen: 200n,
          commission_version: 2,
        });
        const repriced = [{ user_id: app.userId, role: 'share', base_fen: 600n, amount_fen: 300n }];
        expect(await sharesOf(row, 2), '前置：v2 按 N_new 600').toEqual(repriced);
        const v2Totals = totals(2, 800n, 200n, 600n, 300n, 500n, 200n);
        expect((await totalsOf(row))[1], '前置：v2 合计行').toEqual(v2Totals);

        // 平台失效：拼多多 4 → R6 VOID，佣金与补贴都不变，不推版本。
        await o.sync({ raw_status: PDD_INVALID, ...touched(1) });
        const voided = await o.row();
        expect(voided, '前置：R6 进 VOID，仍 v2').toMatchObject({
          platform_status: 'INVALID',
          rebate_status: 'VOID',
          reason: 'REFUND',
          est_commission_fen: 1000n,
          subsidy_commission_fen: 200n,
          commission_version: 2,
        });
        expect(await o.versions(), '前置：v1、v2 有行').toEqual({
          amounts: [1, 2],
          totals: [1, 2],
        });
        expect(await sharesOf(row, 2), '前置：v2 行原样').toEqual(repriced);
        const balance = await w.available(app);
        const side = await sideRows(app.appId);

        // 终态期间仅补贴变化：N 不变（佣金列 1000、v2 存的 N 600 都没动），补贴 200 → 350，平台更新时间更晚。
        await o.sync({ raw_status: PDD_INVALID, ...touched(2), subsidy_commission_fen: 350n });

        expect(await o.row()).toMatchObject({
          rebate_status: 'VOID',
          reason: voided.reason,
          est_commission_fen: 1000n,
          subsidy_commission_fen: 350n,
          commission_version: 3,
          booked_base_fen: voided.booked_base_fen,
          booked_n_fen: voided.booked_n_fen,
        });
        expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
        expect(await sharesOf(row, 3), 'v3 份额与 base 逐项同 v2').toEqual(await sharesOf(row, 2));
        expect(await sharesOf(row, 3), 'v3 是 600 / 300，不按订单佣金列 1000 重分').toEqual(
          repriced,
        );
        const v3Totals = totals(3, 950n, 350n, 600n, 300n, 650n, 350n);
        expect((await totalsOf(row)).slice(1), 'v2 原样，v3 按 v2 的 N 加新补贴').toEqual([
          v2Totals,
          v3Totals,
        ]);
        await expectNoSideEffects(app.appId, side);
        expect(await w.available(app)).toBe(balance);
      });
    } finally {
      writers.mockRestore();
    }
  },
  TIMEOUT,
);
