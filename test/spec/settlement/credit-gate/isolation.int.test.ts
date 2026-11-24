// B2-04re rule tests (claude-independent, SPEC_REF 081b177; 任务书 9.2 ④ ⑤): 08 BR-FUND-16 细则「加锁流程」
// 第 0 步 — the gate is one lock per (app, platform): a supplement launch of (app 1, taobao) holding it
// leaves the items of (app 1, jd) and (app 2, taobao) alone (#4); shared mode does not exclude
// shared mode, so two executions of the same (app, platform) run side by side (#5).
// 「补充在途」 (#4): candidate D sits in the second lock chunk (lockChunkSize 1) and another connection
// holds D's order key lock (orders' lockOrderKey) — the launch has taken the gate, then waits for D.
// 「执行器明细事务在途」 (#5): another connection holds A's order key lock; the real executor's item
// transaction has taken the gate in shared mode and waits for that lock inside R5.
// 放行 = the holder rolls back. A run that should not wait must end within a bounded poll (about 30 s)
// while the other side is still in flight; waits are read from pg_locks, never inferred from a sleep.
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle 850; a credit books self 425, direct 85, indirect 42,
// PLATFORM:CREDIT 448: 4 vouchers, 8 entry lines.
// Both are red on the skeleton: creditGateKey throws NotImplemented at the first gate read; past
// that, the current code takes neither the gate nor order key locks (#4: the launch never waits for
// D; #5: the first execution holds no gate while it waits for A).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  EXCLUSIVE,
  JD,
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
  settlesWithin,
  track,
  type SeededOrder,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

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
  '[AC-B2-04re#4] 别的平台、别的应用不受阻：应用一的淘宝补充持有平台锁排他模式、停在 D 的订单键锁时，同一应用京东批次与应用二淘宝批次的明细事务各自不等待、在补充仍在途时入账完成（各 4 张凭证、8 条分录）；放行后补充照常完成',
  async () => {
    const f = await fixture(p.db);
    const g = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const ours = await f.candidate({ subOrderId: `cg4-${token}-01` });
    const decoy = await f.candidate({ subOrderId: `cg4-${token}-02` });
    expect(ours.orderKey < decoy.orderKey).toBe(true);
    const jdOrder = await f.candidate({ platform: JD, subOrderId: `cg4-${token}-03` });
    const theirs = await g.candidate({ subOrderId: `cg4-${token}-04` });
    const jdBatch = await f.confirmedBatch([jdOrder], JD);
    const theirBatch = await g.confirmedBatch([theirs]);

    const holder = await holdOrderLock(p.control, decoy);
    const launch = track(f.supplement({ lockChunkSize: 1 }));
    let jdRun: Tracked<void> | undefined;
    let theirRun: Tracked<void> | undefined;
    let waiter: number | null = null;
    let supplementGate = 0;
    let finished = { jd: false, theirs: false };
    let launchStillInFlight = false;
    let otherGates = { jd: -1, theirs: -1 };
    try {
      waiter = await orderLockWaiter(p.left, decoy, launch);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE, waiter ?? -1);
      jdRun = track(f.execute(jdBatch.batchId));
      theirRun = track(g.execute(theirBatch.batchId));
      finished = { jd: await settlesWithin(jdRun), theirs: await settlesWithin(theirRun) };
      launchStillInFlight = !launch.settled;
      // 两个执行结束后，它们的平台锁也随事务放掉；补充那把仍在。
      otherGates = {
        jd: await gateGranted(p.left, f.appId, JD, SHARE),
        theirs: await gateGranted(p.left, g.appId, TAOBAO, SHARE),
      };
    } finally {
      holder.release();
      await holder.done;
      await launch.outcome;
      await jdRun?.outcome;
      await theirRun?.outcome;
    }
    expect(waiter).not.toBeNull();
    expect(supplementGate).toBe(1);
    expect(finished).toEqual({ jd: true, theirs: true });
    expect(launchStillInFlight).toBe(true);
    expect(otherGates).toEqual({ jd: 0, theirs: 0 });

    // 同一应用京东、另一应用淘宝：各自入账（app_id 与平台都在锁键里）。
    expect(await jdRun!.outcome).toEqual({ ok: true, value: undefined });
    expect(await theirRun!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.rebateOf(jdOrder)).toBe('CREDITED');
    expect(await f.orderLedger(jdOrder)).toEqual(fullCredit(jdOrder));
    expect(await f.batch(jdBatch.batchId)).toMatchObject({ status: 'DONE' });
    expect(await g.rebateOf(theirs)).toBe('CREDITED');
    expect(await g.orderLedger(theirs)).toEqual(fullCredit(theirs));
    expect(await g.batch(theirBatch.batchId)).toMatchObject({ status: 'DONE' });
    // 另一应用没有补充批次。
    expect(await g.supplementBatches()).toEqual([]);

    // 放行后补充照常完成：本应用淘宝两张候选入批。
    const batches = await f.supplementBatches();
    expect(await launch.outcome).toEqual({
      ok: true,
      value: generated(batches.map((b) => b.batch_id)),
    });
    const items = await f.itemsIn(batches.map((b) => b.batch_id));
    expect(items).toHaveLength(2);
    for (const o of [ours, decoy]) {
      expect(items).toContainEqual(
        expect.objectContaining({ item_type: 'order', order_id: o.orderId, b_settle_fen: 850n }),
      );
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#5] 执行与执行不互斥：同一应用同一平台两个批次，第一个批次 A 的明细事务在途（持有平台锁共享模式、停在 A 的订单键锁）时，第二个批次 B 的明细照常入账、不等待（4 张凭证、8 条分录）；放行后 A 也入账',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const a = await f.candidate({ subOrderId: `cg5-${token}-01` });
    const b = await f.candidate({ subOrderId: `cg5-${token}-02` });
    const first = await f.confirmedBatch([a]);
    const second = await f.confirmedBatch([b]);

    const holder = await holdOrderLock(p.control, a);
    const firstRun = track(f.execute(first.batchId));
    let secondRun: Tracked<void> | undefined;
    let firstWaiter: number | null = null;
    let firstGate = 0;
    let secondFinished = false;
    let firstStillInFlight = false;
    try {
      firstWaiter = await orderLockWaiter(p.left, a, firstRun);
      firstGate = await gateGranted(p.left, f.appId, TAOBAO, SHARE, firstWaiter ?? -1);
      secondRun = track(f.execute(second.batchId));
      secondFinished = await settlesWithin(secondRun);
      firstStillInFlight = !firstRun.settled;
    } finally {
      holder.release();
      await holder.done;
      await firstRun.outcome;
      await secondRun?.outcome;
    }
    expect(firstWaiter).not.toBeNull();
    expect(firstGate).toBe(1);
    expect(secondFinished).toBe(true);
    expect(firstStillInFlight).toBe(true);

    expect(await secondRun!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.rebateOf(b)).toBe('CREDITED');
    expect(await f.creditedHistory(b)).toBe(1);
    expect(await f.orderLedger(b)).toEqual(fullCredit(b));
    expect(await f.batch(second.batchId)).toMatchObject({ status: 'DONE' });

    expect(await firstRun.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.rebateOf(a)).toBe('CREDITED');
    expect(await f.creditedHistory(a)).toBe(1);
    expect(await f.orderLedger(a)).toEqual(fullCredit(a));
  },
  TIMEOUT,
);
