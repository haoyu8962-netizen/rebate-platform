// B2-04zk · 同步带来新佣金的 R10 / R9 与维权应扣的 R9 在同一张已入账单上先后发生（BR-CALC-15、BR-CALC-27、BR-FUND-08、
// BR-FUND-09、BR-FUND-01「R9 与 R9b 的判定」；D10-583）。同步那次版本只由 orders 的同步 CAS 推一次（apply 的 N_new 来源
// 不是维权应扣，不再推），行等于新结算额重拆；维权应扣那次由 apply 推一次。主干上维权那次不推，故两条用例在主干上都红。
// 手算：pdd、手续费 0、快照预留 1000 bp、会员份额 50 %（角色 share）；入账 N 1000 → B 900、会员 450、平台 550。
//   R10 结算 800：预留 80、B 720 → 会员 360、平台 440；SETTLE_ADJUST ADJ:2 会员 90、平台 110；booked 720 / 800。
//     之后应扣 2.00 元：N_new 600 → B 540 → 会员 270、平台 330；扣回 90 / 110；booked 540 / 600。
//   应扣 4.00 元：N_new 600 → B 540、会员 270、平台 330；booked 540 / 600。
//     之后退款数量增加并同步新结算 500：预留 50、B 450 → 会员 225、平台 275；R9 扣回 45 / 55；booked 450 / 500。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import type { RightsImportJob } from '../../orders/rights-mounts/templates.ts';
import {
  MEMBER_ROLE,
  TIMEOUT,
  clawbackLines,
  creditedOrder,
  databaseFixture,
  eventsAfterCredit,
  expectedClawback,
  rightsEvent,
  settled,
  touched,
  tracing,
  versionWrites,
  withRights,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../../orders/rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zk#5][BR-FUND-09][BR-CALC-15][BR-CALC-27][BR-FUND-08] R10（新结算 800）只由 orders 推到 v2 一次，v2 = 720 / 360、四段 800 / 80 / 720 / 360 / 0 / 440；之后维权应扣 2.00 元（N_new = 800 − 200 = 600）由 apply 推到 v3 一次，v3 = 540 / 270、四段 600 / 60 / 540 / 270 / 0 / 330；扣回 90 / 110，booked 540 / 600；v1、v2 不动',
  async () => {
    const traced = tracing(p.db);
    await withRights(traced.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);
      traced.queries.length = 0;

      await c.o.sync(settled(800n, touched(1)));

      expect(versionWrites(traced.queries).map((write) => write.to)).toEqual([2]);
      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 720n,
        booked_n_fen: 800n,
      });
      await c.read.adjustment(2, 90n, 110n);
      expect(await c.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await c.rows.amounts(2)).toEqual([
        { user_id: c.app.userId, role: MEMBER_ROLE, base_fen: 720n, amount_fen: 360n },
      ]);
      expect(await c.rows.fourAmounts(2)).toEqual({
        n_total_fen: 800n,
        pre_base_deduct_fen: 80n,
        base_fen: 720n,
        user_share_total_fen: 360n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 440n,
      });
      const v1 = await c.rows.stored(1);
      const v2 = await c.rows.stored(2);
      traced.queries.length = 0;

      await r.imported(c.app, c.o, [{ rightsNo: 'RN-1', deduction: '2.00' }]);

      expect(versionWrites(traced.queries).map((write) => [write.to, write.from])).toEqual([
        [3, 2],
      ]);
      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 3,
        booked_base_fen: 540n,
        booked_n_fen: 600n,
      });
      expect(await c.rows.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await c.rows.amounts(3)).toEqual([
        { user_id: c.app.userId, role: MEMBER_ROLE, base_fen: 540n, amount_fen: 270n },
      ]);
      expect(await c.rows.fourAmounts(3)).toEqual({
        n_total_fen: 600n,
        pre_base_deduct_fen: 60n,
        base_fen: 540n,
        user_share_total_fen: 270n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 330n,
      });
      expect(await c.rows.stored(1)).toEqual(v1);
      expect(await c.rows.stored(2)).toEqual(v2);
      const event = await rightsEvent(p.db, c.app, c.o, 'RN-1');
      expect(await clawbackLines(c, event)).toEqual(
        expectedClawback(c, event, 90n, 110n, 'RIGHTS'),
      );
      await c.read.balanced();
      expect(await c.read.balance()).toEqual({ available_fen: 270n, frozen_fen: 0n });
      expect(await eventsAfterCredit(c)).toEqual(['SETTLE_NEGATIVE_DIFF', 'RIGHTS_PARTIAL']);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zk#6][BR-FUND-01][BR-FUND-08][BR-CALC-15][BR-CALC-27] 维权应扣 4.00 元由 apply 推到 v2（540 / 270）之后，退款数量增加并同步新结算 500（R9，N_new 取新结算额）：版本只由 orders 推一次到 v3，apply 不再推；v3 = 450 / 225、四段 500 / 50 / 450 / 225 / 0 / 275；扣回 45 / 55 键 C3，booked 450 / 500；v1、v2 不动',
  async () => {
    const traced = tracing(p.db);
    await withRights(traced.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);
      await r.imported(c.app, c.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);
      expect(await c.o.row()).toMatchObject({
        commission_version: 2,
        booked_base_fen: 540n,
        booked_n_fen: 600n,
      });
      expect(await c.rows.amounts(2)).toEqual([
        { user_id: c.app.userId, role: MEMBER_ROLE, base_fen: 540n, amount_fen: 270n },
      ]);
      const v1 = await c.rows.stored(1);
      const v2 = await c.rows.stored(2);
      // UnionOrder has no quantity fields: the orders-owned fact onUpdated reads is seeded; the new
      // settlement itself enters through the production pipeline (settle-diff-sync [AC-B2-04zi#5]).
      await p.db
        .updateTable('orders')
        .set({ quantity: 4, refunded_quantity: 1, refunded_quantity_at_credit: 0 })
        .where('app_id', '=', c.app.appId)
        .where('order_id', '=', (await c.o.row()).order_id)
        .execute();
      traced.queries.length = 0;

      await c.o.sync(settled(500n, touched(1)));

      expect(versionWrites(traced.queries).map((write) => write.to)).toEqual([3]);
      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        settle_commission_fen: 500n,
        commission_version: 3,
        booked_base_fen: 450n,
        booked_n_fen: 500n,
      });
      expect(await c.rows.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect(await c.rows.amounts(3)).toEqual([
        { user_id: c.app.userId, role: MEMBER_ROLE, base_fen: 450n, amount_fen: 225n },
      ]);
      expect(await c.rows.fourAmounts(3)).toEqual({
        n_total_fen: 500n,
        pre_base_deduct_fen: 50n,
        base_fen: 450n,
        user_share_total_fen: 225n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 275n,
      });
      expect(await c.rows.stored(1)).toEqual(v1);
      expect(await c.rows.stored(2)).toEqual(v2);
      expect(await clawbackLines(c, 'C3')).toEqual(
        expectedClawback(c, 'C3', 45n, 55n, 'PART_REFUND'),
      );
      await c.read.balanced();
      expect(await c.read.balance()).toEqual({ available_fen: 225n, frozen_fen: 0n });
      expect(await eventsAfterCredit(c)).toEqual(['RIGHTS_PARTIAL', 'PARTIAL_REFUND']);
    });
  },
  TIMEOUT,
);
