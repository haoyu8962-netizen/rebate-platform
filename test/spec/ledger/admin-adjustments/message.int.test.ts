// B2-12c in-app message (claude-independent): BR-FUND-24 ⑦ (调减另发站内信，含金额与原因类别；不显示内部
// 说明与操作人) and BR-TEXT-19 站内信 BALANCE_ADJUSTED (只在调减时发送；「你的余额调减 {amount}，原因：
// {adjust_reason}。如有疑问，请联系客服。」{amount} 按 BR-TEXT-10 含 ¥；{adjust_reason} 取原因码名称；不写内部
// 说明、操作人与关联单据号；调增不发). A reversal is a form of its own direction: the whole reversal of
// an increase is a decrease of the balance and sends the message with the original's reason.
// Texts are written out from the rules, never from the code.
import { expect, it } from 'vitest';
import {
  MESSAGE_CODE,
  MESSAGE_TITLE,
  answer,
  fixture,
  inboxOf,
  member,
  messageBody,
  newForm,
  seedForm,
  seedReconDiff,
  seedWithdrawal,
  suite,
  withAdjustAdmin,
  type Ref,
} from './kit.ts';

const s = suite();

function byBody<T extends { body: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.body < b.body ? -1 : a.body > b.body ? 1 : 0));
}

it('[AC-B2-12c#29] 每张调减单给会员一条站内信 BALANCE_ADJUSTED（标题「余额调整」，正文按 BR-TEXT-19：¥1.2 结算核对更正、¥100 重复到账追回、¥0.05 人工调账）；调增单不发；正文不含内部说明、操作人与单据号', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const withdrawal: Ref = { ref_type: 'withdrawal', ref_id: await seedWithdrawal(f, userId) };
    const notes = ['内部说明甲：差错单核对', '内部说明乙：重复出款', '内部说明丙：企业微信沟通'];

    await answer(
      await h.create(
        newForm({
          userId,
          direction: 'increase',
          amount: 300n,
          reason: 'RECON_FIX',
          refs: [diff],
          note: '调增不发站内信',
          contra: 'COMMISSION_REVENUE',
        }),
      ),
      0,
    );
    expect(await inboxOf(f, userId)).toEqual([]);

    await answer(
      await h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 120n,
          reason: 'RECON_FIX',
          refs: [diff],
          note: notes[0]!,
          contra: 'COMMISSION_REVENUE',
        }),
      ),
      0,
    );
    await answer(
      await h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 10_000n,
          reason: 'PAYOUT_RECOVERY',
          refs: [withdrawal, diff],
          note: notes[1]!,
        }),
      ),
      0,
    );
    await answer(
      await h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 5n,
          reason: 'OTHER',
          note: notes[2]!,
          contra: 'MKT_EXPENSE',
        }),
      ),
      0,
    );

    const inbox = await inboxOf(f, userId);
    expect(byBody(inbox)).toEqual(
      byBody([
        { code: MESSAGE_CODE, title: MESSAGE_TITLE, body: messageBody('¥1.2', 'RECON_FIX') },
        { code: MESSAGE_CODE, title: MESSAGE_TITLE, body: messageBody('¥100', 'PAYOUT_RECOVERY') },
        { code: MESSAGE_CODE, title: MESSAGE_TITLE, body: messageBody('¥0.05', 'OTHER') },
      ]),
    );
    const text = JSON.stringify(inbox);
    for (const leak of [...notes, h.maker.id, diff.ref_id, withdrawal.ref_id]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

it('[AC-B2-12c#30] 红冲调增单（+500 RECON_FIX）是调减：发「你的余额调减 ¥5，原因：结算核对更正。…」；红冲调减单（−800 OTHER）是调增：不发', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 2000n });
    const increase = await seedForm(f, {
      userId,
      direction: 'increase',
      amount: 500n,
      reason: 'RECON_FIX',
    });
    const decrease = await seedForm(f, {
      userId,
      direction: 'decrease',
      amount: 800n,
      reason: 'OTHER',
      contra: 'MKT_EXPENSE',
    });

    await answer(await h.create({ reverses_adjust_id: decrease.adjust_id, note: '冲回误调减' }), 0);
    expect(await inboxOf(f, userId)).toEqual([]);

    await answer(await h.create({ reverses_adjust_id: increase.adjust_id, note: '冲回误调增' }), 0);
    expect(await inboxOf(f, userId)).toEqual([
      { code: MESSAGE_CODE, title: MESSAGE_TITLE, body: messageBody('¥5', 'RECON_FIX') },
    ]);
  });
});
