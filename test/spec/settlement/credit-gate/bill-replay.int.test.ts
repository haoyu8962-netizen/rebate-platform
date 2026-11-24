// B2-04re rule tests, round 2 (claude-independent, SPEC_REF 081b177; 任务书 §10.2 ⑥, 评审 r1 第 5 条):
// 08 BR-FUND-16 细则「加锁流程」第 0 步 with BR-FUND-04 ③⑧ and D10-2800 — the bill-day job takes the
// platform gate only after its bill row lock and after the 「该平台本期已出过」 replay check; a replay
// takes no gate. Otherwise a replayed delivery would hold the gate while waiting for the bill row that
// a supplement holds, and the supplement would then wait for the gate: a deadlock (a).
// (a) taobao's bill-day run of 2032-06 is done (platform_order_counts names it). A supplement launch
// holds the bill row (FOR UPDATE) and is held at a barrier once its first source read has returned
// (./kit.ts pauseSupplementSource(1, 'returned'); the gate comes after that read, so the launch holds
// none yet). Another delivery of the job for the same bill and platform (nominal run_at BILL_RUN_AT,
// no settle_jobs row yet) waits for the bill row: it holds and awaits no gate meanwhile; 放行 = release
// the barrier — the launch completes, then the delivery answers duplicate, neither fails.
// (b) The same replay while an executor item transaction is in flight (another connection holds P's
// order key lock; the item has taken the gate in shared mode and waits for that lock inside R5): the
// replay ends without waiting (an exclusive request would queue behind the shared holder).
// Row lock waits are read from pg_stat_activity, gate locks from pg_locks, with bounded polls; every
// finally ends its runs within a bound (./kit.ts finish).
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base; a
// credit books self 425, direct 85, indirect 42, PLATFORM:CREDIT 448: 4 vouchers, 8 entry lines.
// Red on the skeleton: (a) the delivery does wait for the bill row (the current launch locks it too),
// then gateRowsOf throws NotImplemented from creditGateKey (inside the try); (b) gateGranted throws
// NotImplemented likewise. The finally releases the barrier / holder and ends the runs.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { BillJobResult } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  BILL_RUN_AT,
  LAUNCH,
  MONTH,
  SHARE,
  TAOBAO,
  TIMEOUT,
  blockersOf,
  creditKey,
  databaseFixture,
  finish,
  fixture,
  gateGranted,
  gateRowsOf,
  generated,
  holdOrderLock,
  orderLockWaiter,
  platformKey,
  reachedBefore,
  rowLockWaiter,
  settlesWithin,
  track,
  type SeededOrder,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The answer of a replayed bill-day delivery (the platform was already generated this month). */
const DUPLICATE = { outcome: 'duplicate', billId: MONTH, status: null };

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
  '[AC-B2-04re#16] (a) 账单日任务的平台锁在账单行锁与重放判定之后：淘宝本月已出过账；补充持有账单行锁、停在第一次读来源的包装里（尚未取平台锁）时再投递同月同平台的账单日任务——它停在等账单行锁，它所在连接上没有已授予或在等待的平台锁；放行补充、补充完成后这次投递直接判重放（duplicate），不读来源、不出批次，全程没有死锁报错',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const d = await f.candidate({ subOrderId: `cg16a-${token}-01` });

    const read = f.pauseSupplementSource(1, 'returned');
    const launch = track(f.supplement());
    let job: Tracked<BillJobResult> | undefined;
    let reached = false;
    let jobPid: number | null = null;
    let blockers: number[] = [];
    let jobGateRows: unknown = null;
    let launchGateRows: unknown = null;
    let sourceReads = -1;
    let stuck: string[] = [];
    try {
      // 补充在途：已锁账单行、已读完来源，停在屏障（平台锁要在这之后才取）。
      reached = await reachedBefore(read, launch);
      job = track(f.runBill());
      jobPid = await rowLockWaiter(p.left, 'settle_bills', job);
      blockers = jobPid === null ? [] : await blockersOf(p.left, jobPid);
      jobGateRows = await gateRowsOf(p.left, f.appId, TAOBAO, jobPid ?? -1);
      launchGateRows = await gateRowsOf(p.left, f.appId, TAOBAO, blockers[0] ?? -1);
      sourceReads = f.billSource.mock.calls.length;
    } finally {
      read.release();
      stuck = await finish(p.left, { launch, job });
    }
    expect(stuck).toEqual([]);
    expect(reached).toBe(true);
    // 重复投递停在账单行锁上，挡住它的恰是补充；两边此刻都不持有、也不在等平台锁。
    expect(jobPid).not.toBeNull();
    expect(blockers).toHaveLength(1);
    expect(jobGateRows).toEqual([]);
    expect(launchGateRows).toEqual([]);
    expect(sourceReads).toBe(0);

    // 放行：补充照常完成（D 入批），重复投递随后取得账单行、判重放；没有死锁报错。
    const batches = await f.supplementBatches();
    expect(await launch.outcome).toEqual({
      ok: true,
      value: generated(batches.map((b) => b.batch_id)),
    });
    expect(await f.itemsIn(batches.map((b) => b.batch_id))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: d.orderId, b_settle_fen: 850n }),
    ]);
    expect(job).toBeDefined();
    expect(await job!.outcome).toEqual({ ok: true, value: DUPLICATE });
    expect(f.billSource).not.toHaveBeenCalled();
    expect(await f.batchesOf('main')).toEqual([]);
    expect(await f.jobs()).toEqual([
      expect.objectContaining({
        platform: TAOBAO,
        run_at: new Date(BILL_RUN_AT),
        status: 'done',
        processed_count: 0,
        skipped_count: 0,
      }),
      expect.objectContaining({
        platform: TAOBAO,
        run_at: new Date(LAUNCH),
        status: 'done',
        processed_count: 1,
        skipped_count: 0,
      }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#16] (b) 重放不取平台锁：淘宝本月已出过账；旧批次 P 的明细事务在途（持有平台锁共享模式、停在 P 的订单键锁）时投递同月同平台的账单日任务——它不等待、在执行仍在途时判重放（duplicate），不读来源；放行后 P 入账恰一次（4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg16b-${token}-01` });
    const old = await f.confirmedBatch([order]);

    const holder = await holdOrderLock(p.control, order);
    const execution = track(f.execute(old.batchId));
    let job: Tracked<BillJobResult> | undefined;
    let executorWaiter: number | null = null;
    let executorGate = 0;
    let jobEnded = false;
    let executionStillInFlight = false;
    let stuck: string[] = [];
    try {
      // 执行器明细事务在途：已持有平台锁共享模式，停在 P 的订单键锁上。
      executorWaiter = await orderLockWaiter(p.left, order, execution);
      executorGate = await gateGranted(p.left, f.appId, TAOBAO, SHARE, executorWaiter ?? -1);
      job = track(f.runBill());
      jobEnded = await settlesWithin(job);
      executionStillInFlight = !execution.settled;
    } finally {
      holder.release();
      stuck = await finish(p.left, { holder: track(holder.done), execution, job });
    }
    expect(stuck).toEqual([]);
    expect(executorWaiter).not.toBeNull();
    expect(executorGate).toBe(1);
    // 重放在执行仍在途时就结束了：它没有去要平台锁的排他模式。
    expect(jobEnded).toBe(true);
    expect(executionStillInFlight).toBe(true);
    expect(await job!.outcome).toEqual({ ok: true, value: DUPLICATE });
    expect(f.billSource).not.toHaveBeenCalled();

    expect(await execution.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, order)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'DONE' });
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));
    expect((await f.batchesOf('main')).map((b) => b.batch_id)).toEqual([old.batchId]);
  },
  TIMEOUT,
);
