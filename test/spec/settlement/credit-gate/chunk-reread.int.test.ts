// B2-04re rule test, round 2 (claude-independent, SPEC_REF 081b177; 任务书 §10.2 ⑧, 评审 r1 第 7 条): 08
// BR-FUND-16 细则「加锁流程」 with BR-FUND-04 ⑧ and D10-2800 — inside a lock chunk the supplement launch
// re-reads its source while it holds that chunk's order key locks, and only then rolls back to the
// chunk's savepoint. Releasing the locks first and re-reading afterwards would let a hold, a rights
// case or order-sync commit between the release and the read (the read would then classify on a row
// nobody locked) — this case pins the re-read of the last chunk.
// Lock chunk size 2, candidates A < B in the one (so last) chunk. The launch's second source read (the
// re-read of that chunk) is held at its entry, before the production reader runs (./kit.ts
// pauseSupplementSource(2, 'entry'); 放行 = release). Meanwhile another connection probes the order key
// locks of A and B with pg_try_advisory_xact_lock (the key of orders' lockOrderKey) and rolls back at
// once. The barrier is bounded (./kit.ts reachedBefore) and the finally ends the launch within a bound
// (./kit.ts finish).
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base
// (candidates, tolerance 0).
// Red on the current code: the launch reads its source once and takes no order key lock, so the
// second read never comes — reachedBefore answers false once the launch has ended and the case fails
// on `expect(reached).toBe(true)`.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  finish,
  fixture,
  generated,
  reachedBefore,
  track,
  tryOrderLock,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04re#17] 末块的重读在订单键锁内：块大小 2、候选 A < B 同在最后一块；补充的第二次来源读（块内重读）停在读取入口时，从另一个连接 pg_try_advisory_xact_lock 探 A、B 的订单键都取不到；放行重读、补充完成后再探都能取到；两张照常入批',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const a = await f.candidate({ subOrderId: `cg17-${token}-01` });
    const b = await f.candidate({ subOrderId: `cg17-${token}-02` });
    expect(a.orderKey < b.orderKey).toBe(true);

    const reread = f.pauseSupplementSource(2, 'entry');
    const launch = track(f.supplement({ lockChunkSize: 2 }));
    let reached = false;
    let readsAtBarrier = -1;
    let during = { a: true, b: true };
    let stuck: string[] = [];
    try {
      // 补充停在块内重读的入口：这一块（A、B）的订单键锁此刻应在它手里。
      reached = await reachedBefore(reread, launch);
      readsAtBarrier = f.readSource.mock.calls.length;
      during = { a: await tryOrderLock(p.right, a), b: await tryOrderLock(p.right, b) };
    } finally {
      reread.release();
      stuck = await finish(p.left, { launch });
    }
    const after = { a: await tryOrderLock(p.right, a), b: await tryOrderLock(p.right, b) };
    expect(stuck).toEqual([]);
    expect(reached).toBe(true);
    expect(readsAtBarrier).toBe(2);
    // 重读进行时：A、B 的订单键锁都被补充持有，别的连接取不到。
    expect(during).toEqual({ a: false, b: false });
    // 补充结束后：都已放掉。
    expect(after).toEqual({ a: true, b: true });

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
    const seen = await f.validations();
    expect(seen).toHaveLength(2);
    for (const o of [a, b]) {
      expect(seen).toContainEqual(
        expect.objectContaining({ orderKey: o.orderKey, result: 'candidate', settleSeq: 2 }),
      );
    }
  },
  TIMEOUT,
);
