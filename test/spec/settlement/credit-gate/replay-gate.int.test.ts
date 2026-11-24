// B2-04re rule test, round 3 (claude-independent, SPEC_REF 081b177; 任务书 §11.2 ③, 评审 r2 第 3 条): 08
// BR-FUND-16 细则「加锁流程」第 0 步 with BR-FUND-04 ③⑧ and D10-2800 — a replayed bill-day delivery takes
// the platform gate in no mode at all. A replay that took the gate in shared mode would wait whenever
// a generating transaction of the same app and platform holds it exclusively (e.g. finance's
// supplement of another bill month), holding the bill row of this month meanwhile.
// Taobao's bill-day run of 2032-06 is done (platform_order_counts names it). The case itself holds
// the gate of (app, taobao) in exclusive mode on another connection — the skeleton's exclusive
// statement `select pg_advisory_xact_lock(hashtext($1), hashtext($2))` with creditGateKey's keys, in
// a transaction left open (./kit.ts holdGateExclusive; 放行 = roll back). Meanwhile another delivery of
// the job for the same bill and platform (nominal run_at BILL_RUN_AT, no settle_jobs row yet) runs on
// a single connection whose backend pid is read beforehand; it must answer duplicate while the
// exclusive lock is still held. The end is awaited with a bounded poll (./kit.ts settlesWithin); the
// finally releases the holder and ends the runs within a bound (./kit.ts finish).
// No amounts: the replay reads no source and writes no batch.
// Red on the skeleton: holdGateExclusive calls creditGateKey, which throws NotImplemented (inside
// the try; nothing is running yet, so the finally only ends the runs it has, none).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { BillJobResult } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  BILL_RUN_AT,
  EXCLUSIVE,
  MONTH,
  TAOBAO,
  TIMEOUT,
  backendPid,
  databaseFixture,
  finish,
  fixture,
  gateGranted,
  gateRowsOf,
  holdGateExclusive,
  settlesWithin,
  track,
  type OrderLockHolder,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The answer of a replayed bill-day delivery (the platform was already generated this month). */
const DUPLICATE = { outcome: 'duplicate', billId: MONTH, status: null };

it(
  '[AC-B2-04re#19] 重放在任何模式下都不取平台锁：淘宝本月已出过账；用例自己的独立事务以排他语句持有同应用、同平台的平台锁排他模式不提交——此时投递同月同平台的账单日任务：它在排他锁仍被持有时就判重放（duplicate），不读来源、不出批次，它所在连接上没有已授予或在等待的平台锁；之后独立事务回滚收尾',
  async () => {
    const f = await fixture(p.db);
    const jobPid = await backendPid(p.right);
    let holder: OrderLockHolder | undefined;
    let job: Tracked<BillJobResult> | undefined;
    let heldBefore = -1;
    let jobEnded = false;
    let jobGateRows: unknown = null;
    let heldAfter = -1;
    let stuck: string[] = [];
    try {
      // 用例自己持有平台锁排他模式（同应用、同平台），不提交。
      holder = await holdGateExclusive(p.control, f.appId, TAOBAO);
      heldBefore = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
      // 重复投递跑在单连接上（pid 事先读好）。
      job = track(f.runBillVia(p.right));
      jobEnded = await settlesWithin(job);
      jobGateRows = await gateRowsOf(p.left, f.appId, TAOBAO, jobPid);
      heldAfter = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
    } finally {
      holder?.release();
      stuck = await finish(p.left, {
        holder: holder === undefined ? undefined : track(holder.done),
        job,
      });
    }
    expect(stuck).toEqual([]);
    expect(heldBefore).toBe(1);
    // 排他锁一直在用例手里，重放却已结束：它没有去要平台锁（共享、排他都没有）。
    expect(jobEnded).toBe(true);
    expect(heldAfter).toBe(1);
    expect(jobGateRows).toEqual([]);
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
    ]);
  },
  TIMEOUT,
);
