// B2-04zk 第 2 轮 · 扣回那条带守卫的 orders CAS 落空一次（BR-CALC-15「更新语句必须带 WHERE commission_version =
// :expected 乐观锁，冲突时重读后重算」；BR-FUND-08 同事务成对更新 booked）。确定性交错：worker 的执行器上挂一个只生效
// 一次的插件，把入账之后第一条在 SET 里写 booked_n_fen 的 orders UPDATE（就是扣回的 CAS）改成 WHERE false，PostgreSQL
// 真的执行它、一行不中。实现二选一自证：要么事务内重读后恰好推一次版本、写一套 v2 行；要么整体干净回滚（作业失败、
// 任务仍 running），重投后恰好推一次。两种走法最后都必须是 v2 一套行、扣回凭证各一份——主干上维权 R9 不推版本，为红。
// 手算同 ./rights-partial.int.test.ts：入账 N 1000、快照预留 1000 bp → B 900、会员 450；应扣 4.00 元 → N_new 600、
// B 540、会员 270，扣回 180 / 220，booked 540 / 600；v2 四段 600 / 60 / 540 / 270 / 0 / 330。
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { PostgresQueryCompiler, sql, type Kysely } from 'kysely';
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
  rightsEvent,
  withRights,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../../orders/rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const p = databaseFixture(createTestDatabase);

/**
 * Once armed, the next UPDATE of orders that SETs booked_n_fen (the clawback's CAS) matches no row
 * in PostgreSQL (WHERE false); every statement before and after runs as written.
 */
function clawbackCasMissesOnce(db: Kysely<DB>) {
  let armed = false;
  let missed = 0;
  const conflicted = db.withPlugin({
    transformQuery(args) {
      if (armed && args.node.kind === 'UpdateQueryNode') {
        const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
        const [set = ''] = compiled.sql.split(/\swhere\s/i);
        if (
          /^update\s+(?:"app"\.)?"orders"/i.test(compiled.sql) &&
          /"booked_n_fen" = \$\d+/.test(set)
        ) {
          armed = false;
          missed += 1;
          return {
            ...args.node,
            where: { kind: 'WhereNode', where: sql<boolean>`false`.toOperationNode() },
          };
        }
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return {
    db: conflicted,
    arm: (): void => {
      armed = true;
    },
    missed: () => missed,
  };
}

it(
  '[AC-B2-04zk#11][BR-CALC-15][BR-CALC-27][BR-FUND-08] 维权应扣 4.00 元时扣回那条带 commission_version 守卫的 orders CAS 落空一次：要么重读后重算、恰好推一次到 v2，要么整体干净回滚（版本、行、凭证、booked、维权记录都不留）且重投后恰好推一次；最后都是 v2（540 / 270，四段 600 / 60 / 540 / 270 / 0 / 330）一套行、扣回 180 / 220 各一份、booked 540 / 600、事件一条',
  async () => {
    const conflict = clawbackCasMissesOnce(p.db);
    await withRights(conflict.db, async (r) => {
      const c = await creditedOrder(p.db, r.w);
      const v1 = await c.rows.stored(1);
      const before = await c.state();
      const task = await r.queued(c.app, c.o, [{ rightsNo: 'RN-1', deduction: '4.00' }]);

      conflict.arm();
      const failure = await task.run().then(
        () => null,
        (error: unknown) => error,
      );
      expect(conflict.missed(), 'the clawback CAS that matched no row').toBe(1);

      if (failure !== null) {
        // The clean rollback: nothing of the attempt is left, the task still runs.
        expect(await c.state()).toEqual(before);
        expect(await clawedBackEvents(p.db, c.app)).toEqual([]);
        expect(await r.task(c.app, task.importId)).toMatchObject({
          status: 'running',
          total_rows: 0,
        });
        await task.run();
      }

      expect(await r.task(c.app, task.importId)).toMatchObject({
        status: 'done',
        total_rows: 1,
        succeeded_rows: 1,
        failed_rows: 0,
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
      expect(await c.rows.fourAmounts(2)).toEqual({
        n_total_fen: 600n,
        pre_base_deduct_fen: 60n,
        base_fen: 540n,
        user_share_total_fen: 270n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 330n,
      });
      expect(await c.rows.stored(1)).toEqual(v1);
      const event = await rightsEvent(p.db, c.app, c.o, 'RN-1');
      expect(await clawbackLines(c, event)).toEqual(
        expectedClawback(c, event, 180n, 220n, 'RIGHTS'),
      );
      const clawbacks = (await c.read.vouchers()).filter((v) => v.voucher_kind === 'CLAWBACK');
      expect(clawbacks).toHaveLength(2);
      await c.read.balanced();
      expect(await c.read.balance()).toEqual({ available_fen: 270n, frozen_fen: 0n });
      expect(await clawedBackEvents(p.db, c.app)).toHaveLength(1);
    });
  },
  TIMEOUT,
);
