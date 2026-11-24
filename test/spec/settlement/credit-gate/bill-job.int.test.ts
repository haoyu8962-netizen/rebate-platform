// B2-04re rule tests (claude-independent, SPEC_REF 081b177; 任务书 9.2 ⑩): 08 BR-FUND-16 细则「加锁流程」
// 第 0 步 with BR-FUND-04 ③⑤⑦ — the bill-day job takes the platform gate in exclusive mode after its
// bill row lock and replay check and before it reads the source, and holds it to commit: (a) an
// item transaction in flight makes the job wait before its source read; (b) the job in flight makes
// an item transaction wait.
// 「执行器明细事务在途」 (a): another connection holds O's order key lock (orders' lockOrderKey); the
// real executor's item transaction has taken the gate in shared mode and waits for that lock inside
// R5 (放行 = the holder rolls back). 「账单日任务在途」 (b): the job's source port is the production
// reader wrapped so that, after the real read, it waits for the case's signal (./kit.ts
// pauseBillSource); the gate is taken before that read, so the job holds it meanwhile (放行 = the
// signal). Waits are read from pg_locks with a bounded poll, never inferred from a sleep.
// The bill row of 2032-06 exists (generated for no platform yet: platform_order_counts {}), so the job
// for taobao at its bill day (BILL_RUN_AT, 2032-07-24) is no replay.
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle 850 = snapshot v2 base (candidates); a credit books
// self 425, direct 85, indirect 42, PLATFORM:CREDIT 448: 4 vouchers, 8 entry lines.
// Both are red on the skeleton: creditGateKey throws NotImplemented at the first gate read; past that,
// the current job takes no gate ((a) it reads the source at once, O still WAITING, and batches O;
// (b) the item transaction never waits).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { BillJobResult } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  BILL_RUN_AT,
  EXCLUSIVE,
  MONTH,
  SHARE,
  TAOBAO,
  TIMEOUT,
  creditKey,
  databaseFixture,
  fixture,
  gateGranted,
  holdOrderLock,
  orderLockWaiter,
  platformKey,
  reachedBefore,
  track,
  waitsOnGate,
  type SeededOrder,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const RUN_AT_ISO = new Date(BILL_RUN_AT).toISOString();

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
  '[AC-B2-04re#10] (a) 执行器明细事务在途时触发账单日任务：任务停在等平台锁排他模式（未授予），来源读口调用次数为 0；放行执行器后 O 入账、任务照常出账——O 记 already_credited、不进新主批次，新主批次只有另一张候选 E',
  async () => {
    const f = await fixture(p.db, { billPlatforms: [] });
    const token = randomUUID().slice(0, 8);
    const o = await f.candidate({ subOrderId: `cg10a-${token}-01` });
    const e = await f.candidate({ subOrderId: `cg10a-${token}-02` });
    const old = await f.confirmedBatch([o]);

    const holder = await holdOrderLock(p.control, o);
    const execution = track(f.execute(old.batchId));
    let job: Tracked<BillJobResult> | undefined;
    let executorWaiter: number | null = null;
    let executorGate = 0;
    let jobWaits = false;
    let sourceReads = -1;
    let countsWhileWaiting: unknown = null;
    try {
      executorWaiter = await orderLockWaiter(p.left, o, execution);
      executorGate = await gateGranted(p.left, f.appId, TAOBAO, SHARE, executorWaiter ?? -1);
      job = track(f.runBill());
      jobWaits = await waitsOnGate(p.left, f.appId, TAOBAO, EXCLUSIVE, job);
      sourceReads = f.billSource.mock.calls.length;
      countsWhileWaiting = (await f.bill()).platform_order_counts;
    } finally {
      holder.release();
      await holder.done;
      await execution.outcome;
      await job?.outcome;
    }
    expect(executorWaiter).not.toBeNull();
    expect(executorGate).toBe(1);
    expect(jobWaits).toBe(true);
    // 账单行已在、该平台本期尚未出账；来源尚未读取。
    expect(sourceReads).toBe(0);
    expect(countsWhileWaiting).toEqual({});

    // 放行后：O 由旧批次入账恰一次。
    expect(await execution.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, o)).toMatchObject({ result: 'credited' });
    expect(await f.creditedHistory(o)).toBe(1);
    expect(await f.orderLedger(o)).toEqual(fullCredit(o));

    // 任务照常出账：来源读到 O 已入账，新主批次只有 E。
    expect(job).toBeDefined();
    expect(await job!.outcome).toEqual({
      ok: true,
      value: expect.objectContaining({ outcome: 'generated', billId: MONTH }),
    });
    expect(f.billSource).toHaveBeenCalledTimes(1);
    const created = (await f.batchesOf('main')).filter((b) => b.batch_id !== old.batchId);
    expect(created).toEqual([
      expect.objectContaining({ platform: TAOBAO, status: 'DRAFT', order_count: 1 }),
    ]);
    expect(await f.itemsIn(created.map((b) => b.batch_id))).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: e.orderId,
        settle_seq: 2,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);
    const seen = await f.validations(RUN_AT_ISO);
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: o.orderKey, result: 'already_credited' }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: e.orderKey, result: 'candidate', settleSeq: 2 }),
    );
    expect((await f.bill()).platform_order_counts).toEqual({ [TAOBAO]: 1 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#10] (b) 账单日任务在途时启动旧批次执行：任务已持有平台锁排他模式（读完来源、等信号未提交），P 的明细事务停在等平台锁共享模式（未授予），P 仍待入账、旧明细结果为空；放行后任务提交、执行继续，P 入账恰一次（4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db, { billPlatforms: [] });
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg10b-${token}-01` });
    const old = await f.confirmedBatch([order]);

    const pause = f.pauseBillSource();
    const job = track(f.runBill());
    let execution: Tracked<void> | undefined;
    let reached = false;
    let jobGate = 0;
    let executorWaits = false;
    let whileWaiting: { rebate: string; item: string | null } = { rebate: '', item: '' };
    try {
      reached = await reachedBefore(pause, job);
      jobGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      whileWaiting = {
        rebate: await f.rebateOf(order),
        item: (await f.itemOf(old, order)).result,
      };
    } finally {
      pause.release();
      await job.outcome;
      await execution?.outcome;
    }
    expect(reached).toBe(true);
    expect(jobGate).toBe(1);
    expect(executorWaits).toBe(true);
    expect(whileWaiting).toEqual({ rebate: 'WAITING', item: null });

    // 放行后任务提交、执行继续。
    expect(await job.outcome).toEqual({
      ok: true,
      value: expect.objectContaining({ outcome: 'generated', billId: MONTH }),
    });
    expect((await f.bill()).platform_order_counts).toMatchObject({ [TAOBAO]: 1 });
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, order)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'DONE' });
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));
  },
  TIMEOUT,
);
