// B2-12c posting (claude-independent): BR-FUND-24 ⑥ (调增借平台科目贷 USER_BALANCE.available，调减反之；
// RECON_FIX、OTHER 由发起人从四个科目选，PAYOUT_RECOVERY 按提现单的出款通道取现金科目；红冲按原单整笔、
// 键 ADJ:{adjust_id}:REVERSE), BR-FUND-16 (每张凭证借贷和为 0，只写 available), specs/ledger-templates.csv
// (ADMIN_ADJUST:{reason}:{subject}:{INCREASE|DECREASE}[:REVERSE]) through the real admin entry.
// Amounts by hand: start 3000; +1234 → 4234; −10000 → −5766; reversing the +1234 → −7000;
// reversing the −10000 → 3000.
import { expect, it } from 'vitest';
import {
  CASH_SUBJECTS,
  CHOOSABLE_SUBJECTS,
  CREATE_ACTION,
  REVERSE_ACTION,
  audits,
  expectAdjusted,
  fixture,
  member,
  moneyOf,
  newForm,
  seedReconDiff,
  seedWithdrawal,
  suite,
  withAdjustAdmin,
  type Adjusted,
  type Channel,
  type Direction,
  type Ref,
} from './kit.ts';

const s = suite();

const STEPS: readonly (readonly [Direction, bigint])[] = [
  ['increase', 1234n],
  ['decrease', 10_000n],
];

interface Case {
  readonly reason: 'RECON_FIX' | 'OTHER' | 'PAYOUT_RECOVERY';
  readonly contra: string;
  readonly platform: string | null;
  readonly channel: Channel | null;
}

const CASES: readonly Case[] = [
  ...(['RECON_FIX', 'OTHER'] as const).flatMap((reason) =>
    CHOOSABLE_SUBJECTS.map((contra): Case => ({
      reason,
      contra,
      platform: contra === 'UNION_RECEIVABLE' ? 'jd' : null,
      channel: null,
    })),
  ),
  ...CASH_SUBJECTS.map(([channel, contra]): Case => ({
    reason: 'PAYOUT_RECOVERY',
    contra,
    platform: null,
    channel,
  })),
];

it.each(CASES)(
  '[AC-B2-12c#5] $reason · $contra（$channel）：调增、调减各一张一步生效，再各整笔红冲；每张凭证分录与 specs/ledger-templates.csv 模板逐行一致、借贷和为 0、不碰 frozen；单与应答、操作人、会计日、余额前后都对；各写一条 adjustment_create / adjustment_reverse 审计',
  async (c) => {
    const f = fixture(s);
    await withAdjustAdmin(f, async (h) => {
      const userId = await member(f, { available: 3000n });
      const diff = await seedReconDiff(f);
      const refs: Ref[] = [{ ref_type: 'recon_diff', ref_id: diff.id }];
      if (c.channel !== null) {
        const withdrawalId = await seedWithdrawal(f, userId, { channel: c.channel });
        refs.unshift({ ref_type: 'withdrawal', ref_id: withdrawalId });
      }
      const filed: Adjusted[] = [];
      for (const [direction, amount] of STEPS) {
        const note = `${c.reason} ${direction} 核对说明`;
        const before = await moneyOf(f, userId);
        const sent = await h.create(
          newForm({
            userId,
            direction,
            amount,
            reason: c.reason,
            refs,
            note,
            ...(c.channel === null ? { contra: c.contra } : {}),
            ...(c.platform === null ? {} : { platform: c.platform }),
          }),
        );
        filed.push(
          await expectAdjusted(f, sent, {
            caller: h.maker,
            userId,
            direction,
            amount,
            reason: c.reason,
            contra: c.contra,
            platform: c.platform,
            refs,
            note,
            before,
          }),
        );
      }
      expect(await moneyOf(f, userId)).toEqual({ available: -5766n, frozen: 0n });

      for (const original of filed) {
        const before = await moneyOf(f, userId);
        const note = '核对有误，整笔冲回';
        const sent = await h.create({ reverses_adjust_id: original.row.adjust_id, note });
        await expectAdjusted(f, sent, {
          caller: h.maker,
          userId,
          direction: original.row.direction === 'increase' ? 'decrease' : 'increase',
          amount: original.row.amount_fen!,
          reason: c.reason,
          contra: c.contra,
          platform: c.platform,
          refs: [],
          note,
          reverses: original.row,
          before,
        });
      }
      expect(await moneyOf(f, userId)).toEqual({ available: 3000n, frozen: 0n });
      expect(await audits(f, CREATE_ACTION)).toHaveLength(2);
      expect(await audits(f, REVERSE_ACTION)).toHaveLength(2);
    });
  },
);
