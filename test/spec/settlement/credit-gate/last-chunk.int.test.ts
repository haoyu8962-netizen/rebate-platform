// B2-04re rule test, round 3 (claude-independent, SPEC_REF 081b177; 任务书 §11.2 ④, 评审 r2 第 4 条): 08
// BR-FUND-16 细则「加锁流程」 with BR-FUND-04 ⑧ and D10-2800 — the supplement launch rolls back to the
// savepoint of every lock chunk once its re-read is done, the last chunk included: the order key
// locks of the last chunk are gone before the launch writes its batches, while the platform gate (taken
// outside the chunk savepoints) stays held in exclusive mode until commit. Keeping the last chunk's
// order key locks to commit would block a hold, a rights case or order-sync on those orders for the
// rest of the launch.
// Lock chunk size 2, candidates A < B in the one (so last) chunk. The launch is held right after its
// first settle_batches / settle_batch_items write (./kit.ts pauseAfter with BATCH_WRITE; that is past
// the chunk's re-read and the one 「仍在未执行批次里」 query; 放行 = the plugin hands the result back).
// Meanwhile another connection probes the order key locks of A and B with pg_try_advisory_xact_lock
// (the key of orders' lockOrderKey) and rolls back at once, and the gate rows of the launch's backend
// (the one idle in transaction after that write) are read from pg_locks. The barrier is bounded
// (./kit.ts reachedBefore) and the finally ends the launch within a bound (./kit.ts finish).
// Amounts (自拟) in ./kit.ts: N 1000 → B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base
// (candidates, tolerance 0).
// Red on the skeleton: the pause is reached (the current launch writes the batches) and both probes
// get their locks (the current launch takes none), then gateGranted throws NotImplemented from
// creditGateKey (inside the try; the finally releases the pause and ends the launch). Past that, the
// current launch reads its source once (readsAtPause 1) and holds no gate.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BATCH_WRITE,
  EXCLUSIVE,
  TAOBAO,
  TIMEOUT,
  databaseFixture,
  finish,
  fixture,
  gateGranted,
  generated,
  idleInTransactionOn,
  pauseAfter,
  reachedBefore,
  track,
  tryOrderLock,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04re#20] 最后一块的订单键锁在块末就放、不留到提交：块大小 2、候选 A < B 同在唯一（也是最后）一块；补充在末块重读结束之后第一次写批次处暂停——此时从另一个连接 pg_try_advisory_xact_lock 探 A、B 的订单键都能立即取到，补充所在连接上平台锁排他模式仍已授予恰一把；放行后补充提交，两张照常入批',
  async () => {
    const f = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    const a = await f.candidate({ subOrderId: `cg20-${token}-01` });
    const b = await f.candidate({ subOrderId: `cg20-${token}-02` });
    expect(a.orderKey < b.orderKey).toBe(true);

    const held = pauseAfter(p.db, (query) => BATCH_WRITE.test(query.sql));
    const launch = track(f.supplement({ via: held.db, lockChunkSize: 2 }));
    let reached = false;
    let readsAtPause = -1;
    let during = { a: false, b: false };
    let launchPid: number | null = null;
    let launchGate = -1;
    let allExclusive = -1;
    let stuck: string[] = [];
    try {
      // 补充停在第一次写批次之后：末块（A、B）已重读完、保存点已回滚，事务仍开着。
      reached = await reachedBefore(held.pause, launch);
      readsAtPause = f.readSource.mock.calls.length;
      during = { a: await tryOrderLock(p.right, a), b: await tryOrderLock(p.right, b) };
      launchPid = await idleInTransactionOn(p.left, 'settle_batch');
      launchGate = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE, launchPid ?? -1);
      allExclusive = await gateGranted(p.left, f.appId, TAOBAO, EXCLUSIVE);
    } finally {
      held.pause.release();
      stuck = await finish(p.left, { launch });
    }
    expect(stuck).toEqual([]);
    expect(reached).toBe(true);
    // 第一次读来源 + 末块的一次锁内重读。
    expect(readsAtPause).toBe(2);
    // 末块的订单键锁已在块末放掉，别的连接立即取得到。
    expect(during).toEqual({ a: true, b: true });
    // 平台锁排他模式仍在补充手里，恰一把。
    expect(launchPid).not.toBeNull();
    expect(launchGate).toBe(1);
    expect(allExclusive).toBe(1);

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
