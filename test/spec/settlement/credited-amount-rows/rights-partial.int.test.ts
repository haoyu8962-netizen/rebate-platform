// B2-04zk · 已入账单维权部分成功（R9，N_new = booked_n − 应扣，BR-FUND-08 ②）之后金额行等于新应得（BR-CALC-15、
// BR-CALC-27；FU-CREDITED-AMOUNT-ROWS 余下，D10-583）；维权全额（R8）不推版本、不写 0 行（D10-792）。入口是 worker 真实
// 装配的 rights_import 作业：rights.record → clawback apply（ref rights）。主干上 apply 不推版本、不写行，每条用例都有
// 在主干上为红的正向断言（版本 2 与 v2 行）。
// 手算：pdd、手续费 0、快照预留 1000 bp、会员份额 50 %（角色 share）。
//   入账 N 1000 → 预留 100、B 900 → 会员 450、平台 550；booked 900 / 1000。
//   应扣 4.00 元：N_new 600 → 预留 60、B 540 → 会员 270、平台 330；扣回会员 180、平台 220；booked 540 / 600；
//     v2 四段：n_total 600、pre_base_deduct 60、base 540、Σ份额 270、红包 0、平台预估毛利 600 − 270 − 0 = 330。
//   之后应扣 12.00 元（不低于 booked_n 600）：R8 RIGHTS_FULL，扣回会员 270、平台 330，booked 0 / 0。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
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
  rightsOf,
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

/** v2 of every partial case here: N_new 600 over the snapshot reserve 1000 bp. */
const FOUR_AMOUNTS_600 = {
  n_total_fen: 600n,
  pre_base_deduct_fen: 60n,
  base_fen: 540n,
  user_share_total_fen: 270n,
  tlj_redpacket_fen: 0n,
  platform_est_profit_fen: 330n,
};

it(
  '[AC-B2-04zk#1][BR-FUND-08][BR-CALC-15][BR-CALC-27] 已入账单维权部分成功（应扣 4.00 元）：commission_version 1 → 2，与 booked 成对值同一条带 commission_version = 1 乐观锁的 UPDATE；v2 按 N_new 600 与快照预留 1000（不是入账后新规则的 5000）重拆：会员 540 / 270，四段 600 / 60 / 540 / 270 / 0 / 330；扣回 180 / 220、booked 540 / 600、RIGHTS_PARTIAL 照旧；v1 行与快照不动',
  async () => {
    const traced = tracing(p.db);
    await withRights(traced.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);
      const v1 = await c.rows.stored(1);
      const { order_id: orderId } = await c.o.row();
      const splits = () =>
        p.db
          .selectFrom('commission_splits')
          .select(['rule_version_id', 'reserve_bp'])
          .where('app_id', '=', c.app.appId)
          .where('order_id', '=', orderId)
          .execute();
      const split = await splits();
      expect(split).toEqual([{ rule_version_id: expect.any(String), reserve_bp: 1000 }]);

      // A rule version published after the credit: the new rows still use the snapshot's reserve.
      const later = version({
        effective_from: new Date('2026-11-25T00:00:00+08:00'),
        reserves: [
          { platform: 'taobao', reserve_bp: 0 },
          { platform: 'jd', reserve_bp: 0 },
          { platform: 'pdd', reserve_bp: 5000 },
        ],
      });
      await seedVersion(p.db, c.app.appId, later);
      r.w.clock.set('2026-11-26T02:00:00.000Z');
      traced.queries.length = 0;

      const task = await r.imported(c.app, c.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);

      expect(await r.task(c.app, task.importId)).toMatchObject({
        status: 'done',
        total_rows: 1,
        succeeded_rows: 1,
        failed_rows: 0,
      });
      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 540n,
        booked_n_fen: 600n,
        diff_reason_code: 'PART_REFUND',
        rights_pending: false,
      });
      const writes = versionWrites(traced.queries);
      expect(writes, 'statements writing commission_version').toHaveLength(1);
      expect(writes[0]).toMatchObject({ to: 2, from: 1 });
      expect(writes[0]?.set).toMatch(/"booked_base_fen" = \$\d+/);
      expect(writes[0]?.set).toMatch(/"booked_n_fen" = \$\d+/);

      expect(await c.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await c.rows.amounts(2)).toEqual([
        { user_id: c.app.userId, role: MEMBER_ROLE, base_fen: 540n, amount_fen: 270n },
      ]);
      expect(await c.rows.fourAmounts(2)).toEqual(FOUR_AMOUNTS_600);
      expect(await c.rows.stored(1)).toEqual(v1);
      expect(await splits()).toEqual(split);

      const event = await rightsEvent(p.db, c.app, c.o, 'RN-1');
      expect(await clawbackLines(c, event)).toEqual(
        expectedClawback(c, event, 180n, 220n, 'RIGHTS'),
      );
      const clawbacks = (await c.read.vouchers()).filter((v) => v.voucher_kind === 'CLAWBACK');
      expect(clawbacks).toHaveLength(2);
      await c.read.balanced();
      expect(await c.read.balance()).toEqual({ available_fen: 270n, frozen_fen: 0n });
      expect(await eventsAfterCredit(c)).toEqual(['RIGHTS_PARTIAL']);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zk#2][BR-FUND-08][BR-FUND-06][BR-CALC-15] 维权先成功而无应扣（WAIT_COMMISSION，不扣、不推版本），同一记录后来带回应扣 4.00 元：这次 R9 才推到 v2，行按 N_new 600 重拆（会员 270，四段 600 / 60 / 540 / 270 / 0 / 330），扣回键是同一 R{order_rights.id}',
  async () => {
    await withRights(p.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);

      await r.imported(c.app, c.o, [{ rightsNo: 'RN-1', deduction: null }]);

      expect(await rightsOf(p.db, c.app, c.o)).toMatchObject([
        { platform_rights_no: 'RN-1', status: 'WAIT_COMMISSION' },
      ]);
      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 1,
        booked_base_fen: 900n,
        booked_n_fen: 1000n,
        rights_pending: true,
      });
      expect(await c.rows.versions()).toEqual({ amounts: [1], totals: [1] });
      const event = await rightsEvent(p.db, c.app, c.o, 'RN-1');
      expect(await clawbackLines(c, event)).toEqual([]);

      await r.imported(c.app, c.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);

      expect(await rightsOf(p.db, c.app, c.o)).toMatchObject([
        { platform_rights_no: 'RN-1', status: 'SUCCEEDED', deduction_commission_fen: 400n },
      ]);
      expect(await rightsEvent(p.db, c.app, c.o, 'RN-1')).toBe(event);
      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 540n,
        booked_n_fen: 600n,
      });
      expect(await c.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await c.rows.amounts(2)).toEqual([
        { user_id: c.app.userId, role: MEMBER_ROLE, base_fen: 540n, amount_fen: 270n },
      ]);
      expect(await c.rows.fourAmounts(2)).toEqual(FOUR_AMOUNTS_600);
      expect(await clawbackLines(c, event)).toEqual(
        expectedClawback(c, event, 180n, 220n, 'RIGHTS'),
      );
      expect(await c.read.balance()).toEqual({ available_fen: 270n, frozen_fen: 0n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zk#3][BR-CALC-15][BR-FUND-08][BR-FUND-06] 同一维权记录重投不再推版本、不再写行（与凭证幂等一致）：已完成的作业重投两次、同一文件重新上传（duplicate_rows 1）都一行不动；之后应扣 0.00 元的新记录规划无变化：版本仍 2，没有 v3，也没有写版本的语句',
  async () => {
    const traced = tracing(p.db);
    await withRights(traced.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);
      const line = { rightsNo: 'RN-1', deduction: '4.00' } as const;
      const first = await r.imported(c.app, c.o, [line]);
      expect(await c.o.row()).toMatchObject({ commission_version: 2, booked_n_fen: 600n });
      expect(await c.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      const before = await c.state();
      traced.queries.length = 0;

      await first.run();
      await first.run();
      expect(await c.state()).toEqual(before);

      const again = await r.imported(c.app, c.o, [line]);
      expect(await r.task(c.app, again.importId)).toMatchObject({
        status: 'done',
        total_rows: 1,
        succeeded_rows: 0,
        duplicate_rows: 1,
      });
      expect(await c.state()).toEqual(before);
      expect(versionWrites(traced.queries)).toEqual([]);

      const zero = await r.imported(c.app, c.o, [{ rightsNo: 'RN-2', deduction: '0.00' }]);
      expect(await r.task(c.app, zero.importId)).toMatchObject({
        status: 'done',
        succeeded_rows: 1,
      });
      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 540n,
        booked_n_fen: 600n,
      });
      const after = await c.state();
      expect(after.versions).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(after.stored).toEqual(before.stored);
      expect(after.lines).toEqual(before.lines);
      expect(after.balance).toEqual({ available_fen: 270n, frozen_fen: 0n });
      expect(versionWrites(traced.queries)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zk#4][BR-FUND-08][BR-CALC-15][BR-FUND-01] 部分维权推到 v2 之后，再来一条全额维权（应扣 12.00 元不低于 booked_n 600）：R8 RIGHTS_FULL 转 CLAWED_BACK、原因 RIGHTS、booked 0 / 0，扣回 270 / 330；版本停在 2，没有 v3、没有 0 行，v1 / v2 行不动',
  async () => {
    const traced = tracing(p.db);
    await withRights(traced.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);
      await r.imported(c.app, c.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);
      expect(await c.o.row()).toMatchObject({ commission_version: 2, booked_n_fen: 600n });
      expect(await c.rows.amounts(2)).toEqual([
        { user_id: c.app.userId, role: MEMBER_ROLE, base_fen: 540n, amount_fen: 270n },
      ]);
      const partial = await rightsEvent(p.db, c.app, c.o, 'RN-1');
      const v1 = await c.rows.stored(1);
      const v2 = await c.rows.stored(2);
      traced.queries.length = 0;

      await r.imported(c.app, c.o, [{ rightsNo: 'RN-2', deduction: '12.00' }]);

      expect(await c.o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        reason: 'RIGHTS',
        commission_version: 2,
        booked_base_fen: 0n,
        booked_n_fen: 0n,
      });
      expect(versionWrites(traced.queries)).toEqual([]);
      expect(await c.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await c.rows.stored(1)).toEqual(v1);
      expect(await c.rows.stored(2)).toEqual(v2);
      const full = await rightsEvent(p.db, c.app, c.o, 'RN-2');
      expect(await clawbackLines(c, partial)).toEqual(
        expectedClawback(c, partial, 180n, 220n, 'RIGHTS'),
      );
      expect(await clawbackLines(c, full)).toEqual(expectedClawback(c, full, 270n, 330n, 'RIGHTS'));
      await c.read.balanced();
      expect(await c.read.balance()).toEqual({ available_fen: 0n, frozen_fen: 0n });
      expect(await eventsAfterCredit(c)).toEqual(['RIGHTS_PARTIAL', 'RIGHTS_FULL']);
    });
  },
  TIMEOUT,
);
