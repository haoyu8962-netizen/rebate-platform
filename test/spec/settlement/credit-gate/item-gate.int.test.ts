// B2-04re rule tests, round 2 (claude-independent, SPEC_REF 081b177; 任务书 §10.2 ① ② ③, 评审 r1 第 1、2
// 条): 08 BR-FUND-16 细则「加锁流程」第 0 步 — *every* item transaction of the executor takes the
// platform gate in shared mode before anything else: a beneficiary make-up item (R5a, BR-FUND-04 ⑫)
// as well as a first-credit item (#11); the second item of one delivery as well as the first (#12);
// on jd as well as on taobao (#13).
// 「补充在途」 (all three): a candidate D sits in a later lock chunk (lockChunkSize 1) and another
// connection holds D's order key lock (orders' lockOrderKey, not committed) — the launch has taken the
// gate in exclusive mode and finished the earlier chunks, then waits for D (放行 = the holder rolls
// back). In #12 the delivery is first held at a barrier in its switch read (./kit.ts executePaused:
// the first configuration read made once X is committed CREDITED, i.e. after X's item transaction and
// before Y's begins; 放行 = the case releases it), and the launch is started meanwhile.
// The executor (SettlementModule.forWorker), the supplement launch and the confirmation are the
// production pieces of ./kit.ts; the frozen direct is released through the harness's risk state, as
// in [AC-B2-04rd#1]. Waits are read from pg_locks with a bounded poll, never inferred from a sleep;
// every finally ends its runs within a bound (./kit.ts finish).
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base; a
// credit books self 425, direct floor(850 × 1000 / 10000) = 85, indirect 42, PLATFORM:CREDIT
// 850 − 552 + 150 = 448: 4 vouchers, 8 entry lines; with a frozen direct 3 vouchers, 6 lines and one
// first_credit obligation of 85, made up later by R5a (one more voucher, 2 lines).
// Red on the skeleton (no gate, no order key locks in the launch): the launch never waits for D, so
// orderLockWaiter answers null once it has ended, and the next gateGranted throws NotImplemented
// from creditGateKey (inside the try; the finally releases the holder / barrier and ends the runs).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { SupplementResult } from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import {
  EXCLUSIVE,
  FROZEN_DIRECT,
  JD,
  MONTH,
  SHARE,
  TAOBAO,
  TIMEOUT,
  creditKey,
  databaseFixture,
  finish,
  fixture,
  gateGranted,
  gateWaiter,
  generated,
  grantedOrderKeyLocksOf,
  holdOrderLock,
  orderLockWaiter,
  platformKey,
  reachedBefore,
  track,
  tryOrderLock,
  waitsOnGate,
  type OrderLockHolder,
  type SeededOrder,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The second launch moment of #11 (自拟: one hour after LAUNCH, same day, not a bill day). */
const LATER = '2032-07-26T11:00:00+08:00';

/** The four vouchers of a full credit of `o` (self, direct, indirect, platform). */
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
  '[AC-B2-04re#11] 受益人补记明细也先取平台锁共享模式：O 已入账、冻结的直推开了首次入账义务（85）后解冻，补记项已由补充生成并经确认；第二轮补充持有平台锁排他模式、停在后一块候选 D 的订单键锁时执行该补记批次——补记明细事务停在等平台锁共享模式（未授予），义务仍未完成、直推余额 0、没有直推凭证；放行补充后才补记入账恰一次（85，义务 done、R5a 关闭，O 共 4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const o = await f.candidate({ subOrderId: `cg11-${token}-01`, people: FROZEN_DIRECT });
    const old = await f.confirmedBatch([o]);

    // O 由旧批次真实入账（R5），冻结的直推开立首次入账义务；之后直推解冻。
    await f.execute(old.batchId);
    expect(await f.rebateOf(o)).toBe('CREDITED');
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
    await f.h.setRisk(f.h.db, o.user('direct'), 'normal');

    // 第一轮补充（生产写口）只出 O 的补记项；经确认写口确认，未执行。
    const first = await f.supplement();
    expect(first.batchIds).toHaveLength(1);
    const makeUpBatch = first.batchIds[0]!;
    expect(await f.itemsIn([makeUpBatch])).toEqual([
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: o.orderId,
        beneficiary_credit_id: obligationId,
        result: null,
      }),
    ]);
    expect(await f.confirmDrafts()).toEqual([makeUpBatch]);
    expect(await f.batch(makeUpBatch)).toMatchObject({ status: 'CONFIRMED' });

    // 第二轮补充的候选 D（在后一块），另一个名义时刻。
    const decoy = await f.candidate({ subOrderId: `cg11-${token}-02` });
    expect(o.orderKey < decoy.orderKey).toBe(true);
    f.h.clock.set(LATER);

    const holder = await holdOrderLock(p.control, decoy);
    const launch = track(f.supplement({ lockChunkSize: 1 }));
    let execution: Tracked<void> | undefined;
    let waiter: number | null = null;
    let supplementGate = 0;
    let executorWaits = false;
    let sharedGranted = -1;
    let whileWaiting: unknown = null;
    let gatePid: number | null = null;
    let waiterOrderKeys = -1;
    let itemKeyFree = false;
    let stuck: string[] = [];
    try {
      // 补充在途：第一块（O）已处理完，停在第二块 D 的订单键锁上，且已持有平台锁排他模式。
      waiter = await orderLockWaiter(p.left, decoy, launch);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE, waiter ?? -1);
      // 执行补记批次：补记明细事务停在等平台锁共享模式。
      execution = track(f.execute(makeUpBatch));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      sharedGranted = await gateGranted(p.left, f.appId, TAOBAO, SHARE);
      // 第 3 次（r2 第 1 条）：等平台锁的补记明细事务此刻不持有任何订单键锁，O 的订单键别的连接能取到。
      gatePid = await gateWaiter(p.left, f.appId, TAOBAO, SHARE);
      waiterOrderKeys = await grantedOrderKeyLocksOf(p.left, gatePid ?? -1);
      itemKeyFree = await tryOrderLock(p.right, o);
      whileWaiting = {
        obligations: (await f.obligationsOf(o)).map((row) => row.status),
        direct: await f.h.balance(o.user('direct')),
        ledger: await f.orderLedger(o),
        items: (await f.itemsIn([makeUpBatch])).map((row) => row.result),
      };
    } finally {
      holder.release();
      stuck = await finish(p.left, { holder: track(holder.done), launch, execution });
    }
    expect(stuck).toEqual([]);
    expect(waiter).not.toBeNull();
    expect(supplementGate).toBe(1);
    expect(executorWaits).toBe(true);
    expect(sharedGranted).toBe(0);
    expect(gatePid).not.toBeNull();
    expect(waiterOrderKeys).toBe(0);
    expect(itemKeyFree).toBe(true);
    // 等锁期间：义务仍未完成，直推没有入账、没有凭证，补记明细结果为空。
    expect(whileWaiting).toEqual({
      obligations: ['open'],
      direct: 0n,
      ledger: {
        vouchers: [creditKey(o, 'self'), creditKey(o, 'indirect'), platformKey(o)].sort(),
        lines: 6,
      },
      items: [null],
    });

    // 放行后第二轮补充先提交：D 的首次入账明细与 O 的补记项（同一义务，提交时仍未完成）。
    const second = await launch.outcome;
    const allSupplements = await f.supplementBatches();
    const secondIds = allSupplements.map((b) => b.batch_id).filter((id) => id !== makeUpBatch);
    expect(second).toEqual({ ok: true, value: generated(secondIds) });
    expect(secondIds).toHaveLength(1);
    const secondItems = await f.itemsIn(secondIds);
    expect(secondItems).toHaveLength(2);
    expect(secondItems).toContainEqual(
      expect.objectContaining({
        item_type: 'order',
        order_id: decoy.orderId,
        b_settle_fen: 850n,
        result: null,
      }),
    );
    expect(secondItems).toContainEqual(
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: o.orderId,
        beneficiary_credit_id: obligationId,
        result: null,
      }),
    );

    // 补记批次随后执行：补记 85 恰入账一次，义务由 R5a 关闭。
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemsIn([makeUpBatch])).toEqual([
      expect.objectContaining({
        beneficiary_credit_id: obligationId,
        result: 'credited',
        amount_fen: 85n,
      }),
    ]);
    expect(await f.batch(makeUpBatch)).toMatchObject({ status: 'DONE', credited_count: 1 });
    expect(await f.obligationsOf(o)).toEqual([
      expect.objectContaining({
        beneficiary_credit_id: obligationId,
        status: 'done',
        closed_by: 'R5a',
      }),
    ]);
    expect(await f.h.balance(o.user('direct'))).toBe(85n);
    expect(await f.h.balance(o.user('self'))).toBe(425n);
    expect(await f.h.balance(o.user('indirect'))).toBe(42n);
    expect(await f.orderLedger(o)).toEqual(fullCredit(o));
    expect(await f.creditHistoryCounts(o)).toEqual({ firstCredit: 1, selfStep: 1 });
    expect(await f.rebateOf(decoy)).toBe('WAITING');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#12] 同一次投递里的每条明细都先取平台锁共享模式：旧批次两条首次入账明细 X < Y 同一次投递顺序执行；X 入账提交后、Y 的明细事务开始之前（执行器读开关处设屏障），补充持有平台锁排他模式、停在后一块候选 D 的订单键锁——放行屏障后 Y 的明细事务停在等平台锁共享模式（未授予），Y 仍待入账、Y 的明细结果为空；放行补充后补充提交（新批次只有 D），同一次投递随后把 Y 入账恰一次（X、Y 各 4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const x = await f.candidate({ subOrderId: `cg12-${token}-01` });
    const y = await f.candidate({ subOrderId: `cg12-${token}-02` });
    const decoy = await f.candidate({ subOrderId: `cg12-${token}-03` });
    expect(x.orderKey < y.orderKey && y.orderKey < decoy.orderKey).toBe(true);
    const old = await f.confirmedBatch([x, y]);

    // 屏障：X 已提交为 CREDITED 之后执行器的第一次开关读取（Y 的明细事务开始之前）。
    const held = f.executePaused(old.batchId, async () => (await f.rebateOf(x)) === 'CREDITED');
    const execution = track(held.run);
    let holder: OrderLockHolder | undefined;
    let launch: Tracked<SupplementResult> | undefined;
    let reached = false;
    let atBarrier: unknown = null;
    let waiter: number | null = null;
    let supplementGate = 0;
    let executorWaits = false;
    let sharedGranted = -1;
    let whileWaiting: unknown = null;
    let gatePid: number | null = null;
    let waiterOrderKeys = -1;
    let itemKeyFree = false;
    let stuck: string[] = [];
    try {
      reached = await reachedBefore(held.pause, execution);
      atBarrier = {
        x: await f.rebateOf(x),
        xItem: (await f.itemOf(old, x)).result,
        y: await f.rebateOf(y),
        yItem: (await f.itemOf(old, y)).result,
      };
      // 此时发起补充，让它停在途中（持有平台锁排他模式、等 D 的订单键锁）。
      holder = await holdOrderLock(p.control, decoy);
      launch = track(f.supplement({ lockChunkSize: 1 }));
      waiter = await orderLockWaiter(p.left, decoy, launch);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE, waiter ?? -1);
      // 放行屏障：同一次投递继续到 Y 的明细事务。
      held.pause.release();
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      sharedGranted = await gateGranted(p.left, f.appId, TAOBAO, SHARE);
      // 第 3 次（r2 第 1 条）：等平台锁的 Y 明细事务此刻不持有任何订单键锁，Y 的订单键别的连接能取到。
      gatePid = await gateWaiter(p.left, f.appId, TAOBAO, SHARE);
      waiterOrderKeys = await grantedOrderKeyLocksOf(p.left, gatePid ?? -1);
      itemKeyFree = await tryOrderLock(p.right, y);
      whileWaiting = {
        y: await f.rebateOf(y),
        yItem: (await f.itemOf(old, y)).result,
        yLedger: await f.orderLedger(y),
      };
    } finally {
      held.pause.release();
      holder?.release();
      stuck = await finish(p.left, {
        holder: holder === undefined ? undefined : track(holder.done),
        launch,
        execution,
      });
    }
    expect(stuck).toEqual([]);
    expect(reached).toBe(true);
    expect(atBarrier).toEqual({ x: 'CREDITED', xItem: 'credited', y: 'WAITING', yItem: null });
    expect(waiter).not.toBeNull();
    expect(supplementGate).toBe(1);
    expect(executorWaits).toBe(true);
    expect(sharedGranted).toBe(0);
    expect(gatePid).not.toBeNull();
    expect(waiterOrderKeys).toBe(0);
    expect(itemKeyFree).toBe(true);
    expect(whileWaiting).toEqual({
      y: 'WAITING',
      yItem: null,
      yLedger: { vouchers: [], lines: 0 },
    });

    // 补充提交：新批次只有 D（Y 仍在执行中的旧批次里，X 已入账且无义务）。
    expect(launch).toBeDefined();
    const batches = await f.supplementBatches();
    expect(await launch!.outcome).toEqual({
      ok: true,
      value: generated(batches.map((b) => b.batch_id)),
    });
    expect(await f.itemsIn(batches.map((b) => b.batch_id))).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: decoy.orderId,
        settle_seq: 2,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);
    const seen = await f.validations();
    expect(seen).toHaveLength(3);
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: x.orderKey, result: 'already_credited' }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: y.orderKey, result: 'candidate', settleSeq: 2 }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: decoy.orderKey, result: 'candidate', settleSeq: 2 }),
    );

    // 同一次投递随后把 Y 入账恰一次。
    expect(await execution.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, x)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.itemOf(old, y)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'DONE', credited_count: 2 });
    expect(await f.creditedHistory(x)).toBe(1);
    expect(await f.creditedHistory(y)).toBe(1);
    expect(await f.orderLedger(x)).toEqual(fullCredit(x));
    expect(await f.orderLedger(y)).toEqual(fullCredit(y));
    expect(await f.h.balance(y.user('self'))).toBe(425n);
    expect(await f.rebateOf(decoy)).toBe('WAITING');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#13] 京东同样互斥：京东补充持有京东平台锁排他模式、停在后一块京东候选 D 的订单键锁时启动京东旧批次执行——P 的明细事务停在等京东平台锁共享模式（未授予），淘宝平台锁无人持有，P 仍待入账、旧明细结果为空；放行补充后补充提交、新批次只有 D；随后执行器继续，P 入账恰一次（4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ platform: JD, subOrderId: `cg13-${token}-01` });
    const decoy = await f.candidate({ platform: JD, subOrderId: `cg13-${token}-02` });
    expect(order.orderKey < decoy.orderKey).toBe(true);
    const old = await f.confirmedBatch([order], JD);

    const holder = await holdOrderLock(p.control, decoy);
    const launch = track(f.supplementOn(JD, { lockChunkSize: 1 }));
    let execution: Tracked<void> | undefined;
    let waiter: number | null = null;
    let supplementGate = 0;
    let taobaoGates = -1;
    let executorWaits = false;
    let sharedGranted = -1;
    let whileWaiting: unknown = null;
    let gatePid: number | null = null;
    let waiterOrderKeys = -1;
    let itemKeyFree = false;
    let stuck: string[] = [];
    try {
      // 京东补充在途：第一块（P）已处理完，停在 D 的订单键锁上，持有京东平台锁排他模式。
      waiter = await orderLockWaiter(p.left, decoy, launch);
      supplementGate = await gateGranted(p.left, f.appId, JD, EXCLUSIVE, waiter ?? -1);
      taobaoGates = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, JD, SHARE, execution);
      sharedGranted = await gateGranted(p.left, f.appId, JD, SHARE);
      // 第 3 次（r2 第 1 条）：等京东平台锁的 P 明细事务此刻不持有任何订单键锁，P 的订单键别的连接能取到。
      gatePid = await gateWaiter(p.left, f.appId, JD, SHARE);
      waiterOrderKeys = await grantedOrderKeyLocksOf(p.left, gatePid ?? -1);
      itemKeyFree = await tryOrderLock(p.right, order);
      whileWaiting = {
        rebate: await f.rebateOf(order),
        item: (await f.itemOf(old, order)).result,
        ledger: await f.orderLedger(order),
      };
    } finally {
      holder.release();
      stuck = await finish(p.left, { holder: track(holder.done), launch, execution });
    }
    expect(stuck).toEqual([]);
    expect(waiter).not.toBeNull();
    expect(supplementGate).toBe(1);
    expect(taobaoGates).toBe(0);
    expect(executorWaits).toBe(true);
    expect(sharedGranted).toBe(0);
    expect(gatePid).not.toBeNull();
    expect(waiterOrderKeys).toBe(0);
    expect(itemKeyFree).toBe(true);
    expect(whileWaiting).toEqual({
      rebate: 'WAITING',
      item: null,
      ledger: { vouchers: [], lines: 0 },
    });

    // 京东补充提交：新批次只有 D（P 仍在未执行完的旧批次里）。
    const batches = await f.supplementBatches();
    const batchIds = batches.map((b) => b.batch_id);
    expect(await launch.outcome).toEqual({
      ok: true,
      value: { outcome: 'generated', billId: MONTH, platform: JD, batchIds },
    });
    expect(batches).toEqual([
      expect.objectContaining({ platform: JD, kind: 'supplement', status: 'DRAFT' }),
    ]);
    expect(await f.itemsIn(batchIds)).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: decoy.orderId,
        settle_seq: 2,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);

    // 执行器随后继续：P 入账恰一次。
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, order)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'DONE' });
    expect(await f.rebateOf(order)).toBe('CREDITED');
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));
    expect(await f.h.balance(order.user('self'))).toBe(425n);
    expect(await f.h.balance(order.user('direct'))).toBe(85n);
    expect(await f.h.balance(order.user('indirect'))).toBe(42n);
    expect(await f.rebateOf(decoy)).toBe('WAITING');
  },
  TIMEOUT,
);
