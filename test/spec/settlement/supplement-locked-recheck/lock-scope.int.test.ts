// B2-04rd rule tests, 3rd round (claude-independent, SPEC_REF 693f6a6; 任务书 §11.2, 评审 r1 第 2、6
// 条与范围外 S2): with two candidates each is classified on what is read after its own order lock —
// not on what was read after an earlier one (#8); the locks follow ascending order key whatever order
// the source hands back, and what is read under them is the launching app's only (#14).
// The lock is orders' lockOrderKey, `select pg_advisory_xact_lock(hashtextextended($1, 0))` on
// 'orders.order_key:' + order key (02 §18). Waits are observed in pg_locks with a bounded poll, never
// inferred from a sleep; statements are recorded on the executor the launch runs on (a Kysely plugin).
// Amounts (自拟) in ./kit.ts: N = 1000, B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base;
// the harness' default records are seq 1 STATEMENT (decides the amount) and seq 2 API, so the
// whole-order greatest seq is 2.
// Both are red on the current code: no order lock is taken (no lock statement, no wait).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  ORDERS_READ,
  ORDER_LOCK,
  SETTLEMENTS_READ,
  TIMEOUT,
  advisoryGranted,
  advisoryWaiter,
  databaseFixture,
  deferred,
  fixture,
  generated,
  lockKey,
  lockOrderKey,
  reverseFirstSourceRead,
  tracing,
  track,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04rd#8] 多张候选各按自己锁后的状态：两张候选 A < B（订单键），另一连接先用 lockOrderKey 持有 B 的锁——补充在拿到 A 的锁后停在等 B（pg_locks），不产生批次；持锁方在锁内经 R11 给 B 加 hold 后提交释放，补充随即完成：A 照常入批（首次入账明细 settle_seq 2、b_settle 850，逐单 candidate），B 按释放后的状态暂缓、不入批（逐单 deferred）',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const a = await f.candidate({ subOrderId: `ms-${token}-01` });
    const b = await f.candidate({ subOrderId: `ms-${token}-02` });
    expect(a.orderKey < b.orderKey).toBe(true);
    expect(a.seq).toBe(2);
    const locked = deferred();
    const release = deferred();
    const holder = p.control.transaction().execute(async (trx) => {
      await lockOrderKey(trx, b.platform, b.subOrderId);
      locked.resolve();
      await release.promise;
      // 补充等 B 的锁期间，持锁方在同一把锁内给 B 加 hold，随后提交释放锁。
      await f.holdIn(trx, b);
    });
    await Promise.race([locked.promise, holder]);

    const launch = track(f.launch());
    let blocked = false;
    let granted = 0;
    let batchesWhileWaiting: unknown[] = [];
    try {
      blocked = await advisoryWaiter(p.left, launch);
      granted = await advisoryGranted(p.left);
      batchesWhileWaiting = await f.supplementBatches();
    } finally {
      release.resolve();
      await holder;
    }
    expect(blocked).toBe(true);
    // 等 B 时已持有 A 的锁：持锁方的 B 一把、补充的 A 一把。
    expect(granted).toBeGreaterThanOrEqual(2);
    expect(batchesWhileWaiting).toEqual([]);

    const outcome = await launch.outcome;
    expect(await f.h.read(b)).toMatchObject({ rebate_status: 'WAITING', hold: true });
    expect(await f.h.read(a)).toMatchObject({ rebate_status: 'WAITING', hold: false });
    const batches = await f.supplementBatches();
    expect(outcome).toEqual({ ok: true, value: generated(batches.map((x) => x.batch_id)) });
    expect(await f.allItems()).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: a.orderId,
        settle_seq: a.seq,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);
    const seen = await f.validations();
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: a.orderKey, result: 'candidate', settleSeq: 2 }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({ orderKey: b.orderKey, result: 'deferred' }),
    );
    expect(await f.jobs()).toEqual([
      expect.objectContaining({ status: 'done', processed_count: 2, skipped_count: 1 }),
    ]);
    expect(await f.diffs()).toEqual([]);
    expect(f.registerDiff).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04rd#14] 取锁排序不依赖来源顺序、锁后读取限定本 app：来源第一次读库后按订单键倒序交回两张候选——取锁仍按订单键升序；另一个 app 自己的同平台候选不取锁，第一把锁之后读 orders / order_settlements 的语句都带 app_id 条件、参数是本 app 的 app_id 而没有另一个 app 的；两张候选照常入批，另一个 app 前后不变',
  async () => {
    const f = await fixture(p.db);
    const g = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const earlier = await f.candidate({ subOrderId: `rv-${token}-01` });
    const later = await f.candidate({ subOrderId: `rv-${token}-02` });
    expect(earlier.orderKey < later.orderKey).toBe(true);
    const theirs = await g.candidate({ subOrderId: `rv-${token}-00` });
    const untouched = await g.state();
    reverseFirstSourceRead(f);
    const traced = tracing(p.db);

    const result = await f.launch(traced.db);

    // 第一次来源读取确实按订单键倒序交回（真实读库，只交换顺序）。
    const firstRead = f.readSource.mock.results[0];
    expect(firstRead?.type).toBe('return');
    if (firstRead?.type !== 'return') throw new Error('the first source read did not return');
    const firstRows = await firstRead.value;
    expect(firstRows.map((r) => r.orderKey)).toEqual([later.orderKey, earlier.orderKey]);

    const q = traced.queries;
    function lockAt(o: SeededOrder): number {
      return q.findIndex((s) => ORDER_LOCK.test(s.sql) && s.parameters.includes(lockKey(o)));
    }
    expect(lockAt(earlier)).toBeGreaterThanOrEqual(0);
    expect(lockAt(later)).toBeGreaterThan(lockAt(earlier));
    const lockedKeys = q.filter((s) => ORDER_LOCK.test(s.sql)).flatMap((s) => s.parameters);
    expect(lockedKeys).not.toContain(lockKey(theirs));

    // 第一把锁之后读 orders / order_settlements 的语句：带 app_id 条件，参数只有本 app 的 app_id。
    const firstLock = q.findIndex((s) => ORDER_LOCK.test(s.sql));
    const reads = q.filter(
      (s, i) => i > firstLock && (ORDERS_READ.test(s.sql) || SETTLEMENTS_READ.test(s.sql)),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) {
      expect(s.sql).toMatch(/\bapp_id\b/);
      expect(s.parameters).toContain(f.appId);
      expect(s.parameters).not.toContain(g.appId);
    }

    const items = await f.itemsIn(result.batchIds);
    expect(items).toHaveLength(2);
    for (const o of [earlier, later]) {
      expect(items).toContainEqual(
        expect.objectContaining({
          item_type: 'order',
          order_id: o.orderId,
          settle_seq: 2,
          b_settle_fen: 850n,
        }),
      );
    }
    expect(await g.state()).toEqual(untouched);
  },
  TIMEOUT,
);
