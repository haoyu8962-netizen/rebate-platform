// BR-FUND-24 ⑨ counts every involved member with an approved, unreversed adjustment.
import { expect, it } from 'vitest';
import {
  ADJUST,
  expectAdjusted,
  fixture,
  member,
  moneyOf,
  newForm,
  seedWithdrawal,
  suite,
  withAdjustAdmin,
  type AdjustAdmin,
  type AdjustFixture,
  type Adjusted,
  type AdminCaller,
  type Ref,
} from '../../admin-adjustments/kit.ts';
import {
  diffRef,
  expectNowAdjusted,
  expectNowProcessing,
  fileOk,
  linkOf,
  linksOf,
  schemaReady,
  seedTicket,
  sortedLinks,
  tick,
} from '../kit.ts';

const s = suite();
type Reason = 'OTHER' | 'RECON_FIX' | 'PAYOUT_RECOVERY';

async function fileForMember(
  f: AdjustFixture,
  h: AdjustAdmin,
  caller: AdminCaller,
  userId: string,
  ref: Ref,
  reason: Reason,
): Promise<Adjusted> {
  if (reason !== 'PAYOUT_RECOVERY') {
    const amount = reason === 'OTHER' ? 120n : 250n;
    return fileOk(f, h, { caller, userId, reason, amount, direction: 'decrease', refs: [ref] });
  }

  const withdrawal = await seedWithdrawal(f, userId, { channel: 'alipay', amount: 10_000n });
  const refs: Ref[] = [{ ref_type: 'withdrawal', ref_id: withdrawal }, ref];
  const note = '核对支付宝提现后追回';
  const body = newForm({ userId, direction: 'decrease', amount: 10_000n, reason, refs, note });
  const before = await moneyOf(f, userId);
  return expectAdjusted(f, await h.create(body, { caller }), {
    caller,
    userId,
    direction: 'decrease',
    amount: 10_000n,
    reason,
    contra: 'CASH_ALIPAY',
    refs,
    note,
    before,
  });
}

async function checkDifferentReasons(firstReason: Reason, secondReason: Reason): Promise<void> {
  const f = fixture(s);
  await schemaReady(f.db);
  await withAdjustAdmin(f, async (h) => {
    const firstUser = await member(f, { available: 20_000n });
    const secondUser = await member(f, { available: 20_000n });
    const closer = await h.caller([ADJUST]);
    const opened = await seedTicket(f, { users: [firstUser, secondUser] });
    const ref = diffRef(opened);

    const first = await fileForMember(f, h, h.maker, firstUser, ref, firstReason);
    const processing = await expectNowProcessing(f, opened);
    const firstLink = linkOf(f, first.row.adjust_id, opened.id, firstUser);
    expect(await linksOf(f)).toEqual([firstLink]);
    tick(f);

    const second = await fileForMember(f, h, closer, secondUser, ref, secondReason);
    await expectNowAdjusted(f, processing, closer.id);
    const secondLink = linkOf(f, second.row.adjust_id, opened.id, secondUser);
    expect(await linksOf(f)).toEqual(sortedLinks([firstLink, secondLink]));
  });
}

it('[AC-B2-17b#4] 同一差错单先给会员 1 以 OTHER 调减 120 分，再用会员 2 自己的支付宝提现单以 PAYOUT_RECOVERY 调减 10000 分，第二笔结案且两行关联均有效', async () => {
  await checkDifferentReasons('OTHER', 'PAYOUT_RECOVERY');
});

it('[AC-B2-17b#5] 同一差错单先给会员 1 以 PAYOUT_RECOVERY 调减 10000 分，再给会员 2 以 RECON_FIX 调减 250 分，第二笔结案且两行关联均有效', async () => {
  await checkDifferentReasons('PAYOUT_RECOVERY', 'RECON_FIX');
});
