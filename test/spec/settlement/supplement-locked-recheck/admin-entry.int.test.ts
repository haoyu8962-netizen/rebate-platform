// B2-04rd rule tests, 3rd round (claude-independent, SPEC_REF 693f6a6; 任务书 §11.2, 评审 r1 第 1 条):
// BR-FUND-04 ⑧⑫ through the entry the console really calls — command.launchInTransaction on the
// caller's transaction, as launchAdminSettleSupplement runs it inside its idempotency transaction.
// 「并发动作」 as in [AC-B2-04rd#1]: after the launch has read its source, the old CONFIRMED batch
// really runs on another connection (SettlementModule.forWorker: executor + R5) and commits.
// Amounts (自拟) in ./kit.ts: B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base; R5
// books self 425, indirect 42 and PLATFORM:CREDIT 850 − 552 + 150 = 448 (two entry lines each); the
// frozen direct's 85 (floor(850 × 1000 / 10000)) is held and opens a first_credit obligation.
// Red on the current code: launchInTransaction runs the same generate() — the order is classified on
// the source row read before the old batch committed (WAITING → candidate), so the rolled-back
// attempt wrote a first-credit order item and no make-up item.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  FROZEN_DIRECT,
  OUTER_FAILURE,
  TIMEOUT,
  creditKey,
  databaseFixture,
  fixture,
  generated,
  launchInTransaction,
  platformKey,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04rd#7] 后台实际入口 launchInTransaction（调用方外层事务）：补充读完来源后旧批次真实执行把 O 入账（冻结的直推开立义务）——该轮只出 O 的受益人补记项、没有首次入账明细；外层事务在补充返回后失败则整笔回滚（无批次、明细、逐单结果、任务键残留），同一请求重发结果同上，确认并真实执行重发的批次：补记暂缓、不重复入账',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate({ people: FROZEN_DIRECT });
    const old = await f.oldBatch([o]);
    f.afterSourceRead(() => f.execute([old.batchId]));

    // 第一次：外层事务里调后台入口，补充返回后在同一事务里看它写了什么，然后外层失败、整笔回滚。
    const inside: { batchIds?: readonly string[]; items?: readonly unknown[] } = {};
    await expect(
      p.db.transaction().execute(async (trx) => {
        const result = await launchInTransaction(f, trx);
        inside.batchIds = result.batchIds;
        inside.items = await trx
          .selectFrom('settle_batch_items')
          .selectAll()
          .where('app_id', '=', f.appId)
          .where('batch_id', '<>', old.batchId)
          .orderBy('id')
          .execute();
        throw new Error(OUTER_FAILURE);
      }),
    ).rejects.toThrow(OUTER_FAILURE);

    // 并发动作已提交（另一连接，不随外层回滚）：O 已入账，冻结的直推开了首次入账义务。
    expect((await f.h.read(o)).rebate_status).toBe('CREDITED');
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
    expect(await f.itemOf(old, o)).toMatchObject({ result: 'credited' });

    // 回滚前那一轮要提交的明细：只有 O 的受益人补记项（引用该义务），没有首次入账明细。
    expect(inside.batchIds).toHaveLength(1);
    expect(inside.items).toEqual([
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: o.orderId,
        user_id: o.user('direct'),
        role: 'direct',
        beneficiary_credit_id: obligationId,
        settle_seq: o.seq,
        b_settle_fen: null,
        amount_fen: null,
        result: null,
      }),
    ]);

    // 整笔回滚：没有补充批次、补充明细、逐单结果，任务键也没留下（不记 failed）。
    expect(await f.supplementBatches()).toEqual([]);
    expect(await f.allItems()).toEqual([expect.objectContaining({ batch_id: old.batchId })]);
    expect(await f.validations()).toEqual([]);
    expect(await f.jobs()).toEqual([]);

    // 同一请求（同一名义时刻）经同一入口重发，外层事务提交。
    const again = await p.db.transaction().execute((trx) => launchInTransaction(f, trx));
    const batches = await f.supplementBatches();
    expect(again).toEqual(generated(batches.map((b) => b.batch_id)));
    expect(batches).toEqual([
      expect.objectContaining({ kind: 'supplement', status: 'DRAFT', order_count: 0 }),
    ]);
    expect(await f.itemsIn(again.batchIds)).toEqual([
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
    expect(await f.diffs()).toEqual([]);

    // R5 留下的凭证：本人、间推、平台各一张（各两行分录），直推暂缓不写凭证。
    const booked = await f.orderLedger(o);
    expect(booked).toEqual({
      vouchers: [creditKey(o, 'self'), creditKey(o, 'indirect'), platformKey(o)].sort(),
      lines: 6,
    });

    // 确认并真实执行重发生成的批次：直推仍冻结，补记项暂缓，义务仍未完成，不重复入账。
    const round = await f.settleDrafts();
    expect(round).toEqual(again.batchIds);
    expect(await f.itemsIn(round)).toEqual([
      expect.objectContaining({ beneficiary_credit_id: obligationId, result: 'deferred' }),
    ]);
    expect(await f.orderLedger(o)).toEqual(booked);
    expect(await f.creditedHistory(o)).toBe(1);
    expect(await f.h.balance(o.user('direct'))).toBe(0n);
    expect(await f.h.balance(o.user('self'))).toBe(425n);
    expect(await f.h.balance(o.user('indirect'))).toBe(42n);
    expect(await f.openObligations(o)).toEqual([
      expect.objectContaining({ beneficiary_credit_id: obligationId, status: 'open' }),
    ]);
  },
  TIMEOUT,
);
