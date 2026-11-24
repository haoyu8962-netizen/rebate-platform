// B2-04re rule test, round 3 (claude-independent, SPEC_REF 081b177; 任务书 §11.2 ②, 评审 r2 第 2 条): 08
// BR-FUND-16 细则「加锁流程」第 0 步 — the bill-day job holds the platform gate in exclusive mode until
// its transaction commits (a transaction-level lock), not until its last statement: a session lock
// unlocked by the code after onGenerated and before COMMIT would let an item transaction credit P while
// the new batches and the bill totals are not yet visible.
// 「账单日任务在途」: the job runs on its own pool whose client holds back the first COMMIT sent once
// the production onGenerated hook has been called (./kit.ts commitPausingDb + runBillVia; Kysely ends
// the transaction with the raw statement `commit` on the transaction's client) — that is, after the
// hook has returned and before the COMMIT reaches PostgreSQL (放行 = release; the COMMIT is then
// sent). Meanwhile the old CONFIRMED batch runs through the real executor (SettlementModule.forWorker).
// Waits are read from pg_locks with a bounded poll; the barrier is bounded (./kit.ts reachedBefore) and
// the finally ends its runs within a bound (./kit.ts finish), then closes that pool (bounded).
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base; a
// credit books self 425, direct 85, indirect 42, PLATFORM:CREDIT 850 − 552 + 150 = 448: 4 vouchers, 8
// entry lines.
// Red on the skeleton: the barrier before COMMIT is reached (the hook and the COMMIT are production's),
// then gateGranted throws NotImplemented from creditGateKey (inside the try; the finally releases the
// barrier, ends the runs and closes the pool). Past that, the current job takes no gate, so the
// executor would not wait (waitsOnGate false).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { BillJobResult } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  EXCLUSIVE,
  MONTH,
  SHARE,
  TAOBAO,
  TIMEOUT,
  barrier,
  commitPausingDb,
  creditKey,
  databaseFixture,
  finish,
  fixture,
  gateGranted,
  platformKey,
  reachedBefore,
  track,
  waitsOnGate,
  type SeededOrder,
  type Tracked,
} from './kit.ts';

/** The couli_app URL of this file's test database (for the job's own, COMMIT-pausing pool). */
const url: { app?: string } = {};
const p = databaseFixture(async () => {
  const database = await createTestDatabase();
  url.app = database.urlFor('couli_app');
  return database;
});

function fullCredit(o: SeededOrder) {
  return {
    vouchers: [
      creditKey(o, 'self'),
      creditKey(o, 'direct'),
      creditKey(o, 'indirect'),
      platformKey(o),
    ].sort(),
    lines: 8,
  };
}

it(
  '[AC-B2-04re#18] 账单日任务的平台锁排他模式是事务级、持有到 COMMIT：任务的 onGenerated 完成钩子返回之后、出账事务的 COMMIT 发出之前暂停——此时启动旧批次执行：P 的明细事务停在等平台锁共享模式（未授予），任务仍持有排他模式恰一把，P 仍待入账、旧明细结果为空、账单合计未提交；放行 COMMIT 后任务提交（出账），执行随后继续，P 入账恰一次（4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db, { billPlatforms: [] });
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg18-${token}-01` });
    const old = await f.confirmedBatch([order]);
    expect(url.app).toBeDefined();

    const pausing = commitPausingDb(url.app ?? '');
    const atCommit = barrier(p.db);
    const hook = { calls: 0 };
    // 钩子在出账事务内；它返回之后的第一条 COMMIT 停在屏障。
    const onGenerated = (): Promise<void> => {
      hook.calls += 1;
      pausing.arm(atCommit);
      return Promise.resolve();
    };
    const job: Tracked<BillJobResult> = track(f.runBillVia(pausing.db, onGenerated));
    let execution: Tracked<void> | undefined;
    let reached = false;
    let hookCalls = -1;
    let sourceReads = -1;
    let jobGate = 0;
    let executorWaits = false;
    let sharedGranted = -1;
    let whileWaiting: unknown = null;
    let stuck: string[] = [];
    let closed = false;
    try {
      // 账单日任务在途：已读来源、写完批次与合计、钩子已返回，COMMIT 尚未发出。
      reached = await reachedBefore(atCommit, job);
      hookCalls = hook.calls;
      sourceReads = f.billSource.mock.calls.length;
      jobGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      sharedGranted = await gateGranted(p.left, f.appId, TAOBAO, SHARE);
      whileWaiting = {
        rebate: await f.rebateOf(order),
        item: (await f.itemOf(old, order)).result,
        ledger: await f.orderLedger(order),
        // 任务未提交：账单合计别的连接看不见。
        counts: (await f.bill()).platform_order_counts,
      };
    } finally {
      atCommit.release();
      stuck = await finish(p.left, { job, execution });
      closed = await pausing.close();
    }
    expect(stuck).toEqual([]);
    expect(closed).toBe(true);
    expect(reached).toBe(true);
    expect(hookCalls).toBe(1);
    expect(sourceReads).toBe(1);
    expect(jobGate).toBe(1);
    expect(executorWaits).toBe(true);
    expect(sharedGranted).toBe(0);
    expect(whileWaiting).toEqual({
      rebate: 'WAITING',
      item: null,
      ledger: { vouchers: [], lines: 0 },
      counts: {},
    });

    // 放行 COMMIT：任务提交（出账），执行随后继续。
    expect(await job.outcome).toEqual({
      ok: true,
      value: expect.objectContaining({ outcome: 'generated', billId: MONTH }),
    });
    expect((await f.bill()).platform_order_counts).toEqual({ [TAOBAO]: 1 });
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, order)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'DONE' });
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));
    expect(await f.h.balance(order.user('self'))).toBe(425n);
  },
  TIMEOUT,
);
