// B2-12c one transaction, audit side (claude-independent; spec-test r1 S1 on rollback.int.test.ts
// #27/#28): adminCreateAdjustment — the form, its ADMIN_ADJUST voucher, the balance, the audit record
// (adjustment_create / adjustment_reverse) and, on a decrease, the in-app message (BR-FUND-24 ⑦,
// BR-TEXT-19) commit together. A failure of the audit insert or of the message insert → 50001 and
// audit_logs is exactly as it was before the request (no success record, no stray record of any
// action); after the same key succeeds there is exactly one new audit record, of the caller, whose
// content is the final adjustment (adjust_id, user_id, direction, amount, reason code, available
// before and after and, for a reversal, the original). The fault is the one-shot of kit.ts.
// Amounts by hand: new decrease — 3000 −400 → 2600 (audit fault), 2600 −400 → 2200 (message fault);
// reversal of +300 — 1000 (+300 seeded → 1300) −300 → 1000, again (+300 → 1300) −300 → 1000.
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  REVERSE_ACTION,
  answer,
  audits,
  expectAdjusted,
  expectMentions,
  fixture,
  member,
  moneyOf,
  newForm,
  newKey,
  seedForm,
  seedReconDiff,
  suite,
  trace,
  withAdjustAdmin,
  type AdjustFixture,
  type AuditRow,
  type FaultPoint,
  type Ref,
} from './kit.ts';

const s = suite();

const POINTS: readonly FaultPoint[] = ['audit', 'inbox'];

/** The records of the app not in `before` (by id). */
async function auditsSince(f: AdjustFixture, before: readonly AuditRow[]): Promise<AuditRow[]> {
  const known = new Set(before.map((row) => String(row.id)));
  return (await audits(f)).filter((row) => !known.has(String(row.id)));
}

it('[AC-B2-12c#42] 调减提交时写审计或写站内信失败 → 50001，audit_logs 与失败前逐行相同（没有成功审计也没有别的记录）；同一 key 重发成功后恰好多一条 adjustment_create，操作人是提交人，内容即最终调账（单号、会员、方向、金额、原因码、前后余额）', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    for (const point of POINTS) {
      const note = `多记的结算冲减（审计核对 ${point}）`;
      const body = newForm({
        userId,
        direction: 'decrease',
        amount: 400n,
        reason: 'RECON_FIX',
        refs: [diff],
        note,
        contra: 'COMMISSION_REVENUE',
      });
      const before = await trace(f);
      const auditsBefore = await audits(f);
      const money = await moneyOf(f, userId);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.create(body, { key });
      expect(h.fault.tripped, `${point} 必须在提交事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await trace(f), point).toEqual(before);
      expect(await audits(f), `${point}：失败后 audit_logs 不变`).toEqual(auditsBefore);

      const done = await expectAdjusted(f, await h.create(body, { key }), {
        caller: h.maker,
        userId,
        direction: 'decrease',
        amount: 400n,
        reason: 'RECON_FIX',
        contra: 'COMMISSION_REVENUE',
        refs: [diff],
        note,
        before: money,
      });
      const added = await auditsSince(f, auditsBefore);
      expect(
        added.map((row) => [row.action, row.admin_id]),
        `${point}：重发成功后恰好一条成功审计`,
      ).toEqual([[CREATE_ACTION, h.maker.id]]);
      expectMentions(added[0]!, {
        ids: [done.row.adjust_id, userId],
        values: ['decrease', 400n, 'RECON_FIX', money.available, done.after],
      });
    }
  });
});

it('[AC-B2-12c#43] 红冲调增单（即调减）时写审计或写站内信失败 → 50001，audit_logs 与失败前逐行相同；同一 key 重发成功后恰好多一条 adjustment_reverse，操作人是提交人，内容即最终红冲（红冲单号、原单号、会员、方向、金额、原因码、前后余额）', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n });
    for (const point of POINTS) {
      const original = await seedForm(f, { userId, direction: 'increase', amount: 300n });
      const body = {
        reverses_adjust_id: original.adjust_id,
        note: `整笔冲回（审计核对 ${point}）`,
      };
      const before = await trace(f);
      const auditsBefore = await audits(f);
      const money = await moneyOf(f, userId);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.create(body, { key });
      expect(h.fault.tripped, `${point} 必须在红冲事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await trace(f), point).toEqual(before);
      expect(await audits(f), `${point}：失败后 audit_logs 不变`).toEqual(auditsBefore);

      const done = await expectAdjusted(f, await h.create(body, { key }), {
        caller: h.maker,
        userId,
        direction: 'decrease',
        amount: 300n,
        reason: original.reason_code,
        contra: original.contra_subject,
        refs: [],
        note: body.note,
        reverses: original,
        before: money,
      });
      const added = await auditsSince(f, auditsBefore);
      expect(
        added.map((row) => [row.action, row.admin_id]),
        `${point}：重发成功后恰好一条成功审计`,
      ).toEqual([[REVERSE_ACTION, h.maker.id]]);
      expectMentions(added[0]!, {
        ids: [done.row.adjust_id, original.adjust_id, userId],
        values: ['decrease', 300n, original.reason_code, money.available, done.after],
      });
    }
  });
});
