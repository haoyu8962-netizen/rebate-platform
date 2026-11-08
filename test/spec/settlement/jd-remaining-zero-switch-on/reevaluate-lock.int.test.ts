// B2-04zzh 一次性重评的逐单锁内重读与逐单事务（任务书 §9.2 第 3 条「--apply 才逐单：独立事务、取 orders.lockOrderKey、
// 经同一端口方法判定（锁内重读后已不满足就跳过）、同事务 order.invalidated，并写一条 audit_logs」，§9.5 #12 / #13；
// BR-CALC-15、BR-FUND-07「同一事务内入队领域事件 order.invalidated」、BR-FUND-01 R6；settlement/AGENTS.md 硬规则 3、4）。
// #12：apply 读出 3 张候选之后、逐单事务之前，另一条连接把其中一张改成 2 件退 1（剩余 1）：该张在锁内重读后不再满足，
//      跳过（状态、原因、历史、事件、审计都是改后的样子，不多一行），另两张照 #8 作废；summary { 3, 2, 1 }。
// #13：某一张候选的 audit_logs 插入失败一次：该张的事务整体回滚（不作废、无历史 / 事件 / 审计行），其余两张照常作废并
//      保留；本测试钉的写法是 CLI run 的退出码 1（其他失败；已提交的单保留），恢复后重跑只剩这一张、作废一次。
// 主干没有重评服务（骨架抛 NotImplemented）：每条都红。
// Task-local AC labels ([AC-B2-04zzh#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  EXIT_OK,
  SWITCH,
  TIMEOUT,
  databaseFixture,
  withWorker,
  type App,
  type Worker,
} from './kit.ts';
import {
  EXIT_FAILURE,
  auditFault,
  candidates,
  cliOn,
  passCaches,
  reevaluationOn,
  refundOnCandidateRead,
  type Candidate,
} from './reevaluate-kit.ts';

const p = databaseFixture(createTestDatabase);

/** #8's void of one candidate: R6 PLATFORM_INVALID, reason REFUND, one event, one audit row. */
async function expectVoided(w: Worker, app: App, { order, from }: Candidate): Promise<void> {
  const row = await order.row();
  expect(row).toMatchObject({
    rebate_status: 'VOID',
    reason: 'REFUND',
    reason_sub: null,
    quantity: 2,
    refunded_quantity: 2,
    booked_base_fen: null,
  });
  const voids = await order.voids();
  expect(voids).toHaveLength(1);
  expect(voids[0]).toMatchObject({
    from_status: from,
    event: 'PLATFORM_INVALID',
    to_status: 'VOID',
  });
  const events = await order.invalidated();
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toMatchObject({
    order_id: row.order_id,
    platform: 'jd',
    reason: 'REFUND',
  });
  const own = (await w.auditsOf(app)).filter((a) => a.target === `orders:${row.order_id}`);
  expect(own).toHaveLength(1);
  expect(own[0]).toMatchObject({ admin_id: app.adminId, system_actor: null });
  expect(JSON.stringify(own[0]!.before)).toContain(from);
  expect(JSON.stringify(own[0]!.after)).toContain('VOID');
}

it(
  '[AC-B2-04zzh#12] 开关开、apply 读出 3 张候选后另一条连接把其中一张改成剩余 1：锁内重读后跳过该张（状态、原因、历史、order.invalidated、audit_logs 都与改后相同，不多一行），另两张照常作废；返回 { candidates: 3, voided: 2, skipped: 1 }，并发改动只发生一次',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const set = await candidates(w, app);
      await w.setConfig(app, SWITCH, true);
      const target = set.estimated;
      const targetRow = await target.row();
      const targetHistory = await target.history();
      const ledger = await w.ledgerOf(app);
      const refund = refundOnCandidateRead(p.db, {
        appId: app.appId,
        orderId: targetRow.order_id,
      });
      const service = await reevaluationOn(w, p.db, p.db.withPlugin(refund.plugin));
      passCaches(w);

      const summary = await service.apply({ appId: app.appId, actor: app.adminId });

      expect(refund.hits, 'the concurrent change after the candidate read').toBe(1);
      expect(summary).toEqual({ candidates: 3, voided: 2, skipped: 1 });

      // The changed order: exactly as the other connection left it.
      expect(refund.changed).toMatchObject({
        rebate_status: 'ESTIMATED',
        reason: null,
        quantity: 2,
        refunded_quantity: 1,
      });
      expect(await target.row()).toEqual(refund.changed);
      expect(await target.history()).toEqual(targetHistory);
      expect(await target.voids()).toEqual([]);
      expect(await target.invalidated()).toEqual([]);
      const audits = await w.auditsOf(app);
      expect(audits.filter((a) => a.target === `orders:${targetRow.order_id}`)).toEqual([]);
      expect(audits).toHaveLength(2);

      // The other two: voided as in #8.
      const others = set.all.filter((candidate) => candidate.order !== target);
      expect(others).toHaveLength(2);
      for (const c of others) await expectVoided(w, app, c);
      expect(await w.ledgerOf(app)).toEqual(ledger);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzh#13] 开关开 --apply、某一张候选的 audit_logs 插入失败一次：该张事务回滚（仍是原状态、无作废历史、无 order.invalidated、无审计行），其余两张照常作废并保留；run 退出码 1；恢复后重跑只剩这一张（{ 0, 1, 1, 0 }），作废一次',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const set = await candidates(w, app);
      await w.setConfig(app, SWITCH, true);
      const target = set.waiting;
      const targetRow = await target.row();
      const targetHistory = await target.history();
      const ledger = await w.ledgerOf(app);
      const fault = auditFault(`orders:${targetRow.order_id}`);
      const cli = await cliOn(w, p.db, p.db.withPlugin(fault.plugin));
      const argv = ['--app', app.appId, '--actor', app.adminId, '--apply'];

      const result = await cli.run(argv);

      expect(fault.hits, 'the audit row of the failing order was attempted once').toBe(1);
      expect(result).toMatchObject({ exitCode: EXIT_FAILURE });

      // The failing order: its whole transaction rolled back.
      expect(await target.row()).toEqual(targetRow);
      expect(await target.history()).toEqual(targetHistory);
      expect(await target.voids()).toEqual([]);
      expect(await target.invalidated()).toEqual([]);
      const audits = await w.auditsOf(app);
      expect(audits.filter((a) => a.target === `orders:${targetRow.order_id}`)).toEqual([]);
      expect(audits).toHaveLength(2);

      // The others committed on their own transactions and stay.
      const others = set.all.filter((candidate) => candidate.order !== target);
      expect(others).toHaveLength(2);
      for (const c of others) await expectVoided(w, app, c);
      expect(await w.ledgerOf(app)).toEqual(ledger);

      const again = await cli.run(argv);

      expect(fault.hits).toBe(1);
      expect(again).toEqual({ exitCode: EXIT_OK, candidates: 1, voided: 1, skipped: 0 });
      for (const c of set.all) await expectVoided(w, app, c);
      expect(await w.auditsOf(app)).toHaveLength(3);
      expect(await w.ledgerOf(app)).toEqual(ledger);
    });
  },
  TIMEOUT,
);
