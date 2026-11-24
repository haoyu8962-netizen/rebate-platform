// B2-04rd rule tests (claude-independent, SPEC_REF 693f6a6): BR-FUND-04 ④⑧ — a candidate's class
// is decided on the order and the settlement records re-read under its order lock (任务书 9.2 ③ ④).
// 「并发动作」: after the launch has read its source and before it handles the order, another
// connection commits a production write (R11 hold through rebate.adminHold behind lockOrderKey; a
// later order_settlements record obtained within the cut-off, the Clock minus one minute).
// Amounts (自拟) in ./kit.ts: B_settle 850 = snapshot v2 base; R5 self 425 / direct 85 /
// indirect 42 / PLATFORM:CREDIT 448. #3 and #4 are red on the current code (it keeps the source
// row: O batched despite the hold; settle_seq 1 instead of 2). The no-concurrency regression nail
// (9.2 ⑥) is merged into [AC-B2-04rd#5] in ./lock-order.int.test.ts (任务书 §10.1).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, creditKey, databaseFixture, fixture, generated, platformKey } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04rd#3] 锁后重读到人工 hold：补充读完来源后另一连接经 R11（lockOrderKey、重读、rebate.adminHold）给 O 加 hold 并提交——O 不入批、计入暂缓（settle_jobs.skipped_count 1），逐单结果 deferred，同来源直接读到 hold；不登记差错单',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate();
    f.afterSourceRead(() => f.hold(p.right, o));

    const result = await f.launch();

    expect(await f.h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      hold: true,
      hold_reason: 'RISK',
    });
    expect(await f.allItems()).toEqual([]);
    expect(result).toEqual(generated([]));
    expect(await f.supplementBatches()).toEqual([]);
    expect(await f.validations()).toEqual([
      expect.objectContaining({ orderKey: o.orderKey, orderId: o.orderId, result: 'deferred' }),
    ]);
    expect(await f.jobs()).toEqual([
      expect.objectContaining({ status: 'done', processed_count: 1, skipped_count: 1 }),
    ]);
    expect(await f.diffs()).toEqual([]);
    expect(f.registerDiff).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04rd#4] 锁后重读到截点内新的结算记录（金额仍相符）：来源只读到 seq 1，补充处理前另一连接写入 seq 2（取得时间 = Clock − 1 分钟，结算佣金同为 1000）——O 仍入批，明细 settle_seq 取重读后的整单最大 seq 2、b_settle 850 不变；确认并真实执行后 O 入账（不被 settlement_changed 跳过）',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate({ seqs: [1] });
    expect(o.seq).toBe(1);
    f.afterSourceRead(() => f.laterSettlement(p.right, o, 2, 1000n));

    const result = await f.launch();

    expect(await f.itemsIn(result.batchIds)).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: o.orderId,
        settle_seq: 2,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);
    const batches = await f.supplementBatches();
    expect(result).toEqual(generated(batches.map((b) => b.batch_id)));
    expect(await f.validations()).toEqual([
      expect.objectContaining({ orderKey: o.orderKey, result: 'candidate', settleSeq: 2 }),
    ]);
    expect(await f.diffs()).toEqual([]);

    // 确认并真实执行：R5 锁内重验 seq 一致（2），照常入账。
    expect(await f.settleDrafts()).toEqual(result.batchIds);
    expect(await f.itemsIn(result.batchIds)).toEqual([
      expect.objectContaining({ order_id: o.orderId, result: 'credited', skip_reason: null }),
    ]);
    expect((await f.h.read(o)).rebate_status).toBe('CREDITED');
    expect(await f.creditedHistory(o)).toBe(1);
    expect(await f.orderLedger(o)).toEqual({
      vouchers: [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
      lines: 8,
    });
    expect(await f.h.balance(o.user('self'))).toBe(425n);
    expect(await f.h.balance(o.user('direct'))).toBe(85n);
    expect(await f.h.balance(o.user('indirect'))).toBe(42n);
  },
  TIMEOUT,
);
