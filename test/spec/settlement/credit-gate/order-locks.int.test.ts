// B2-04re rule tests (claude-independent, SPEC_REF 081b177; 任务书 9.2 ⑥ ⑦): 08 BR-FUND-16 细则「加锁流程」
// 第 0 步 with BR-FUND-04 ⑧ — the supplement launch holds exactly one gate lock (exclusive mode) to
// commit, while the candidates' order key locks are taken chunk by chunk and released at the end of
// each chunk (#6); inside a chunk they are held, so the launch waiting for B really holds A's order
// key lock and not merely some other advisory lock (#7, the point [AC-B2-04rd#8] loses once the gate
// is counted too).
// The order key lock is orders' lockOrderKey, `pg_advisory_xact_lock(hashtextextended($1, 0))` on
// 'orders.order_key:' + order key (one bigint key, pg_locks objsubid 1); the gate is the two-int key
// of the skeleton's creditGateKey (objsubid 2). Another connection holds the order key lock the launch
// is made to wait for (放行 = it rolls back); a third probes with pg_try_advisory_xact_lock and rolls
// back at once. Waits are read from pg_locks with a bounded poll, never inferred from a sleep.
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle 850 = snapshot v2 base (candidates, tolerance 0).
// Both are red on the current code: the launch takes no order key lock and no gate, so it never waits
// (the bounded poll answers null). On the skeleton #6 then throws NotImplemented from creditGateKey
// (gateRowsOf, inside the try: the holder is released first); #7 reads no gate and fails on
// `expect(waiter).not.toBeNull()`.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  EXCLUSIVE,
  TAOBAO,
  TIMEOUT,
  databaseFixture,
  fixture,
  gateRowsOf,
  generated,
  grantedOrderKeyLocksOf,
  holdOrderLock,
  orderLockWaiter,
  track,
  tryOrderLock,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04re#6] 订单键锁分块释放、平台锁恰一把：块大小 2、三张候选 A < B < C，另一连接持有 C 的订单键锁——补充停在等 C 时，它所在连接上已授予的订单键锁为 0 把（A、B 所在第一块已放掉：从另一连接 pg_try_advisory_xact_lock 探 A、B 能立即取到，探完回滚），平台互斥锁排他模式已授予恰一把；放行后三张都照常入批',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const a = await f.candidate({ subOrderId: `cg6-${token}-01` });
    const b = await f.candidate({ subOrderId: `cg6-${token}-02` });
    const c = await f.candidate({ subOrderId: `cg6-${token}-03` });
    expect(a.orderKey < b.orderKey && b.orderKey < c.orderKey).toBe(true);

    const holder = await holdOrderLock(p.control, c);
    const launch = track(f.supplement({ lockChunkSize: 2 }));
    let waiter: number | null = null;
    let heldOrderKeys = -1;
    let probes = { a: false, b: false };
    let gateRows: { readonly mode: string; readonly granted: boolean }[] = [];
    try {
      waiter = await orderLockWaiter(p.left, c, launch);
      heldOrderKeys = await grantedOrderKeyLocksOf(p.left, waiter ?? -1);
      probes = { a: await tryOrderLock(p.right, a), b: await tryOrderLock(p.right, b) };
      gateRows = await gateRowsOf(p.left, f.appId, TAOBAO, waiter ?? -1);
    } finally {
      holder.release();
      await holder.done;
      await launch.outcome;
    }
    expect(waiter).not.toBeNull();
    // 等 C 时：第一块（A、B）的订单键锁已放掉，补充连接上一把订单键锁都没有。
    expect(heldOrderKeys).toBe(0);
    expect(probes).toEqual({ a: true, b: true });
    // 平台锁：排他模式，已授予，恰一把。
    expect(gateRows).toEqual([{ mode: EXCLUSIVE, granted: true }]);

    const batches = await f.supplementBatches();
    expect(await launch.outcome).toEqual({
      ok: true,
      value: generated(batches.map((x) => x.batch_id)),
    });
    const items = await f.itemsIn(batches.map((x) => x.batch_id));
    expect(items).toHaveLength(3);
    for (const o of [a, b, c]) {
      expect(items).toContainEqual(
        expect.objectContaining({
          item_type: 'order',
          order_id: o.orderId,
          settle_seq: 2,
          b_settle_fen: 850n,
          result: null,
        }),
      );
    }
    const seen = await f.validations();
    expect(seen).toHaveLength(3);
    for (const o of [a, b, c]) {
      expect(seen).toContainEqual(
        expect.objectContaining({ orderKey: o.orderKey, result: 'candidate', settleSeq: 2 }),
      );
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04re#7] 同一块内的订单键锁持有到块末：块大小 2、两张候选 A < B 在同一块里，另一连接持有 B 的订单键锁——补充停在等 B 时，从第三个连接用 pg_try_advisory_xact_lock 探 A 的键取不到（补充此刻持有的是 A 的订单键锁）；放行后两张都照常入批',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const a = await f.candidate({ subOrderId: `cg7-${token}-01` });
    const b = await f.candidate({ subOrderId: `cg7-${token}-02` });
    expect(a.orderKey < b.orderKey).toBe(true);

    const holder = await holdOrderLock(p.control, b);
    const launch = track(f.supplement({ lockChunkSize: 2 }));
    let waiter: number | null = null;
    let probeA = true;
    try {
      waiter = await orderLockWaiter(p.left, b, launch);
      probeA = await tryOrderLock(p.right, a);
    } finally {
      holder.release();
      await holder.done;
      await launch.outcome;
    }
    expect(waiter).not.toBeNull();
    // A 的订单键锁在补充手里：第三个连接取不到（不是别的咨询锁冒充）。
    expect(probeA).toBe(false);

    const batches = await f.supplementBatches();
    expect(await launch.outcome).toEqual({
      ok: true,
      value: generated(batches.map((x) => x.batch_id)),
    });
    const items = await f.itemsIn(batches.map((x) => x.batch_id));
    expect(items).toHaveLength(2);
    for (const o of [a, b]) {
      expect(items).toContainEqual(
        expect.objectContaining({ item_type: 'order', order_id: o.orderId, b_settle_fen: 850n }),
      );
    }
  },
  TIMEOUT,
);
