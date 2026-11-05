// B2-12c concurrency (claude-independent): BR-FUND-24 ① (批准时在同一事务内重读余额并写凭证), 细则
// 「红冲只按原单整笔」(同一张原调账单只能被红冲一次；the unique key on reverses_adjust_id answers 20902
// under a race), BR-FUND-10 并发 (提现冻结与扣减按 account_id 行锁串行；冻结先提交则调减照常把 available
// 扣负，frozen 不动), BR-FUND-16 (加锁后更新余额). The member's rows are held from a second connection
// (kit.ts holdMember) so both requests are inside their transactions before either can finish.
import { expect, it } from 'vitest';
import {
  REVERSE_ACTION,
  adjustVouchers,
  allForms,
  answer,
  audits,
  conflict,
  expectAdjusted,
  fixture,
  holdMember,
  member,
  moneyOf,
  newForm,
  postFreeze,
  seedForm,
  seedReconDiff,
  suite,
  track,
  waiting,
  withAdjustAdmin,
  type AdminSent,
  type Ref,
} from './kit.ts';

const s = suite();

it('[AC-B2-12c#25] 两个账号同时红冲同一张原单：只成一个（200），另一个 20902 admin_adjustment；只有一张红冲单、一张 ADJ:{原单}:REVERSE 凭证、一条 adjustment_reverse 审计，余额只冲回一次', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n });
    const original = await seedForm(f, { userId, direction: 'increase', amount: 500n });
    expect(await moneyOf(f, userId)).toEqual({ available: 1500n, frozen: 0n });
    const colleague = await h.caller(['fund.adjust']);
    const note = '误调，整笔冲回';

    const lock = await holdMember(f, userId);
    const racing = [h.maker, colleague].map((who) =>
      track(h.create({ reverses_adjust_id: original.adjust_id, note }, { caller: who })),
    );
    try {
      expect(await waiting(f, 2, racing), '两次红冲都应在会员行锁上等待').toBe(true);
    } finally {
      await lock.release();
    }
    const results: AdminSent[] = await Promise.all(racing.map((r) => r.promise));
    expect(
      results.map((r) => r.statusCode).sort((a, b) => a - b),
      results.map((r) => r.body).join('\n'),
    ).toEqual([200, 409]);
    const codes = results.map((r) => r.json().code).sort((a, b) => a - b);
    expect(codes, results.map((r) => r.body).join('\n')).toEqual([0, 20902]);
    for (const result of results) {
      if (result.json().code === 20902) await conflict(result);
      else await answer(result, 0);
    }

    expect((await allForms(f)).filter((row) => row.reverses_adjust_id !== null)).toHaveLength(1);
    expect((await adjustVouchers(f)).map((v) => v.uniq_key).sort()).toEqual(
      [`ADJ:${original.adjust_id}`, `ADJ:${original.adjust_id}:REVERSE`].sort(),
    );
    expect(await audits(f, REVERSE_ACTION)).toHaveLength(1);
    expect(await moneyOf(f, userId)).toEqual({ available: 1000n, frozen: 0n });
  });
});

it('[AC-B2-12c#26] 调减与提现冻结并发：冻结 1000 先提交，调减 5000 在锁后重读余额（应答 before 2000、after −3000），只动 available，frozen 保持 1000', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const lock = await holdMember(f, userId, async (trx, balance) => {
      await postFreeze(f, trx, balance, 1000n);
    });
    const pending = track(
      h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 5000n,
          reason: 'RECON_FIX',
          refs: [diff],
          note: '多记的结算冲减',
          contra: 'COMMISSION_REVENUE',
        }),
      ),
    );
    try {
      expect(await waiting(f, 1, [pending]), '调减应在会员行锁上等待').toBe(true);
    } finally {
      await lock.release();
    }
    await expectAdjusted(f, await pending.promise, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 5000n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [diff],
      note: '多记的结算冲减',
      before: { available: 2000n, frozen: 1000n },
    });
    expect(await moneyOf(f, userId)).toEqual({ available: -3000n, frozen: 1000n });
  });
});
