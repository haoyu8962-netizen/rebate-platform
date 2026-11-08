// B2-09zc rule tests (claude-independent, SPEC_REF b79958d): rejection of a positive-difference batch
// (contracts/openapi.yaml adminRejectSettleAdjustBatch, CT-24zv; 08 BR-FUND-09 ②「正差批次未批准前余额不变」;
// D10-770 ① 按批次批准或拒绝、批准人、时间与批次结果写审计): every pending candidate of the batch becomes
// rejected with the `reason`, `approver` the caller and `decided_at` the clock; the batch gets
// confirmed_by / confirmed_at; no voucher, no balance, no booked pair change; one audit record
// settle_adjust_batch_reject (batch_id, the number of candidates rejected, the reason), derived by the
// audit view as target_type settle_adjust_batch under fund.settle_adjust. Candidates already voided
// stay as they are and are not counted.
// Example order: 1234 (617 / 123 / 494, reserve 0) → 1300: three candidates (+33 / +7 / +26).
import { expect, it } from 'vitest';
import {
  REJECT_ACTION,
  EXAMPLE,
  TIMEOUT,
  answer,
  approveHarness,
  approveSuite,
  expectDerived,
  mentionsAmount,
  recordText,
  withAdmin,
} from './kit.ts';

const s = approveSuite();

const REASON = '联盟结算明细口径待核对';

it(
  '[AC-B2-09zc#5] 拒绝两单的批次：6 条待批候选全部 rejected（reason、批准人、时间），rejected_count 6，批次确认；不写凭证、余额与 booked 不变；一条审计（batch_id、条数、原因），审计视图派生 settle_adjust_batch / fund.settle_adjust',
  async () => {
    const h = await approveHarness(s);
    const x = await h.raised(EXAMPLE, 1300n);
    const y = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const before = await h.state();
      await answer(await a.reject(batchId, { reason: REASON }), 0, {
        batch_id: batchId,
        rejected_count: 6,
      });
      // Orders, vouchers, lines, balances, obligations, events: exactly as before.
      expect(await h.state()).toEqual(before);
      for (const o of [x.o, y.o]) {
        const rows = await h.rowsOf(o);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
          expect(r.status, r.id).toBe('rejected');
          expect(r.reason, r.id).toBe(REASON);
          expect(r.approver, r.id).toBe(a.adjuster.id);
          expect(r.decided_at, r.id).toEqual(h.clock.now());
        }
        expect(await h.adjLinesOf(o)).toEqual([]);
        expect(await h.read(o)).toMatchObject({ booked_base_fen: 1234n, booked_n_fen: 1234n });
      }
      expect(await h.balance(x.o.user('self'))).toBe(617n);
      expect(await h.batch(batchId)).toMatchObject({
        confirmed_by: a.adjuster.id,
        confirmed_at: h.clock.now(),
      });

      const records = await h.audits(REJECT_ACTION);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.admin_id).toBe(a.adjuster.id);
      expect(record.at).toEqual(h.clock.now());
      const recorded = recordText(record);
      expect(recorded).toContain(batchId);
      expect(recorded).toContain(REASON);
      expect(mentionsAmount(recorded, 6)).toBe(true);
      expectDerived(record, batchId);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#5] 批次里一单已被扣回作废：只拒绝另一单的 3 条待批候选（rejected_count 3），作废的 3 条原样，批次确认',
  async () => {
    const h = await approveHarness(s);
    const clawed = await h.raised(EXAMPLE, 1300n);
    const live = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    expect(
      await h.apply(clawed.o, { cause: 'PLATFORM_INVALID', ref: { kind: 'platform' } }),
    ).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    const voided = await h.rowsOf(clawed.o);
    expect(voided.map((r) => r.status)).toEqual([
      'voided_by_clawback',
      'voided_by_clawback',
      'voided_by_clawback',
    ]);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await answer(await a.reject(batchId, { reason: REASON }), 0, {
        batch_id: batchId,
        rejected_count: 3,
      });
      expect(await h.rowsOf(clawed.o)).toEqual(voided);
      expect((await h.rowsOf(live.o)).map((r) => r.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
      ]);
      expect((await h.batch(batchId)).confirmed_by).toBe(a.adjuster.id);
      expect(mentionsAmount(recordText((await h.audits(REJECT_ACTION))[0]!), 3)).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#5] 被拒绝的候选不再生成：同一 seq 再跑生成器不出新候选（已决定的同版本同 seq 跳过），余额不变',
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
    h.clock.advanceMs(60_000);
    expect(await h.run()).toMatchObject({ batchId: null, candidates: 0 });
    expect((await h.rowsOf(o)).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(await h.balance(o.user('self'))).toBe(617n);
  },
  TIMEOUT,
);
