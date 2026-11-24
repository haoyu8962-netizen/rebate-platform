// B2-04rd rule tests, 3rd round (claude-independent, SPEC_REF 693f6a6; 任务书 §11.2, 评审 r1 第 3–5 条):
// BR-FUND-04 ④⑧⑫ — what the launch reads again under the order lock decides the class: the cut-off
// still holds on the re-read records (#10), a rights case opened (#11) or a punishment that voided
// the order (#12) after the source read are taken as such, and every open obligation the old batch
// opened on the order becomes its own make-up item (#13).
// 「并发动作」: after the launch has read its source and before it handles the order, another
// connection commits a production write — order-sync's later order_settlements rows (as
// laterSettlement builds them, at the given obtained time); settlement's rights command (orders'
// rights.record behind lockOrderKey and a FOR UPDATE re-read) for a PROCESSING rights case and for a
// successful PUNISH (R6 through the real rebate port); the old CONFIRMED batch through
// SettlementModule.forWorker (executor + R5).
// Amounts (自拟) in ./kit.ts: N = 1000 fen (seq 1 STATEMENT decides the amount; later API rows of the
// same 1000 do not change it), B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base.
// Shares of 850: self 425, direct 85, indirect floor(42.5) = 42.
// All four are red on the current code: it keeps the source rows read before the concurrent commit
// (O WAITING, no rights case, only seq 1), so O becomes a candidate with a first-credit order item.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  FROZEN_REFERRERS,
  LAUNCH,
  MONTH,
  TIMEOUT,
  databaseFixture,
  fixture,
  generated,
  openRights,
  punish,
  settlementAt,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04rd#10] 锁后重读仍守截点（含等号）：来源只读到 seq 1，补充处理前另一连接写入同为 1000 的 seq 2（Clock − 1 分钟）、seq 3（恰等于截点）与 seq 4（截点后 1 毫秒）——O 仍入批，明细与逐单结果的 settle_seq 取截点内整单最大 seq 3，不取截点外的 4；b_settle 850 不变',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate({ seqs: [1] });
    expect(o.seq).toBe(1);
    // 截点 = 发起时注入的 Clock（LAUNCH）；口径同冻结 [AC-B2-04r#6]：恰等于截点的计入，晚 1 毫秒的不计。
    expect(f.h.clock.now()).toEqual(new Date(LAUNCH));
    f.afterSourceRead(async () => {
      await settlementAt(f, p.right, o, 2, 1000n, new Date('2032-07-26T09:59:00+08:00'));
      await settlementAt(f, p.right, o, 3, 1000n, new Date(LAUNCH));
      await settlementAt(f, p.right, o, 4, 1000n, new Date('2032-07-26T10:00:00.001+08:00'));
    });

    const result = await f.launch();

    expect(await f.itemsIn(result.batchIds)).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: o.orderId,
        settle_seq: 3,
        b_settle_fen: 850n,
        result: null,
      }),
    ]);
    const batches = await f.supplementBatches();
    expect(result).toEqual(generated(batches.map((b) => b.batch_id)));
    expect(await f.validations()).toEqual([
      expect.objectContaining({ orderKey: o.orderKey, result: 'candidate', settleSeq: 3 }),
    ]);
    expect(await f.diffs()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04rd#11] 锁后重读到维权：补充读完来源后另一连接经 rights.record（RIGHTS、PROCESSING）给 O 开启维权并提交（rights_pending 真、仍 WAITING）——O 不入批、没有首次入账明细，计入暂缓（settle_jobs.skipped_count 1），逐单结果 deferred，同来源直接读到维权中（冻结 [AC-B2-04r#5]）；不登记差错单',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate();
    f.afterSourceRead(() => openRights(f, p.right, o));

    const result = await f.launch();

    expect(await f.h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      rights_pending: true,
      hold: false,
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
  '[AC-B2-04rd#12] 锁后重读到 VOID：补充读完来源后另一连接经 rights.record（PUNISH、SUCCEEDED → R6）把 O 转为 VOID 并提交，结算记录仍在——O 没有首次入账明细、不入批；逐单结果 unexpected_settlement，按目标账单月登记 union_mismatch，同来源直接读到 VOID 且联盟有结算（冻结 [AC-B2-04r#26]）',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate();
    f.afterSourceRead(() => punish(f, p.right, o));

    const result = await f.launch();

    expect(await f.h.read(o)).toMatchObject({ rebate_status: 'VOID', reason: 'PUNISH' });
    expect(await f.allItems()).toEqual([]);
    expect(result).toEqual(generated([]));
    expect(await f.supplementBatches()).toEqual([]);
    expect(await f.validations()).toEqual([
      expect.objectContaining({
        orderKey: o.orderKey,
        orderId: o.orderId,
        result: 'unexpected_settlement',
        settleSeq: o.seq,
      }),
    ]);
    expect(await f.diffs()).toEqual([
      expect.objectContaining({ type: 'union_mismatch', ref_id: o.orderKey, period: MONTH }),
    ]);
    expect(f.registerDiff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: f.appId, type: 'union_mismatch', refId: o.orderKey }),
      expect.objectContaining({ clock: f.h.clock }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04rd#13] 同一单的每个未完成义务各出一项：同 #1 而 O 的直推与间推都被冻结，旧批次真实执行后同一单开立两个不同角色的首次入账义务（85 与 42）——本轮为两个原始 beneficiary_credit_id 各生成一条补记项明细，没有首次入账明细，逐单结果为已入账',
  async () => {
    const f = await fixture(p.db);
    const o = await f.candidate({ people: FROZEN_REFERRERS });
    const old = await f.oldBatch([o]);
    f.afterSourceRead(() => f.execute([old.batchId]));

    const result = await f.launch();

    // 并发动作已提交：O 由旧批次真实入账（R5），直推、间推各开一个首次入账义务。
    expect((await f.h.read(o)).rebate_status).toBe('CREDITED');
    expect(await f.itemOf(old, o)).toMatchObject({ result: 'credited' });
    const opened = await f.openObligations(o);
    expect(opened).toHaveLength(2);
    expect(opened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: o.user('direct'),
          role: 'direct',
          kind: 'first_credit',
          status: 'open',
        }),
        expect.objectContaining({
          user_id: o.user('indirect'),
          role: 'indirect',
          kind: 'first_credit',
          status: 'open',
        }),
      ]),
    );
    expect(new Set(opened.map((ob) => ob.beneficiary_credit_id)).size).toBe(2);

    // 同一轮补充：两个义务各一条补记项（引用各自原始 ID），没有 O 的首次入账明细。
    const items = await f.itemsIn(result.batchIds);
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining(
        opened.map((ob) =>
          expect.objectContaining({
            item_type: 'beneficiary',
            order_id: o.orderId,
            user_id: ob.user_id,
            role: ob.role,
            beneficiary_credit_id: ob.beneficiary_credit_id,
            settle_seq: o.seq,
            b_settle_fen: null,
            result: null,
          }),
        ),
      ),
    );
    expect(await f.allItems()).toHaveLength(3);
    const batches = await f.supplementBatches();
    expect(result).toEqual(generated(batches.map((b) => b.batch_id)));
    expect(batches).toEqual([
      expect.objectContaining({ kind: 'supplement', status: 'DRAFT', order_count: 0 }),
    ]);
    expect(await f.validations()).toEqual([
      expect.objectContaining({
        orderKey: o.orderKey,
        orderId: o.orderId,
        result: 'already_credited',
        settleSeq: o.seq,
      }),
    ]);
    expect(await f.diffs()).toEqual([]);
  },
  TIMEOUT,
);
