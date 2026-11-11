// B1-18g rule tests (claude-independent, SPEC_REF 7c4694f): 08 BR-FUND-09 细则「正差批准的默认」⑤
// (2026-11-11 D10-1258, replacing D10-780) and the BR-CALC-23 细则 pointer, approval and rejection side.
// 「批准时不比较版本号：commission_version 与候选生成时不同，不构成作废理由；其余照旧——照 ① 与正文 ② 逐单重算，
// seq 已变的作废，重算差额为 0 的照 ③ 记为已批准、不写凭证」; 「版本变了而差额没变时 … 待审候选不动，已驳回的不重新
// 生成」; BR-CALC-23「驳回则不记账并保留候选与驳回理由」.
// The version bump is the shared kit's bumpCommissionVersion: commission's snapshot copied under the
// new version, so every party's difference is unchanged (BR-CALC-27「仅补贴变化的版本」).
// Example order: reserve 0, self 5000 / direct 1000; credited 1234 (617 / 123 / 494) → settlement 1300
// (650 / 130 / 520): candidates self +33, direct +7, platform +26.
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  EXAMPLE,
  TIMEOUT,
  answer,
  approveHarness,
  approveSuite,
  expectApproved,
  ordered,
  platformIncrease,
  recordText,
  result,
  userIncrease,
  withAdmin,
} from '../settle-adjust-approve/kit.ts';

const s = approveSuite();

const REASON = '联盟结算明细口径待核对';

it(
  '[AC-B1-18g#6] 候选生成后订单换了佣金版本（v1 → v2）而各方差额不变：再跑生成不动候选（仍 v1、pending、原批次）；批准照常重算并记账——self +33、直推 +7、平台 +26，booked=1300/1300，候选已批准（批准人、时间，候选上的版本仍为 1），answer approved / credited_fen 40',
  async () => {
    const h = await approveHarness(s);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    const generated = await h.rowsOf(o);
    expect(ordered(generated).map((r) => [r.role, r.diff_fen, r.commission_version])).toEqual([
      ['self', 33n, 1],
      ['direct', 7n, 1],
      [null, 26n, 1],
    ]);
    h.clock.advanceMs(60_000);
    await h.bumpCommissionVersion(o, 2);
    expect(await h.read(o)).toMatchObject({ commission_version: 2 });

    // The generator's next run leaves the pending candidates alone.
    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    expect(await h.rowsOf(o)).toEqual(generated);
    expect(await h.batches()).toHaveLength(1);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 40)]);

      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 33n, seq),
        ...userIncrease(o, 'direct', 7n, seq),
        ...platformIncrease(o, 26n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(650n);
      expect(await h.balance(o.user('direct'))).toBe(130n);
      expect(await h.receivableOf(o)).toBe(1300n);
      expect(await h.read(o)).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 1300n,
        booked_n_fen: 1300n,
      });
      const rows = await h.rowsOf(o);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.status, r.id).toBe('approved');
        expect(r.approver, r.id).toBe(a.adjuster.id);
        expect(r.decided_at, r.id).toEqual(h.clock.now());
        expect(r.commission_version, r.id).toBe(1);
      }
      expect(await h.batch(batchId)).toMatchObject({
        confirmed_by: a.adjuster.id,
        confirmed_at: h.clock.now(),
      });
      const records = await h.audits(APPROVE_ACTION);
      expect(records).toHaveLength(1);
      const recorded = recordText(records[0]!);
      expect(recorded).toContain(o.orderId);
      expect(recorded).toContain('approved');
      expect(recorded).not.toContain('voided_stale_seq');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18g#7] 一个批次三单都在生成后换了佣金版本（差额不变）：A 只换版本 → approved / 40 并记账；B 又来新结算记录（seq 变）→ 仍 voided_stale_seq、什么都不写；C 当前结算额回到已入账值 1234（seq 未变）→ approved_zero、候选记已批准、不写凭证；批次确认',
  async () => {
    const h = await approveHarness(s);
    const a1 = await h.raised(EXAMPLE, 1300n);
    const b = await h.raised(EXAMPLE, 1300n);
    const c = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    for (const x of [a1, b, c]) await h.bumpCommissionVersion(x.o, 2);
    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });
    for (const x of [a1, b, c]) {
      expect((await h.rowsOf(x.o)).map((r) => [r.status, r.batch_id])).toEqual([
        ['pending', batchId],
        ['pending', batchId],
        ['pending', batchId],
      ]);
    }
    expect(await h.settle(b.o, 1350n)).toBe(b.seq + 1);
    await h.db
      .updateTable('orders')
      .set({ settle_commission_fen: 1234n })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', c.o.orderId)
      .execute();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const bBefore = await h.moneyOf(b.o);
      const cBefore = await h.moneyOf(c.o);
      await expectApproved(await a.approve(batchId), batchId, [
        result(a1.o, 'approved', 40),
        result(b.o, 'voided_stale_seq', 0),
        result(c.o, 'approved_zero', 0),
      ]);

      await h.expectAdjust(a1.o, a1.seq, [
        ...userIncrease(a1.o, 'self', 33n, a1.seq),
        ...userIncrease(a1.o, 'direct', 7n, a1.seq),
        ...platformIncrease(a1.o, 26n, a1.seq),
      ]);
      expect(await h.read(a1.o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
      for (const r of await h.rowsOf(a1.o)) expect(r.status, r.id).toBe('approved');

      // B: the seq moved on: voided, nothing written.
      expect(await h.moneyOf(b.o)).toEqual(bBefore);
      expect(await h.adjLinesOf(b.o)).toEqual([]);
      for (const r of await h.rowsOf(b.o)) {
        expect(r.status, r.id).toBe('voided_stale_seq');
        expect(r.approver, r.id).toBeNull();
        expect(r.decided_at, r.id).toEqual(h.clock.now());
      }

      // C: recomputed difference 0: approved, no voucher.
      expect(await h.moneyOf(c.o)).toEqual(cBefore);
      expect(await h.adjLinesOf(c.o)).toEqual([]);
      for (const r of await h.rowsOf(c.o)) {
        expect(r.status, r.id).toBe('approved');
        expect(r.approver, r.id).toBe(a.adjuster.id);
        expect(r.decided_at, r.id).toEqual(h.clock.now());
      }

      expect(await h.batch(batchId)).toMatchObject({
        confirmed_by: a.adjuster.id,
        confirmed_at: h.clock.now(),
      });
      const recorded = recordText((await h.audits(APPROVE_ACTION))[0]!);
      for (const x of [a1, b, c]) expect(recorded).toContain(x.o.orderId);
      expect(recorded).toContain('approved_zero');
      expect(recorded).toContain('voided_stale_seq');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-18g#8] 批次被驳回后订单换了佣金版本（差额不变）再跑生成：不重新生成候选、不建批次；驳回的候选与驳回理由原样保留，不记账（BR-CALC-23「驳回则不记账并保留候选与驳回理由」）',
  async () => {
    const h = await approveHarness(s);
    const { o } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await answer(await a.reject(batchId, { reason: REASON }), 0, {
        batch_id: batchId,
        rejected_count: 3,
      });
    });
    const rejected = await h.rowsOf(o);
    expect(rejected.map((r) => [r.status, r.reason])).toEqual([
      ['rejected', REASON],
      ['rejected', REASON],
      ['rejected', REASON],
    ]);
    const money = await h.moneyOf(o);
    h.clock.advanceMs(60_000);
    await h.bumpCommissionVersion(o, 2);

    expect(await h.run()).toEqual({ batchId: null, orders: 0, candidates: 0, superseded: 0 });

    expect(await h.rowsOf(o)).toEqual(rejected);
    expect(await h.batches()).toHaveLength(1);
    expect(await h.moneyOf(o)).toEqual(money);
    expect(await h.adjLinesOf(o)).toEqual([]);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 1234n, booked_n_fen: 1234n });
  },
  TIMEOUT,
);
