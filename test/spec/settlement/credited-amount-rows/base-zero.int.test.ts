// B2-04zk 第 2 轮 · 基数为 0 的两种维权（BR-CALC-15、BR-CALC-27、BR-FUND-08；D10-583、D10-792）。入口同
// ./rights-partial.int.test.ts：worker 真实装配的 rights_import 作业 → rights.record → clawback apply（ref rights）。
// #9 新旧基数都为 0 而 N_new 大于 0 的部分维权仍是 R9、保持 CREDITED：只有新 N 与已存值不同时 +1，并按新 N 写该版本
//    金额行。手算：pdd、手续费 0、快照预留 10000 bp、会员份额 50 %（角色 share）。
//      入账 N 1000 → 预留 1000、B 0 → 会员 0、平台 1000；booked 0 / 1000。
//      应扣 4.00 元：N_new 600 → 预留 600、B 0 → 会员 0；扣回会员 0（无凭证）、平台 400；booked 0 / 600；
//      v2 四段：n_total 600、pre_base_deduct 600、base 0、Σ份额 0、红包 0、平台预估毛利 600 − 0 − 0 = 600。
// #10 原基数大于 0 而新基数为 0（0 < N_new）按 R8 BASE_ZERO 转 CLAWED_BACK：不推版本、不写行。快照预留 1000 bp：
//      直接从入账（booked 900 / 1000）应扣 9.99 元：N_new 1 → B_new floor(0.9) = 0；扣回会员 450、平台 550 − 1 = 549；
//        booked 0 / 1，版本仍 1（主干上本来就不推，这一段只作对照）；
//      先应扣 4.00 元推到 v2（540 / 270，主干上为红），再应扣 5.99 元：N_new 600 − 599 = 1 → B_new 0；扣回会员 270、
//        平台 330 − 1 = 329；booked 0 / 1，版本停在 2，没有 v3。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import type { RightsImportJob } from '../../orders/rights-mounts/templates.ts';
import { credited } from '../settle-diff-sync/kit.ts';
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
  versionsOf,
  withRights,
  type Worker,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../../orders/rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const p = databaseFixture(createTestDatabase);

/** The snapshot's pdd reserve of the base-zero order: the whole N is reserve, B 0 (BR-CALC-02). */
const FULL_RESERVE_BP = 10000;

/** A real credit at N 1000 under a 10000 bp snapshot reserve: B 0, member 0, platform 1000. */
async function baseZeroCredited(w: Worker) {
  const { app, o, read } = await credited(p.db, w, { reserveBp: FULL_RESERVE_BP });
  const rows = versionsOf(p.db, app, o);
  expect(await o.row(), 'the base-zero credited order').toMatchObject({
    rebate_status: 'CREDITED',
    commission_version: 1,
    booked_base_fen: 0n,
    booked_n_fen: 1000n,
  });
  expect(await rows.versions(), 'the snapshot version').toEqual({ amounts: [1], totals: [1] });
  expect(await rows.amounts(1), 'the snapshot amount row').toEqual([
    { user_id: app.userId, role: MEMBER_ROLE, base_fen: 0n, amount_fen: 0n },
  ]);
  expect(await w.available(app), 'the member after credit').toBe(0n);
  return { app, o, read, rows };
}

it(
  '[AC-B2-04zk#9][BR-CALC-15][BR-CALC-27][BR-FUND-08] 基数为 0 的已入账单（快照预留 10000 bp，N 1000、B 0、booked 0 / 1000）维权部分成功（应扣 4.00 元 → N_new 600、B_new 0）：仍是 R9、保持 CREDITED，commission_version 1 → 2 与 booked 0 / 600 同一条带 commission_version = 1 乐观锁的 UPDATE；v2 会员行 0 / 0，四段 600 / 600 / 0 / 0 / 0 / 600；只有平台扣回 400，会员无凭证；v1 行不动',
  async () => {
    const traced = tracing(p.db);
    await withRights(traced.db, async (r) => {
      const z = await baseZeroCredited(r.w);
      const v1 = await z.rows.stored(1);
      traced.queries.length = 0;

      const task = await r.imported(z.app, z.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);

      expect(await r.task(z.app, task.importId)).toMatchObject({
        status: 'done',
        total_rows: 1,
        succeeded_rows: 1,
        failed_rows: 0,
      });
      expect(await rightsOf(p.db, z.app, z.o)).toMatchObject([
        { platform_rights_no: 'RN-1', status: 'SUCCEEDED', deduction_commission_fen: 400n },
      ]);
      expect(await z.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 0n,
        booked_n_fen: 600n,
      });
      const writes = versionWrites(traced.queries);
      expect(writes, 'statements writing commission_version').toHaveLength(1);
      expect(writes[0]).toMatchObject({ to: 2, from: 1 });
      expect(writes[0]?.set).toMatch(/"booked_base_fen" = \$\d+/);
      expect(writes[0]?.set).toMatch(/"booked_n_fen" = \$\d+/);

      expect(await z.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await z.rows.amounts(2)).toEqual([
        { user_id: z.app.userId, role: MEMBER_ROLE, base_fen: 0n, amount_fen: 0n },
      ]);
      expect(await z.rows.fourAmounts(2)).toEqual({
        n_total_fen: 600n,
        pre_base_deduct_fen: 600n,
        base_fen: 0n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 600n,
      });
      expect(await z.rows.stored(1)).toEqual(v1);

      const event = await rightsEvent(p.db, z.app, z.o, 'RN-1');
      const house = `${z.read.orderRef}:PLATFORM:CLAWBACK:${event}`;
      const lines = (await z.read.lines())
        .filter((line) => line.uniq_key.endsWith(`:CLAWBACK:${event}`))
        .map(
          (line) =>
            `${line.uniq_key}|${line.subject}|${line.owner_id}|${line.amount_fen}|${line.ledger_type}|${line.sub_type}|${line.sub_account}`,
        )
        .sort();
      expect(lines).toEqual(
        [
          `${house}|COMMISSION_REVENUE|platform|400|CLAWBACK|RIGHTS|available`,
          `${house}|UNION_RECEIVABLE:pdd|platform|-400|CLAWBACK|RIGHTS|available`,
        ].sort(),
      );
      await z.read.balanced();
      expect(await r.w.available(z.app)).toBe(0n);
      expect((await z.read.history()).map((row) => row.event)).toEqual(['RIGHTS_PARTIAL']);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zk#10][BR-FUND-08][BR-CALC-15][BR-FUND-01] 0 < N_new 而 B_new = 0 的维权（R8 BASE_ZERO，转 CLAWED_BACK、booked 0 / 1）不推版本、不写行：先应扣 4.00 元推到 v2 的单再应扣 5.99 元，版本停在 2、没有 v3、没有写版本的语句，扣回 270 / 329；直接从入账应扣 9.99 元的单版本仍 1、只有 v1，扣回 450 / 549；两单的已有版本行都不动',
  async () => {
    const traced = tracing(p.db);
    await withRights(traced.db, async (r) => {
      // After a partial rights deduction pushed v2.
      const pushed = await creditedOrder(p.db, r.w);
      await r.imported(pushed.app, pushed.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);
      expect(await pushed.o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 540n,
        booked_n_fen: 600n,
      });
      expect(await pushed.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await pushed.rows.amounts(2)).toEqual([
        { user_id: pushed.app.userId, role: MEMBER_ROLE, base_fen: 540n, amount_fen: 270n },
      ]);
      const partial = await rightsEvent(p.db, pushed.app, pushed.o, 'RN-1');
      const pushedV1 = await pushed.rows.stored(1);
      const pushedV2 = await pushed.rows.stored(2);
      traced.queries.length = 0;

      await r.imported(pushed.app, pushed.o, [{ rightsNo: 'RN-2', deduction: '5.99' }]);

      expect(await pushed.o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        commission_version: 2,
        booked_base_fen: 0n,
        booked_n_fen: 1n,
      });
      expect(versionWrites(traced.queries), 'statements writing commission_version').toEqual([]);
      expect(await pushed.rows.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await pushed.rows.stored(1)).toEqual(pushedV1);
      expect(await pushed.rows.stored(2)).toEqual(pushedV2);
      const baseZero = await rightsEvent(p.db, pushed.app, pushed.o, 'RN-2');
      expect(await clawbackLines(pushed, partial)).toEqual(
        expectedClawback(pushed, partial, 180n, 220n, 'RIGHTS'),
      );
      expect(await clawbackLines(pushed, baseZero)).toEqual(
        expectedClawback(pushed, baseZero, 270n, 329n, 'RIGHTS'),
      );
      await pushed.read.balanced();
      expect(await pushed.read.balance()).toEqual({ available_fen: 0n, frozen_fen: 0n });
      expect(await eventsAfterCredit(pushed)).toEqual(['RIGHTS_PARTIAL', 'RIGHTS_FULL']);

      // Straight from the credit (booked 900 / 1000): the same R8, nothing to push either.
      const direct = await creditedOrder(p.db, r.w);
      const directV1 = await direct.rows.stored(1);
      traced.queries.length = 0;

      await r.imported(direct.app, direct.o, [{ rightsNo: 'RN-1', deduction: '9.99' }]);

      expect(await direct.o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        commission_version: 1,
        booked_base_fen: 0n,
        booked_n_fen: 1n,
      });
      expect(versionWrites(traced.queries), 'statements writing commission_version').toEqual([]);
      expect(await direct.rows.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(await direct.rows.stored(1)).toEqual(directV1);
      const event = await rightsEvent(p.db, direct.app, direct.o, 'RN-1');
      expect(await clawbackLines(direct, event)).toEqual(
        expectedClawback(direct, event, 450n, 549n, 'RIGHTS'),
      );
      await direct.read.balanced();
      expect(await direct.read.balance()).toEqual({ available_fen: 0n, frozen_fen: 0n });
      expect(await eventsAfterCredit(direct)).toEqual(['RIGHTS_FULL']);
    });
  },
  TIMEOUT,
);
