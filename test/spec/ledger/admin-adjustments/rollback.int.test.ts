// B2-12c one transaction (claude-independent): adminCreateAdjustment — the form, its ADMIN_ADJUST
// voucher, the balance, the audit record (adjustment_create / adjustment_reverse) and, on a
// decrease, the member's in-app message (BR-FUND-24 ⑦, BR-TEXT-19 BALANCE_ADJUSTED) commit together:
// a failure of the audit insert or of the message insert → 50001 and nothing stays (no form, no
// voucher, no balance change, no event, no message, no idempotency record); the same key then
// succeeds. The fault is a one-shot in the entry's database handle (kit.ts).
import { expect, it } from 'vitest';
import {
  answer,
  expectAdjusted,
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
  type FaultPoint,
  type Ref,
} from './kit.ts';

const s = suite();

const POINTS: readonly FaultPoint[] = ['audit', 'inbox'];

async function idempotencyRows(f: ReturnType<typeof fixture>, key: string) {
  return f.db
    .selectFrom('idempotency_keys')
    .select(['key', 'status'])
    .where('app_id', '=', f.appId)
    .where('key', '=', key)
    .execute();
}

it('[AC-B2-12c#27] 调减提交时写审计或写站内信失败 → 50001，整笔回滚：没有单、凭证、余额变动、事件、站内信与幂等记录；同一 key 重发即一次生效', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    for (const point of POINTS) {
      const body = newForm({
        userId,
        direction: 'decrease',
        amount: 400n,
        reason: 'RECON_FIX',
        refs: [diff],
        note: `多记的结算冲减（${point}）`,
        contra: 'COMMISSION_REVENUE',
      });
      const before = await trace(f);
      const money = await moneyOf(f, userId);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.create(body, { key });
      expect(h.fault.tripped, `${point} 必须在提交事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await trace(f), point).toEqual(before);
      expect(await idempotencyRows(f, key), point).toEqual([]);

      await expectAdjusted(f, await h.create(body, { key }), {
        caller: h.maker,
        userId,
        direction: 'decrease',
        amount: 400n,
        reason: 'RECON_FIX',
        contra: 'COMMISSION_REVENUE',
        refs: [diff],
        note: `多记的结算冲减（${point}）`,
        before: money,
      });
    }
  });
});

it('[AC-B2-12c#28] 红冲调增单（即调减）时写审计或写站内信失败 → 50001，整笔回滚，原单仍可红冲；同一 key 重发即一次生效', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n });
    for (const point of POINTS) {
      const original = await seedForm(f, { userId, direction: 'increase', amount: 300n });
      const body = { reverses_adjust_id: original.adjust_id, note: `整笔冲回（${point}）` };
      const before = await trace(f);
      const money = await moneyOf(f, userId);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.create(body, { key });
      expect(h.fault.tripped, `${point} 必须在红冲事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await trace(f), point).toEqual(before);
      expect(await idempotencyRows(f, key), point).toEqual([]);

      await expectAdjusted(f, await h.create(body, { key }), {
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
    }
  });
});
