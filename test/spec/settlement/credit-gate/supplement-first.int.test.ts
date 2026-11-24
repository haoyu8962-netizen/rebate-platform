// B2-04re rule tests (claude-independent, SPEC_REF 081b177; 任务书 9.2 ② ③ ⑧ ⑨): 08 BR-FUND-16 细则
// 「加锁流程」第 0 步 with BR-FUND-04 ⑦⑧ — while a supplement launch holds the platform gate
// (exclusive mode, to commit), an item transaction of the executor waits for the gate (shared mode)
// before it credits anything: for a batch never executed (#2), for a PARTIAL batch finance continues
// (#3); when the switch went off meanwhile the item is not credited (#8); when the launch rolls back
// the item goes on (#9).
// 「补充在途」: a candidate D sits in a later lock chunk (lockChunkSize injected) and another
// connection holds D's order key lock (orders' lockOrderKey, not committed) — the launch has taken the
// gate and finished the earlier chunks, then waits for D (放行 = the holder rolls back). In #3 the
// launch is held instead right after its first settle_batches write (a Kysely plugin, ./kit.ts
// pauseAfter): that is past the one 「仍在未执行批次里」 query, which a continued (EXECUTING) batch
// would answer differently, while the gate is still held (放行 = the plugin hands the result back).
// The executor, the SB8 resume, confirmation and the switch map are the production pieces of
// ./kit.ts. Waits are read from pg_locks with a bounded poll, never inferred from a sleep.
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle 850 = snapshot v2 base; a credit books self 425,
// direct 85, indirect 42, PLATFORM:CREDIT 448: 4 vouchers, 8 entry lines.
// All four are red on the skeleton: creditGateKey throws NotImplemented at the first gate read; past
// that, the current code takes neither the gate nor order key locks (#2, #8, #9: the launch never
// waits for D; #3: the continued item never waits and credits Q before the launch commits).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BATCH_WRITE,
  EXCLUSIVE,
  ITEM_WRITE,
  PAST_SWITCH_CACHE,
  SHARE,
  TAOBAO,
  TIMEOUT,
  creditKey,
  databaseFixture,
  failAfter,
  fixture,
  gateGranted,
  generated,
  holdOrderLock,
  orderLockWaiter,
  pauseAfter,
  platformKey,
  reachedBefore,
  track,
  waitsOnGate,
  type SeededOrder,
  type Tracked,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

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
  '[AC-B2-04re#2] 补充在途时执行等它（未执行批次）：P 在已确认的旧批次里；补充持有平台锁排他模式、停在后一块候选 D 的订单键锁时启动旧批次执行——P 的明细事务停在等平台锁共享模式（未授予），P 仍待入账、旧明细结果为空；放行补充后补充提交、新批次里没有 P 的明细（仍在未执行批次里）只有 D 的；随后执行器继续，P 入账恰一次（4 张凭证、8 条分录）',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg2-${token}-01` });
    const decoy = await f.candidate({ subOrderId: `cg2-${token}-02` });
    expect(order.orderKey < decoy.orderKey).toBe(true);
    const old = await f.confirmedBatch([order]);

    const holder = await holdOrderLock(p.control, decoy);
    const launch = track(f.supplement({ lockChunkSize: 1 }));
    let execution: Tracked<void> | undefined;
    let waiter: number | null = null;
    let supplementGate = 0;
    let executorWaits = false;
    let whileWaiting: { rebate: string; item: string | null } = { rebate: '', item: '' };
    try {
      // 补充在途：第一块（P）已处理完，停在第二块 D 的订单键锁上，且已持有平台锁排他模式。
      waiter = await orderLockWaiter(p.left, decoy, launch);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE, waiter ?? -1);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      whileWaiting = {
        rebate: await f.rebateOf(order),
        item: (await f.itemOf(old, order)).result,
      };
    } finally {
      holder.release();
      await holder.done;
      await launch.outcome;
      await execution?.outcome;
    }
    expect(waiter).not.toBeNull();
    expect(supplementGate).toBe(1);
    expect(executorWaits).toBe(true);
    expect(whileWaiting).toEqual({ rebate: 'WAITING', item: null });

    // 补充提交：新批次只有 D 的首次入账明细，没有 P 的（P 仍在未执行批次里）。
    const batches = await f.supplementBatches();
    expect(await launch.outcome).toEqual({
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
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: order.orderKey, result: 'candidate', settleSeq: 2 }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: decoy.orderKey, result: 'candidate', settleSeq: 2 }),
    );

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

it(
  '[AC-B2-04re#3] 补充在途时执行等它（因开关暂停后被继续执行的批次）：旧批次入账 Q0 后因入账开关关闭停在 PARTIAL、Q 未处理；开关恢复。补充持有平台锁、已写出含 Q 首次入账明细的批次而未提交时，财务经 SB8 继续执行该批次、执行器开始执行——Q 的明细事务停在等平台锁、Q 仍待入账；放行补充后补充提交，Q 晚于它入账恰一次；再确认并真实执行补充的新批次，Q 那条明细按 not_waiting 跳过，凭证与分录数不变',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const first = await f.candidate({ subOrderId: `cg3-${token}-01` });
    const order = await f.candidate({ subOrderId: `cg3-${token}-02` });
    expect(first.orderKey < order.orderKey).toBe(true);
    const old = await f.confirmedBatch([first, order]);

    // 旧批次因开关停住（生产路径）：Q0 的明细事务等 Q0 的订单键锁时关掉入账开关，放行后 Q0 入账、
    // 下一条明细之前读到开关关闭 → SB7 PARTIAL，Q 未处理。
    const pauser = await holdOrderLock(p.control, first);
    const starting = track(f.execute(old.batchId));
    let starterWaiter: number | null = null;
    try {
      starterWaiter = await orderLockWaiter(p.left, first, starting);
      f.switches.set(`credit.enabled.${TAOBAO}`, false);
    } finally {
      pauser.release();
      await pauser.done;
      await starting.outcome;
    }
    expect(starterWaiter).not.toBeNull();
    expect(await starting.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'PARTIAL' });
    expect(await f.itemOf(old, first)).toMatchObject({ result: 'credited' });
    expect(await f.itemOf(old, order)).toMatchObject({ result: null });
    expect(await f.rebateOf(order)).toBe('WAITING');
    // 开关恢复。
    f.switches.set(`credit.enabled.${TAOBAO}`, true);

    const held = pauseAfter(p.db, (query) => BATCH_WRITE.test(query.sql));
    const launch = track(f.supplement({ via: held.db }));
    let execution: Tracked<void> | undefined;
    let reached = false;
    let supplementGate = 0;
    let executorWaits = false;
    let whileWaiting: { rebate: string; item: string | null; batch: string } = {
      rebate: '',
      item: '',
      batch: '',
    };
    try {
      // 补充在途：已写出它的批次行（「仍在未执行批次里」的查询已过），持有平台锁排他模式，未提交。
      reached = await reachedBefore(held.pause, launch);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
      // 财务继续执行（SB8，PARTIAL → EXECUTING），执行器开始执行。
      await f.resume(old.batchId);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      whileWaiting = {
        rebate: await f.rebateOf(order),
        item: (await f.itemOf(old, order)).result,
        batch: (await f.batch(old.batchId)).status,
      };
    } finally {
      held.pause.release();
      await launch.outcome;
      await execution?.outcome;
    }
    expect(reached).toBe(true);
    expect(supplementGate).toBe(1);
    expect(executorWaits).toBe(true);
    // 放行补充之前 Q 仍待入账：Q 的入账提交晚于补充提交。
    expect(whileWaiting).toEqual({ rebate: 'WAITING', item: null, batch: 'EXECUTING' });

    // 补充提交：新批次里有 Q 的首次入账明细（暂停批次里的单可以再入补充批次）。
    const batches = await f.supplementBatches();
    const batchIds = batches.map((b) => b.batch_id);
    expect(await launch.outcome).toEqual({ ok: true, value: generated(batchIds) });
    expect(await f.itemsIn(batchIds)).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: order.orderId,
        settle_seq: 2,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);

    // 执行器继续：Q 入账恰一次。
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, order)).toMatchObject({ result: 'credited', skip_reason: null });
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'DONE' });
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));

    // 再确认并真实执行补充的新批次：Q 那条明细跳过（订单不在待入账），凭证与分录数不变。
    expect(await f.settleDrafts()).toEqual(batchIds);
    expect(await f.itemsIn(batchIds)).toEqual([
      expect.objectContaining({
        order_id: order.orderId,
        result: 'skipped',
        skip_reason: 'not_waiting',
      }),
    ]);
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));
    expect(await f.h.balance(order.user('self'))).toBe(425n);
    expect(await f.h.balance(order.user('direct'))).toBe(85n);
    expect(await f.h.balance(order.user('indirect'))).toBe(42n);
    expect(await f.orderLedger(first)).toEqual(fullCredit(first));
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#8] 等锁之后开关已关，这一条不入账：补充在途、旧批次 P 的明细事务在等平台锁共享模式；此时关掉入账开关并把注入时钟推进 11 秒（超过开关缓存时限 10 秒）——放行补充后该明细不入账：P 仍待入账、旧明细结果为空、没有 P 的凭证，批次按 SB7 停在 PARTIAL',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg8-${token}-01` });
    const decoy = await f.candidate({ subOrderId: `cg8-${token}-02` });
    expect(order.orderKey < decoy.orderKey).toBe(true);
    const old = await f.confirmedBatch([order]);

    const holder = await holdOrderLock(p.control, decoy);
    const launch = track(f.supplement({ lockChunkSize: 1 }));
    let execution: Tracked<void> | undefined;
    let waiter: number | null = null;
    let supplementGate = 0;
    let executorWaits = false;
    try {
      waiter = await orderLockWaiter(p.left, decoy, launch);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE, waiter ?? -1);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
      // 明细事务等锁期间：入账开关关闭，时钟越过开关缓存时限（只用注入的 Clock）。
      f.switches.set(`credit.enabled.${TAOBAO}`, false);
      f.h.clock.set(PAST_SWITCH_CACHE);
    } finally {
      holder.release();
      await holder.done;
      await launch.outcome;
      await execution?.outcome;
    }
    expect(waiter).not.toBeNull();
    expect(supplementGate).toBe(1);
    expect(executorWaits).toBe(true);
    expect((await launch.outcome).ok).toBe(true);
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });

    // 该明细不入账：订单仍待入账、旧明细结果为空、没有新凭证；批次停在 PARTIAL（SB7）。
    expect(await f.rebateOf(order)).toBe('WAITING');
    expect(await f.itemOf(old, order)).toMatchObject({
      result: null,
      amount_fen: null,
      skip_reason: null,
    });
    expect(await f.orderLedger(order)).toEqual({ vouchers: [], lines: 0 });
    expect(await f.creditedHistory(order)).toBe(0);
    expect(await f.h.balance(order.user('self'))).toBe(0n);
    expect(await f.batch(old.batchId)).toMatchObject({ status: 'PARTIAL', credited_count: 0 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#9] 补充失败回滚后执行继续：补充在途、旧批次 P 的明细事务在等平台锁；补充在写明细那一步库层失败、整笔回滚（无批次、明细、逐单结果残留）→ 等待中的明细事务随即取得共享锁、P 照常入账恰一次；同一补充请求重发后正常完成（只有 D 的首次入账明细，P 记 already_credited），再重发判为重放',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const order = await f.candidate({ subOrderId: `cg9-${token}-01` });
    const decoy = await f.candidate({ subOrderId: `cg9-${token}-02` });
    expect(order.orderKey < decoy.orderKey).toBe(true);
    const old = await f.confirmedBatch([order]);
    const fault = failAfter(p.db, (query) => ITEM_WRITE.test(query.sql));

    const holder = await holdOrderLock(p.control, decoy);
    const launch = track(f.supplement({ via: fault.db, lockChunkSize: 1 }));
    let execution: Tracked<void> | undefined;
    let waiter: number | null = null;
    let supplementGate = 0;
    let executorWaits = false;
    try {
      waiter = await orderLockWaiter(p.left, decoy, launch);
      supplementGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE, waiter ?? -1);
      execution = track(f.execute(old.batchId));
      executorWaits = await waitsOnGate(p.left, f.appId, TAOBAO, SHARE, execution);
    } finally {
      holder.release();
      await holder.done;
      await launch.outcome;
      await execution?.outcome;
    }
    expect(waiter).not.toBeNull();
    expect(supplementGate).toBe(1);
    expect(executorWaits).toBe(true);

    // 补充在写明细那一步失败，整笔回滚：没有补充批次、补充明细与逐单结果。
    const failed = await launch.outcome;
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('the launch was expected to fail');
    expect(String(failed.error)).toContain('injected failure after the statement ran');
    expect(fault.injected()).toBe(1);
    expect(await f.supplementBatches()).toEqual([]);
    expect(await f.allItems()).toEqual([expect.objectContaining({ batch_id: old.batchId })]);
    expect(await f.validations()).toEqual([]);

    // 等待中的明细事务随即取得共享锁，P 照常入账恰一次。
    expect(await execution!.outcome).toEqual({ ok: true, value: undefined });
    expect(await f.itemOf(old, order)).toMatchObject({ result: 'credited' });
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));

    // 同一请求（同一名义时刻 = 注入的 Clock）重发：正常完成。
    const again = await f.supplement({ lockChunkSize: 1 });
    const batches = await f.supplementBatches();
    expect(again).toEqual(generated(batches.map((b) => b.batch_id)));
    expect(await f.itemsIn(again.batchIds)).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: decoy.orderId,
        settle_seq: 2,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);
    const seen = await f.validations();
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: order.orderKey, result: 'already_credited' }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: decoy.orderKey, result: 'candidate', settleSeq: 2 }),
    );
    expect(await f.jobs()).toEqual([
      expect.objectContaining({ status: 'done', processed_count: 2, skipped_count: 0 }),
    ]);

    // 再重发：settle_jobs 键判重放，不再生成批次、不动 P 的账。
    expect(await f.supplement({ lockChunkSize: 1 })).toEqual({
      ...generated([]),
      outcome: 'duplicate',
    });
    expect(await f.supplementBatches()).toEqual(batches);
    expect(await f.creditedHistory(order)).toBe(1);
    expect(await f.orderLedger(order)).toEqual(fullCredit(order));
  },
  TIMEOUT,
);
