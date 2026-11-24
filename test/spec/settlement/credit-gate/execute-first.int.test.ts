// B2-04re rule test (claude-independent, SPEC_REF 081b177; 任务书 9.2 ①): 08 BR-FUND-16 细则「加锁流程」
// 第 0 步 with BR-FUND-04 ⑧⑫ — an item transaction of the executor in flight (it holds the platform
// gate in shared mode) makes a supplement launch wait for the gate (exclusive mode) before it
// handles any candidate; once the item has committed, the launch sees the order credited.
// 「执行器明细事务在途」: another connection holds O's order key lock (orders' lockOrderKey, not
// committed); the real executor (SettlementModule.forWorker) takes the gate in shared mode, then waits
// for that lock inside R5. 放行 = the holder rolls back. Waits are read from pg_locks with a bounded
// poll (./kit.ts), never inferred from a sleep.
// Amounts (自拟) in ./kit.ts: B_settle 850 = snapshot v2 base; R5 books self 425, indirect 42 and
// PLATFORM:CREDIT 448 (two entry lines each); the frozen direct's 85 opens a first_credit obligation.
// Red on the skeleton: creditGateKey throws NotImplemented at the first gate read; past that, the
// current code takes no gate, so the launch never waits (the bounded poll answers false).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { SupplementResult } from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import {
  EXCLUSIVE,
  FROZEN_DIRECT,
  SHARE,
  TAOBAO,
  TIMEOUT,
  creditKey,
  databaseFixture,
  fixture,
  gateGranted,
  generated,
  holdOrderLock,
  orderLockWaiter,
  platformKey,
  track,
  waitsOnGate,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04re#1] 执行在途时发起补充，补充等它：旧批次正在执行 O 的明细事务（已取平台锁共享模式、停在 O 的订单键锁）——补充停在等平台锁排他模式（未授予），不产生任何批次、明细、逐单结果；放行执行器后 O 入账并开立补记义务、提交，补充随即完成：同一轮只出 O 的受益人补记项、没有首次入账明细，逐单结果 already_credited',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate({ people: FROZEN_DIRECT });
    const old = await f.confirmedBatch([o]);

    const holder = await holdOrderLock(p.control, o);
    const execution = track(f.execute(old.batchId));
    let launch: Tracked<SupplementResult> | undefined;
    let executorWaiter: number | null = null;
    let executorGate = 0;
    let supplementWaits = false;
    let whileWaiting: Record<string, unknown> = {};
    try {
      // 在途：执行器的明细事务停在 O 的订单键锁上，且已持有平台锁的共享模式。
      executorWaiter = await orderLockWaiter(p.left, o, execution);
      executorGate = await gateGranted(p.left, f.appId, TAOBAO, SHARE, executorWaiter ?? -1);
      launch = track(f.supplement());
      supplementWaits = await waitsOnGate(p.left, f.appId, TAOBAO, EXCLUSIVE, launch);
      whileWaiting = {
        batches: await f.supplementBatches(),
        items: await f.allItems(),
        validations: await f.validations(),
        jobs: await f.jobs(),
      };
    } finally {
      holder.release();
      await holder.done;
      await execution.outcome;
      await launch?.outcome;
    }
    expect(executorWaiter).not.toBeNull();
    expect(executorGate).toBe(1);
    expect(supplementWaits).toBe(true);
    // 补充等锁期间：没有补充批次、没有新明细（旧明细仍未执行）、没有逐单结果与任务键。
    expect(whileWaiting).toEqual({
      batches: [],
      items: [expect.objectContaining({ batch_id: old.batchId, result: null })],
      validations: [],
      jobs: [],
    });

    expect(await execution.outcome).toEqual({ ok: true, value: undefined });
    // 放行后：O 由旧批次真实入账（R5），冻结的直推开了首次入账义务。
    expect(await f.rebateOf(o)).toBe('CREDITED');
    expect(await f.itemOf(old, o)).toMatchObject({ result: 'credited' });
    const opened = await f.openObligations(o);
    expect(opened).toEqual([
      expect.objectContaining({
        user_id: o.user('direct'),
        role: 'direct',
        kind: 'first_credit',
        status: 'open',
      }),
    ]);
    const obligationId = opened[0]!.beneficiary_credit_id;
    expect(await f.orderLedger(o)).toEqual({
      vouchers: [creditKey(o, 'self'), creditKey(o, 'indirect'), platformKey(o)].sort(),
      lines: 6,
    });

    // 补充随即完成：只出 O 的受益人补记项（引用该义务），没有 O 的首次入账明细。
    expect(launch).toBeDefined();
    const outcome = await launch!.outcome;
    const batches = await f.supplementBatches();
    expect(outcome).toEqual({ ok: true, value: generated(batches.map((b) => b.batch_id)) });
    expect(batches).toEqual([
      expect.objectContaining({ kind: 'supplement', status: 'DRAFT', order_count: 0 }),
    ]);
    expect(await f.itemsIn(batches.map((b) => b.batch_id))).toEqual([
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: o.orderId,
        user_id: o.user('direct'),
        role: 'direct',
        beneficiary_credit_id: obligationId,
        settle_seq: o.seq,
        b_settle_fen: null,
        result: null,
      }),
    ]);
    expect(await f.allItems()).toHaveLength(2);
    expect(await f.validations()).toEqual([
      expect.objectContaining({
        orderKey: o.orderKey,
        orderId: o.orderId,
        result: 'already_credited',
        settleSeq: o.seq,
      }),
    ]);
    expect(await f.jobs()).toEqual([
      expect.objectContaining({ status: 'done', processed_count: 1, skipped_count: 0 }),
    ]);
    expect(await f.creditedHistory(o)).toBe(1);
  },
  TIMEOUT,
);
