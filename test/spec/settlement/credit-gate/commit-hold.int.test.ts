// B2-04re rule tests, round 2 (claude-independent, SPEC_REF 081b177; 任务书 §10.2 ④ ⑤, 评审 r1 第 3、4 条):
// 08 BR-FUND-16 细则「加锁流程」第 0 步 — the generating side holds the platform gate in exclusive mode
// until its transaction ends, not merely until its last statement: the supplement through the
// console's real entry launchInTransaction (the caller's outer transaction; #14, ended by commit and by
// rollback), and the bill-day job up to its commit (#15). A transaction-level advisory lock does that;
// a session lock released by the code before returning does not.
// 「补充在途」 (#14): the outer transaction is opened by the case (as launchAdminSettleSupplement opens
// its idempotency transaction); once launchInTransaction has returned on it, the outer callback waits
// at a barrier (./kit.ts barrier; 放行 = release, then the callback commits or throws). 「账单日任务在途」
// (#15): the job's onGenerated hook — on the generating transaction, right before commit, after the
// source read, the batches and the bill totals — waits at a barrier (./kit.ts runBillHeldAtCommit).
// Meanwhile the old CONFIRMED batch runs through the real executor (SettlementModule.forWorker). Waits
// are read from pg_locks with a bounded poll; every finally ends its runs within a bound (./kit.ts
// finish).
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base; a
// credit books self 425, direct 85, indirect 42, PLATFORM:CREDIT 850 − 552 + 150 = 448: 4 vouchers, 8
// entry lines.
// Red on the skeleton: the barrier is reached (it is the case's own), then gateGranted throws
// NotImplemented from creditGateKey (inside the try; the finally releases the barrier and ends the
// runs). Past that, the current code takes no gate, so the executor never waits (waitsOnGate false).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { BillJobResult } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import type { SupplementResult } from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import {
  EXCLUSIVE,
  MONTH,
  SHARE,
  TAOBAO,
  TIMEOUT,
  barrier,
  creditKey,
  databaseFixture,
  finish,
  fixture,
  gateGranted,
  generated,
  platformKey,
  reachedBefore,
  track,
  waitsOnGate,
  type SeededOrder,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The failure of the outer transaction after launchInTransaction has returned (test only). */
const OUTER_FAILURE = 'credit-gate test: the outer transaction rolls back';

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

it.each(['commit', 'rollback'] as const)(
  '[AC-B2-04re#14] 补充的平台锁排他模式持有到外层事务结束（外层 %s）：经后台实际入口 launchInTransaction 在用例开的外层事务里发起补充，命令返回之后、外层事务结束之前暂停——此时启动同平台旧批次执行：P 的明细事务停在等平台锁共享模式（未授予），P 仍待入账、旧明细结果为空；外层提交则补充的批次与明细（只有 D）已在、外层回滚则不留任何批次、明细、逐单结果与任务键，两种收尾之后执行都继续，P 入账恰一次（4 张凭证、8 条分录）',
  async (ending) => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg14-${token}-01` });
    const decoy = await f.candidate({ subOrderId: `cg14-${token}-02` });
    const old = await f.confirmedBatch([order]);

    // 外层事务：后台入口返回后停在屏障，放行后按参数提交或回滚。
    const returned = barrier(p.db);
    const inside: { result?: SupplementResult } = {};
    const outer = track(
      p.db.transaction().execute(async (trx) => {
        inside.result = await f.supplementInTransaction(trx);
        await returned.wait();
        if (ending === 'rollback') throw new Error(OUTER_FAILURE);
        return inside.result;
      }),
    );
    let execution: Tracked<void> | undefined;
    let reached = false;
    let supplementGate = 0;
    let executorWaits = false;
    let sharedGranted = -1;
    let whileWaiting: unknown = null;
    let stuck: string[] = [];
    try {
      reached = await reachedBefore(returned, outer);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      sharedGranted = await gateGranted(p.left, f.appId, TAOBAO, SHARE);
      whileWaiting = {
        rebate: await f.rebateOf(order),
        item: (await f.itemOf(old, order)).result,
        ledger: await f.orderLedger(order),
        // 外层未结束：补充写的行别的连接看不见。
        supplementBatches: (await f.supplementBatches()).length,
      };
    } finally {
      returned.release();
      stuck = await finish(p.left, { outer, execution });
    }
    expect(stuck).toEqual([]);
    expect(reached).toBe(true);
    expect(supplementGate).toBe(1);
    expect(executorWaits).toBe(true);
    expect(sharedGranted).toBe(0);
    expect(whileWaiting).toEqual({
      rebate: 'WAITING',
      item: null,
      ledger: { vouchers: [], lines: 0 },
      supplementBatches: 0,
    });
    // 命令在外层事务里返回过：只有 D 的一批（P 仍在未执行的旧批次里）。
    expect(inside.result?.batchIds).toHaveLength(1);

    // 外层结束：提交留下补充的批次、明细、逐单结果与任务键；回滚一样都不留。
    const committed = ending === 'commit';
    const batches = await f.supplementBatches();
    const batchIds = batches.map((b) => b.batch_id);
    expect(batches).toHaveLength(committed ? 1 : 0);
    expect(await outer.outcome).toEqual(
      committed
        ? { ok: true, value: generated(batchIds) }
        : { ok: false, error: expect.objectContaining({ message: OUTER_FAILURE }) },
    );
    expect(await f.itemsIn(batchIds)).toEqual(
      committed
        ? [
            expect.objectContaining({
              item_type: 'order',
              order_id: decoy.orderId,
              settle_seq: 2,
              b_settle_fen: 850n,
              result: null,
            }),
          ]
        : [],
    );
    expect(await f.allItems()).toHaveLength(committed ? 2 : 1);
    expect(await f.validations()).toHaveLength(committed ? 2 : 0);
    expect(await f.jobs()).toEqual(
      committed
        ? [expect.objectContaining({ status: 'done', processed_count: 2, skipped_count: 0 })]
        : [],
    );

    // 两种收尾之后执行都继续：P 入账恰一次。
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, order)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'DONE' });
    expect(await f.rebateOf(order)).toBe('CREDITED');
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));
    expect(await f.h.balance(order.user('self'))).toBe(425n);
    expect(await f.rebateOf(decoy)).toBe('WAITING');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#15] 账单日任务的平台锁排他模式持有到提交：任务读完来源、写完批次与合计后停在出账事务内的 onGenerated 完成钩子（提交之前）——此时启动旧批次执行：P 的明细事务停在等平台锁共享模式（未授予），P 仍待入账、旧明细结果为空；放行钩子、任务提交后执行才继续，P 入账恰一次（4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db, { billPlatforms: [] });
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg15-${token}-01` });
    const old = await f.confirmedBatch([order]);

    const held = f.runBillHeldAtCommit();
    const job: Tracked<BillJobResult> = track(held.run);
    let execution: Tracked<void> | undefined;
    let reached = false;
    let sourceReads = -1;
    let jobGate = 0;
    let executorWaits = false;
    let sharedGranted = -1;
    let whileWaiting: unknown = null;
    let stuck: string[] = [];
    try {
      // 账单日任务在途：已读来源、已写批次，停在提交前的完成钩子里。
      reached = await reachedBefore(held.pause, job);
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
      held.pause.release();
      stuck = await finish(p.left, { job, execution });
    }
    expect(stuck).toEqual([]);
    expect(reached).toBe(true);
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

    // 放行后任务提交（出账），执行随后继续。
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
