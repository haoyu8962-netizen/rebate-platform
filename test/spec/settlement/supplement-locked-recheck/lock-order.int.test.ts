// B2-04rd rule tests (claude-independent, SPEC_REF 693f6a6): the supplement launch takes each
// candidate's order lock — orders' lockOrderKey, `select pg_advisory_xact_lock(hashtextextended($1,
// 0))` on 'orders.order_key:' + order key, the lock of the credit (02 §18, 任务书 9.2 ⑤ ⑦) — in
// ascending order key, before its re-read and before any batch or item write; and it leaves another
// app alone. Statements are recorded on the executor the launch runs on (a Kysely plugin); waits are
// observed in pg_locks with a bounded poll, never inferred from a sleep.
// Amounts (自拟) in ./kit.ts: B_settle 850 = snapshot v2 base.
// #5 and #6 are red on the current code (no order lock is taken: no lock statement, no wait, O is
// batched although it was held while the launch should have waited). #5 also carries the regression
// nails of 9.2 ⑥ (an order already credited at the source read still yields its make-up item) and ⑦
// (another app's own orders are neither read, written nor locked), merged per 任务书 §10.1.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BATCH_WRITE,
  FROZEN_DIRECT,
  ORDERS_READ,
  ORDER_LOCK,
  PLATFORM,
  TIMEOUT,
  advisoryWaiter,
  databaseFixture,
  deferred,
  fixture,
  generated,
  lockKey,
  lockOrderKey,
  tracing,
  track,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04rd#5] 取锁顺序：两张候选（后建的订单键较小）——补充事务内按订单键升序各取一次订单键锁（lockOrderKey 的语句与键文本），每张单的锁先于它的重读（读 orders）与任何批次 / 明细写入；两单照常入批。并入：来源读到就已入账且有未完成义务的单同批照常出补记项（逐单 already_credited）；另一个 app 自己的候选与已入账单不被本 app 的补充读写或取锁，其订单状态、批次、明细、补记义务、凭证前后不变',
  async () => {
    const f = await fixture(p.db);
    const g = await fixture(p.db);
    const token = randomUUID().slice(0, 8);
    // 先建键大的一张、再建键小的一张：取锁顺序只能按订单键，不按建单先后。
    const later = await f.candidate({ subOrderId: `lr-${token}-02` });
    const earlier = await f.candidate({ subOrderId: `lr-${token}-01` });
    expect(earlier.orderKey < later.orderKey).toBe(true);
    // 来源读到就已入账：旧批次在补充之前真实执行（R5），冻结的直推开了首次入账义务。
    const paid = await f.candidate({ people: FROZEN_DIRECT });
    const old = await f.oldBatch([paid]);
    await f.execute([old.batchId]);
    const opened = await f.openObligations(paid);
    expect(opened).toHaveLength(1);
    const obligationId = opened[0]!.beneficiary_credit_id;
    // 另一个 app 自己的单（同平台、同账单月）：一张候选、一张已入账且有未完成义务。
    const theirs = await g.candidate();
    const theirsPaid = await g.candidate({ people: FROZEN_DIRECT });
    const theirOld = await g.oldBatch([theirsPaid]);
    await g.execute([theirOld.batchId]);
    expect(await g.openObligations(theirsPaid)).toHaveLength(1);
    const untouched = await g.state();
    const traced = tracing(p.db);

    const result = await f.launch(traced.db);

    const q = traced.queries;
    function lockAt(o: SeededOrder): number {
      return q.findIndex((s) => ORDER_LOCK.test(s.sql) && s.parameters.includes(lockKey(o)));
    }
    const firstWrite = q.findIndex((s) => BATCH_WRITE.test(s.sql));
    expect(lockAt(earlier)).toBeGreaterThanOrEqual(0);
    expect(lockAt(later)).toBeGreaterThan(lockAt(earlier));
    expect(firstWrite).toBeGreaterThan(lockAt(later));
    for (const o of [earlier, later]) {
      expect(q[lockAt(o)]!.parameters).toEqual([lockKey(o)]);
      const reread = q.findIndex((s, i) => i > lockAt(o) && ORDERS_READ.test(s.sql));
      expect(reread).toBeGreaterThan(lockAt(o));
      expect(reread).toBeLessThan(firstWrite);
    }
    // 另一个 app 的单不取锁。
    const lockedKeys = q.filter((s) => ORDER_LOCK.test(s.sql)).flatMap((s) => s.parameters);
    for (const o of [theirs, theirsPaid]) expect(lockedKeys).not.toContain(lockKey(o));

    const items = await f.itemsIn(result.batchIds);
    expect(items.filter((i) => i.item_type === 'order')).toHaveLength(2);
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
    // 来源读到就已入账的单：同一批照常出它的受益人补记项（引用未完成义务），没有首次入账明细。
    expect(items).toHaveLength(3);
    expect(items).toContainEqual(
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: paid.orderId,
        user_id: paid.user('direct'),
        role: 'direct',
        beneficiary_credit_id: obligationId,
        settle_seq: 2,
        b_settle_fen: null,
      }),
    );
    const seen = await f.validations();
    expect(seen).toHaveLength(3);
    for (const o of [earlier, later]) {
      expect(seen).toContainEqual(
        expect.objectContaining({ orderKey: o.orderKey, result: 'candidate', settleSeq: 2 }),
      );
    }
    expect(seen).toContainEqual(
      expect.objectContaining({
        orderKey: paid.orderKey,
        result: 'already_credited',
        settleSeq: 2,
      }),
    );

    // 另一个 app：来源只按本 app 读，其订单状态、批次、明细、补记义务、凭证前后不变。
    for (const [, selection] of f.readSource.mock.calls) {
      expect(selection).toMatchObject({ appId: f.appId, platform: PLATFORM });
    }
    expect(await g.state()).toEqual(untouched);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04rd#6] 同一把锁：另一连接先用 lockOrderKey 持有 O 的订单键锁不提交——补充停在等锁（pg_locks 有未授予的咨询锁）、不产生任何批次；持锁方在锁内经 R11 给 O 加 hold 后提交释放，补充随即完成且按释放后的订单状态：O 暂缓、不入批',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate();
    const locked = deferred();
    const release = deferred();
    const holder = p.control.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      locked.resolve();
      await release.promise;
      // 补充等锁期间，持锁方在同一把锁内给 O 加 hold，随后提交释放锁。
      await f.holdIn(trx, o);
    });
    await Promise.race([locked.promise, holder]);

    const launch = track(f.launch());
    let blocked = false;
    let batchesWhileWaiting: unknown[] = [];
    try {
      blocked = await advisoryWaiter(p.left, launch);
      batchesWhileWaiting = await f.supplementBatches();
    } finally {
      release.resolve();
      await holder;
    }
    expect(blocked).toBe(true);
    expect(batchesWhileWaiting).toEqual([]);

    expect(await launch.outcome).toEqual({ ok: true, value: generated([]) });
    expect(await f.h.read(o)).toMatchObject({ rebate_status: 'WAITING', hold: true });
    expect(await f.allItems()).toEqual([]);
    expect(await f.supplementBatches()).toEqual([]);
    expect(await f.validations()).toEqual([
      expect.objectContaining({ orderKey: o.orderKey, result: 'deferred' }),
    ]);
    expect(await f.jobs()).toEqual([
      expect.objectContaining({ status: 'done', processed_count: 1, skipped_count: 1 }),
    ]);
  },
  TIMEOUT,
);
