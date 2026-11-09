// B2-04zzl confirmation rule tests, the account row lock (claude-independent, SPEC_REF d5713bf4): 08
// BR-FUND-08 (one transaction, available may go negative, never frozen), BR-FUND-16 细则「加锁流程」,
// settlement AGENTS.md 硬规则 3 (订单键 advisory 锁 → users 行锁 → ledger.lockBalances). The clawback races a
// withdrawal freeze on the same account: the freeze takes the balance row only — no order key and no
// users row — so nothing but the balance row lock can order the two. Both interleavings, each pinned by
// an explicit barrier and observed in pg_stat_activity, never by a sleep; each asserts the final
// balance and every entry of the account. Requests go through the real admin entry (kit.ts). Top-level
// it() only (规划/11 §4.3).
//
// The member starts with 850 available (425 from the blacklisted order, 425 from another one). The
// freeze takes 400, the clawback 425: both orders end at available 25, frozen 400.
import { expect, it } from 'vitest';
import {
  app,
  clawbackKey,
  confirmed,
  eventIdOf,
  platformClawbackKey,
  platformDecreaseLines,
  seedBlacklistDiff,
  suite,
  track,
  userClawbackLines,
  waiting,
  withAdmin,
  type App,
  type SeededOrder,
} from './kit.ts';
import {
  balanceRow,
  entriesAfter,
  heldFreeze,
  throughPlugin,
  voucherBarrier,
} from './ledger-kit.ts';

const s = suite();

/** The blacklisted order and a second order that funds the same member's account. */
async function fundedMember(a: App): Promise<{ o: SeededOrder; self: string }> {
  const { h } = a;
  const o = await h.credited();
  const self = o.user('self');
  await h.credited({ people: [{ role: 'self', ratioBp: 5000, userId: self }] });
  expect(await h.balance(self)).toBe(850n);
  return { o, self };
}

/** What both interleavings end with: the whole clawback, nothing on the other beneficiaries lost. */
async function expectFinal(a: App, o: SeededOrder, self: string, event: string): Promise<void> {
  const { h } = a;
  expect(await h.balance(self)).toBe(25n);
  expect(await h.frozenOf(self)).toBe(400n);
  expect(await h.voucherLines(clawbackKey(o, 'self', event))).toEqual(
    userClawbackLines(o, 'self', 425n),
  );
  expect(await h.voucherLines(platformClawbackKey(o, event))).toEqual(
    platformDecreaseLines(o, 448n),
  );
  expect(await h.balance(o.user('direct'))).toBe(0n);
  expect(await h.balance(o.user('indirect'))).toBe(0n);
  expect((await h.read(o)).rebate_status).toBe('CLAWED_BACK');
}

it('[AC-B2-04zzl#45] 账户行锁，先提现后扣回：提现冻结持有余额行时，确认在余额行上等待（不在 users 行或订单键上）；放行后按提现后的余额记账：冻结 available 850 → 450、frozen 400，扣回 available 450 → 25，余额版本 +2，无丢失更新', async () => {
  const a = await app(s);
  const { o, self } = await fundedMember(a);
  const diff = await seedBlacklistDiff(a, o);
  const start = await balanceRow(a, self);
  expect(start).toMatchObject({ available_fen: 850n, frozen_fen: 0n });

  await withAdmin(a, async (admin) => {
    const freeze = heldFreeze(a, self, 400n);
    await freeze.posted;
    const sent = track(admin.confirm(diff.id));
    try {
      expect(await waiting(a.f, 1, [sent]), '确认应在提现持有的余额行上等待').toBe(true);
    } finally {
      freeze.release();
      await freeze.done;
    }
    expect((await confirmed(await sent.promise)).clawed_back_fen).toBe(552);

    const event = eventIdOf(diff);
    await expectFinal(a, o, self, event);
    expect(await entriesAfter(a, self, start.version)).toEqual([
      {
        uniq_key: freeze.uniqKey,
        sub_account: 'available',
        amount_fen: 400n,
        balance_after_fen: 450n,
        account_version: start.version + 1n,
        ledger_type: 'WITHDRAW_FREEZE',
        sub_type: null,
      },
      {
        uniq_key: freeze.uniqKey,
        sub_account: 'frozen',
        amount_fen: -400n,
        balance_after_fen: 400n,
        account_version: start.version + 1n,
        ledger_type: 'WITHDRAW_FREEZE',
        sub_type: null,
      },
      {
        uniq_key: clawbackKey(o, 'self', event),
        sub_account: 'available',
        amount_fen: 425n,
        balance_after_fen: 25n,
        account_version: start.version + 2n,
        ledger_type: 'CLAWBACK',
        sub_type: 'FULL',
      },
    ]);
    expect(await balanceRow(a, self)).toMatchObject({
      available_fen: 25n,
      frozen_fen: 400n,
      version: start.version + 2n,
    });
  });
});

it('[AC-B2-04zzl#46] 账户行锁，先扣回后提现：确认写出第一张凭证、仍持有余额行时，提现冻结在余额行上等待；确认提交后提现按扣回后的余额记账：扣回 available 850 → 425，冻结 available 425 → 25、frozen 400，余额版本 +2，无丢失更新', async () => {
  const a = await app(s);
  const { o, self } = await fundedMember(a);
  const diff = await seedBlacklistDiff(a, o);
  const start = await balanceRow(a, self);
  const barrier = voucherBarrier();

  await withAdmin(throughPlugin(a, barrier.plugin), async (admin) => {
    const sent = track(admin.confirm(diff.id));
    await Promise.race([barrier.reached, sent.promise]);
    expect(barrier.hit(), '确认应写到第一张凭证并停在屏障上').toBe(true);

    const freeze = heldFreeze(a, self, 400n);
    try {
      expect(await waiting(a.f, 1, [track(freeze.posted)]), '提现应在确认持有的余额行上等待').toBe(
        true,
      );
    } finally {
      barrier.release();
    }
    expect((await confirmed(await sent.promise)).clawed_back_fen).toBe(552);
    await freeze.posted;
    freeze.release();
    await freeze.done;

    const event = eventIdOf(diff);
    await expectFinal(a, o, self, event);
    expect(await entriesAfter(a, self, start.version)).toEqual([
      {
        uniq_key: clawbackKey(o, 'self', event),
        sub_account: 'available',
        amount_fen: 425n,
        balance_after_fen: 425n,
        account_version: start.version + 1n,
        ledger_type: 'CLAWBACK',
        sub_type: 'FULL',
      },
      {
        uniq_key: freeze.uniqKey,
        sub_account: 'available',
        amount_fen: 400n,
        balance_after_fen: 25n,
        account_version: start.version + 2n,
        ledger_type: 'WITHDRAW_FREEZE',
        sub_type: null,
      },
      {
        uniq_key: freeze.uniqKey,
        sub_account: 'frozen',
        amount_fen: -400n,
        balance_after_fen: 400n,
        account_version: start.version + 2n,
        ledger_type: 'WITHDRAW_FREEZE',
        sub_type: null,
      },
    ]);
    expect(await balanceRow(a, self)).toMatchObject({
      available_fen: 25n,
      frozen_fen: 400n,
      version: start.version + 2n,
    });
  });
});
