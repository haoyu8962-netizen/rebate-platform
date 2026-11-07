// B2-04zk · 推版本与写行和扣回同事务（BR-CALC-15「同一事务」、BR-CALC-27「同一事务」、BR-FUND-08 同事务成对更新 booked；
// 规划/02 §18）：同事务的 order.clawed_back 发布失败时版本、金额行、凭证、booked、维权记录一起回滚，作业重投只写一次；
// 另一 app 的同状态单不受影响。手算同 ./rights-partial.int.test.ts：入账 N 1000、快照预留 1000 bp → B 900、会员 450；
// 应扣 4.00 元 → N_new 600、B 540、会员 270，扣回 180 / 220，booked 540 / 600。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import type { RightsImportJob } from '../../orders/rights-mounts/templates.ts';
import {
  MEMBER_ROLE,
  TIMEOUT,
  clawbackLines,
  clawedBackEvents,
  creditedOrder,
  databaseFixture,
  expectedClawback,
  failAfter,
  rightsEvent,
  rightsOf,
  withRights,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../../orders/rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const p = databaseFixture(createTestDatabase);

const FOUR_AMOUNTS_600 = {
  n_total_fen: 600n,
  pre_base_deduct_fen: 60n,
  base_fen: 540n,
  user_share_total_fen: 270n,
  tlj_redpacket_fen: 0n,
  platform_est_profit_fen: 330n,
};

it(
  '[AC-B2-04zk#7][BR-CALC-15][BR-CALC-27][BR-FUND-08] 同事务发布 order.clawed_back 失败：版本、v2 行、扣回凭证、booked、余额、维权记录随行事务一起回滚，任务仍 running；重投后版本只推一次到 v2，行与凭证各一份，事件一条',
  async () => {
    let armed = false;
    const faulty = failAfter(p.db, (query) => {
      if (!armed) return false;
      if (!/^insert into (?:"app"\.)?"event_log"/i.test(query.sql)) return false;
      if (!query.parameters.includes('order.clawed_back')) return false;
      armed = false;
      return true;
    });
    await withRights(faulty.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);
      const before = await c.state();
      const task = await r.queued(c.app, c.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);

      armed = true;
      await expect(task.run()).rejects.toThrow('injected failure');
      expect(faulty.injected(), 'the failed publish').toBe(1);

      expect(await c.state()).toEqual(before);
      expect(await rightsOf(p.db, c.app, c.o)).toEqual([]);
      expect(await clawedBackEvents(p.db, c.app)).toEqual([]);
      expect(await r.task(c.app, task.importId)).toMatchObject({
        status: 'running',
        total_rows: 0,
      });

      await task.run();

      expect(await r.task(c.app, task.importId)).toMatchObject({
        status: 'done',
        total_rows: 1,
        succeeded_rows: 1,
        duplicate_rows: 0,
      });
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
      const event = await rightsEvent(p.db, c.app, c.o, 'RN-1');
      expect(await clawbackLines(c, event)).toEqual(
        expectedClawback(c, event, 180n, 220n, 'RIGHTS'),
      );
      const clawbacks = (await c.read.vouchers()).filter((v) => v.voucher_kind === 'CLAWBACK');
      expect(clawbacks).toHaveLength(2);
      expect(await c.read.balance()).toEqual({ available_fen: 270n, frozen_fen: 0n });
      expect(await clawedBackEvents(p.db, c.app)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zk#8][BR-CALC-15][BR-CALC-27] 另一 app 的同状态已入账单不受影响：本 app 维权应扣 4.00 元推到 v2（540 / 270），另一 app 的单仍是 v1、只有 v1 行、booked 900 / 1000、余额 450、无扣回无维权记录，一行不变',
  async () => {
    await withRights(p.db, async (r) => {
      const mine = await creditedOrder(p.db, r.w);
      const other = await creditedOrder(p.db, r.w);
      expect(other.app.appId).not.toBe(mine.app.appId);
      const untouched = await other.state();

      await r.imported(mine.app, mine.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);

      expect(await mine.o.row()).toMatchObject({
        commission_version: 2,
        booked_base_fen: 540n,
        booked_n_fen: 600n,
      });
      expect(await mine.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await mine.rows.amounts(2)).toEqual([
        { user_id: mine.app.userId, role: MEMBER_ROLE, base_fen: 540n, amount_fen: 270n },
      ]);
      expect(await mine.rows.fourAmounts(2)).toEqual(FOUR_AMOUNTS_600);

      expect(await other.state()).toEqual(untouched);
      expect(await other.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 1,
        booked_base_fen: 900n,
        booked_n_fen: 1000n,
      });
      expect(await other.rows.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(await rightsOf(p.db, other.app, other.o)).toEqual([]);
      expect(await other.read.balance()).toEqual({ available_fen: 450n, frozen_fen: 0n });
    });
  },
  TIMEOUT,
);
