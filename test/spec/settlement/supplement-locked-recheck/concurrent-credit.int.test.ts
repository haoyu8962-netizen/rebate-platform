// B2-04rd rule tests (claude-independent, SPEC_REF 693f6a6): BR-FUND-04 ⑧ 补充批次 while the old
// batch credits the order (④ 候选、⑦ 锁内重验、⑫ 受益人补记项；编排 D10-2679, 任务书 9.2 ① ② ⑧).
// 「并发动作」: after the launch has read its source and before it handles the order, the old
// CONFIRMED batch really runs on another connection (SettlementModule.forWorker: executor + R5) and
// commits. Amounts (自拟) in ./kit.ts: B_settle 850 = snapshot v2 base; R5 books self 425,
// indirect 42 and PLATFORM:CREDIT 448 (two entry lines each); a frozen direct's 85 is held.
// All three cases are red on the current code: it classifies O by the source row read before the
// old batch committed (WAITING → candidate) and writes a first-credit order item for it.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  FROZEN_DIRECT,
  ITEM_WRITE,
  NEXT_LAUNCH,
  TIMEOUT,
  creditHistoryCounts,
  creditKey,
  databaseFixture,
  failAfter,
  fixture,
  generated,
  platformKey,
  userCreditLines,
  type CompiledQuery,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04rd#1] 负责人点名：补充读完来源后旧批次真实执行把 O 入账（冻结的直推开立首次入账义务）——同一轮补充只出 O 的受益人补记项、没有首次入账明细，逐单结果为已入账；确认执行时补记暂缓、不重复入账，解冻后下一轮补记 85 恰入账一次，重放不再入账',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate({ people: FROZEN_DIRECT });
    const old = await f.oldBatch([o]);
    f.afterSourceRead(() => f.execute([old.batchId]));

    const result = await f.launch();

    // 并发动作已提交：O 由旧批次真实入账（R5），冻结的直推开了首次入账义务，旧明细已有结果。
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

    // 同一轮补充：只有 O 的受益人补记项（引用该义务），没有 O 的首次入账（order）明细。
    expect(await f.allItems()).toHaveLength(2);
    expect(await f.itemsIn(result.batchIds)).toEqual([
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
    const batches = await f.supplementBatches();
    expect(result).toEqual(generated(batches.map((b) => b.batch_id)));
    expect(batches).toEqual([
      expect.objectContaining({ kind: 'supplement', status: 'DRAFT', order_count: 0 }),
    ]);
    // 逐单结果：锁后重读的已入账类别，不是候选。
    expect(await f.validations()).toEqual([
      expect.objectContaining({
        orderKey: o.orderKey,
        orderId: o.orderId,
        result: 'already_credited',
        settleSeq: o.seq,
      }),
    ]);
    expect(await f.diffs()).toEqual([]);
    expect(f.registerDiff).not.toHaveBeenCalled();

    // R5 留下的凭证：本人、间推、平台各一张（各两行分录），直推暂缓不写凭证。
    const booked = await f.orderLedger(o);
    expect(booked).toEqual({
      vouchers: [creditKey(o, 'self'), creditKey(o, 'indirect'), platformKey(o)].sort(),
      lines: 6,
    });

    // 仍冻结时确认并真实执行这批补充：补记项暂缓，义务仍未完成，不重复入账。
    const firstRound = await f.settleDrafts();
    expect(firstRound).toEqual(result.batchIds);
    expect(await f.itemsIn(firstRound)).toEqual([
      expect.objectContaining({ beneficiary_credit_id: obligationId, result: 'deferred' }),
    ]);
    expect(await f.orderLedger(o)).toEqual(booked);
    expect(await creditHistoryCounts(f, o)).toEqual({ firstCredit: 1, selfStep: 0 });
    expect(await f.h.balance(o.user('direct'))).toBe(0n);
    expect(await f.openObligations(o)).toEqual([
      expect.objectContaining({ beneficiary_credit_id: obligationId, status: 'open' }),
    ]);

    // 解冻后下一轮补充：同一义务再出补记项，确认执行后补记 85 恰入账一次。
    await f.h.setRisk(f.h.db, o.user('direct'), 'normal');
    f.h.clock.set(NEXT_LAUNCH);
    const next = await f.launch();
    expect(next.batchIds).toHaveLength(1);
    expect(await f.itemsIn(next.batchIds)).toEqual([
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: o.orderId,
        beneficiary_credit_id: obligationId,
        settle_seq: o.seq,
        result: null,
      }),
    ]);
    expect(await f.settleDrafts()).toEqual(next.batchIds);
    expect(await f.itemsIn(next.batchIds)).toEqual([
      expect.objectContaining({
        beneficiary_credit_id: obligationId,
        result: 'credited',
        amount_fen: 85n,
      }),
    ]);
    const credited = await f.orderLedger(o);
    expect(credited).toEqual({
      vouchers: [...booked.vouchers, creditKey(o, 'direct')].sort(),
      lines: 8,
    });
    const directLines = await f.h.voucherLines(creditKey(o, 'direct'));
    expect(directLines).toEqual(userCreditLines(o, 'direct', 85n));
    expect(await f.h.balance(o.user('direct'))).toBe(85n);
    expect(await f.obligationsOf(o)).toEqual([
      expect.objectContaining({
        beneficiary_credit_id: obligationId,
        status: 'done',
        closed_by: 'R5a',
      }),
    ]);
    expect(await creditHistoryCounts(f, o)).toEqual({ firstCredit: 1, selfStep: 1 });

    // 重放全部批次（旧批次与两轮补充）：不再入账。
    await f.execute([old.batchId, ...firstRound, ...next.batchIds]);
    expect(await f.orderLedger(o)).toEqual(credited);
    expect(await f.h.balance(o.user('self'))).toBe(425n);
    expect(await f.h.balance(o.user('direct'))).toBe(85n);
    expect(await f.h.balance(o.user('indirect'))).toBe(42n);
    expect(await creditHistoryCounts(f, o)).toEqual({ firstCredit: 1, selfStep: 1 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04rd#2] 已入账但无补记义务：同 #1 而 O 没有被冻结的受益人——本轮补充不为 O 生成任何明细（无首次入账草稿、无补记项），逐单结果为已入账，没有可入批的单则不产生批次',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate();
    const old = await f.oldBatch([o]);
    f.afterSourceRead(() => f.execute([old.batchId]));

    const result = await f.launch();

    // 并发动作已提交：O 全额入账（本人 425、直推 85、间推 42、平台 448），没有未完成义务。
    expect((await f.h.read(o)).rebate_status).toBe('CREDITED');
    expect(await f.obligationsOf(o)).toEqual([]);
    expect(await f.itemOf(old, o)).toMatchObject({ result: 'credited' });

    expect(await f.allItems()).toEqual([expect.objectContaining({ batch_id: old.batchId })]);
    expect(result).toEqual(generated([]));
    expect(await f.supplementBatches()).toEqual([]);
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
    expect(await f.orderLedger(o)).toEqual({
      vouchers: [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
      lines: 8,
    });
    expect(await f.creditedHistory(o)).toBe(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04rd#9] 回滚与重发：#1 的补充在写明细那一步库层失败时整笔回滚（无批次、明细、逐单结果残留），失败那次要写的明细正是 O 的受益人补记项；同一请求重发后结果同 #1（一条补记项、无首次入账草稿），再重发判为重放',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate({ people: FROZEN_DIRECT });
    const old = await f.oldBatch([o]);
    f.afterSourceRead(() => f.execute([old.batchId]));
    const attempted: CompiledQuery[] = [];
    const fault = failAfter(p.db, (query) => {
      const hit = ITEM_WRITE.test(query.sql);
      if (hit) attempted.push(query);
      return hit;
    });

    await expect(f.launch(fault.db)).rejects.toThrow('injected failure after the statement ran');

    expect(fault.injected()).toBe(1);
    expect((await f.h.read(o)).rebate_status).toBe('CREDITED');
    const opened = await f.openObligations(o);
    expect(opened).toHaveLength(1);
    const obligationId = opened[0]!.beneficiary_credit_id;
    // 失败的那次写入：一条受益人补记项（引用该义务），没有首次入账明细。
    expect(attempted).toHaveLength(1);
    expect(attempted[0]!.parameters).toContain('beneficiary');
    expect(attempted[0]!.parameters).toContain(obligationId);
    expect(attempted[0]!.parameters).not.toContain('order');
    // 整笔回滚：没有补充批次、补充明细与逐单结果。
    expect(await f.supplementBatches()).toEqual([]);
    expect(await f.allItems()).toEqual([expect.objectContaining({ batch_id: old.batchId })]);
    expect(await f.validations()).toEqual([]);

    // 同一请求（同一名义时刻）重发。
    const again = await f.launch();
    const batches = await f.supplementBatches();
    expect(again).toEqual(generated(batches.map((b) => b.batch_id)));
    expect(await f.itemsIn(again.batchIds)).toEqual([
      expect.objectContaining({
        item_type: 'beneficiary',
        order_id: o.orderId,
        user_id: o.user('direct'),
        role: 'direct',
        beneficiary_credit_id: obligationId,
        settle_seq: o.seq,
        b_settle_fen: null,
      }),
    ]);
    expect(await f.validations()).toEqual([
      expect.objectContaining({ orderKey: o.orderKey, result: 'already_credited' }),
    ]);
    expect(await f.jobs()).toEqual([
      expect.objectContaining({ status: 'done', processed_count: 1, skipped_count: 0 }),
    ]);

    // 再重发：settle_jobs 键判重放，不再生成批次。
    const before = await f.state();
    expect(await f.launch()).toEqual({ ...generated([]), outcome: 'duplicate' });
    expect(await f.state()).toEqual(before);
  },
  TIMEOUT,
);
