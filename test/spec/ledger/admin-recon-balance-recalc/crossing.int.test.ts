// B2-02x crossing zero (claude-independent, SPEC_REF ba6655b1): recalcBalanceAdminReconDiff
// (CT-24zzna, D10-2041) handles 跨零 as a posting does (08 BR-WDR-05 (a); ledger.ts wentNegative /
// recovered and the publish / hook calls after the balance write): available from ≥ 0 to < 0 →
// the platform event account.went_negative exactly once, on the same transaction; from < 0 to ≥ 0
// → the balance-recovered handling (payout's hook of the admin entry: the member's NEGATIVE_BALANCE
// blocks are lifted in the same transaction); no crossing, a refusal and an unchanged cache do
// neither; a rolled-back transaction publishes nothing and lifts nothing. The seeds' ledger has no
// bus and no hook, so every event and every lifted block here is the entry's.
import { expect, it } from 'vitest';
import {
  DAY,
  EARLIER,
  RECALC_ACTION,
  WENT_NEGATIVE_EVENT,
  answer,
  audits,
  cacheOf,
  events,
  expectRecalculated,
  fixture,
  notApplicable,
  plainMember,
  rawVoucher,
  seedMismatch,
  seedWithdrawal,
  shift,
  suite,
  tamper,
  wentNegative,
  withRecalcAdmin,
  withdrawalNow,
  written,
  type AdjustFixture,
  type Member,
} from './kit.ts';

const s = suite();

/** A member with entries summing to `available` and one APPROVED withdrawal of 100 blocked NEGATIVE_BALANCE. */
async function blockedMember(
  f: AdjustFixture,
  available: bigint,
): Promise<{ readonly m: Member; readonly withdrawalId: string }> {
  const m = await plainMember(f, 100n);
  const withdrawalId = await seedWithdrawal(f, m.userId, {
    status: 'APPROVED',
    amount: 100n,
    blocked: true,
  });
  if (available !== 0n) await shift(f, m.userId, available);
  return { m, withdrawalId };
}

it('[AC-B2-02x#25] ≥ 0 → < 0：缓存 200、分录 −300 → 恰好一条 account.went_negative（payload.data.user_id 为该会员）；再重算一次（前后相同）不再发；缓存正好 0 → 分录 −1 也发一条', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 0n);
    await shift(f, m.userId, -300n);
    await tamper(f, m, { available: 200n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    expect(await events(f)).toEqual([]);

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '变负' }), {
      m,
      before: { available: 200n, frozen: 0n },
      after: { available: -300n, frozen: 0n },
      changed: true,
    });
    const published = await wentNegative(f, m.userId);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ payload: { data: { user_id: m.userId } } });
    expect(
      (await events(f)).map((row) => row.name),
      '只有这一条事件',
    ).toEqual([WENT_NEGATIVE_EVENT]);

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '再核一次' }), {
      m,
      before: { available: -300n, frozen: 0n },
      after: { available: -300n, frozen: 0n },
      changed: false,
    });
    expect(await wentNegative(f, m.userId), '前后相同不发').toHaveLength(1);

    const edge = await plainMember(f, 0n);
    await shift(f, edge.userId, -1n);
    await tamper(f, edge, { available: 0n, frozen: 0n, negativeSince: null });
    const edgeDiff = await seedMismatch(f, edge);
    await expectRecalculated(f, await h.recalc(edgeDiff.id, { reason: '0 到 −1' }), {
      m: edge,
      before: { available: 0n, frozen: 0n },
      after: { available: -1n, frozen: 0n },
      changed: true,
    });
    expect(await wentNegative(f, edge.userId)).toHaveLength(1);
  });
});

it('[AC-B2-02x#26] < 0 → ≥ 0：缓存 −200、分录 500，有一张 NEGATIVE_BALANCE 拦截的已批提现单 → 同一笔解除拦截（blocked_reason 清空、updated_at 取时钟、row_version + 1、状态不变），不发 account.went_negative；缓存 −1 → 分录正好 0 也解除', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const { m, withdrawalId } = await blockedMember(f, 500n);
    const before = await withdrawalNow(f, withdrawalId);
    expect(before.blocked_reason).toBe('NEGATIVE_BALANCE');
    await tamper(f, m, { available: -200n, frozen: 100n, negativeSince: EARLIER });
    const diff = await seedMismatch(f, m);

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '回正' }), {
      m,
      before: { available: -200n, frozen: 100n },
      after: { available: 500n, frozen: 100n },
      changed: true,
    });
    expect(await withdrawalNow(f, withdrawalId)).toEqual({
      ...before,
      blocked_reason: null,
      updated_at: f.clock.now(),
      row_version: before.row_version + 1,
    });
    expect(await events(f), '回正不发事件').toEqual([]);

    const edge = await blockedMember(f, 0n);
    const edgeBefore = await withdrawalNow(f, edge.withdrawalId);
    await tamper(f, edge.m, { available: -1n, frozen: 100n, negativeSince: EARLIER });
    const edgeDiff = await seedMismatch(f, edge.m);
    await expectRecalculated(f, await h.recalc(edgeDiff.id, { reason: '−1 到 0' }), {
      m: edge.m,
      before: { available: -1n, frozen: 100n },
      after: { available: 0n, frozen: 100n },
      changed: true,
    });
    expect(await withdrawalNow(f, edge.withdrawalId)).toEqual({
      ...edgeBefore,
      blocked_reason: null,
      updated_at: f.clock.now(),
      row_version: edgeBefore.row_version + 1,
    });
  });
});

it('[AC-B2-02x#27] 不跨零都不发生：正到正（拦截中的提现单原样）、负到负、只改 frozen、前后相同（缓存为负）→ 没有事件，提现单不动', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const positive = await blockedMember(f, 400n);
    await tamper(f, positive.m, { available: 50n, frozen: 100n, negativeSince: null });
    const negative = await blockedMember(f, -700n);
    await tamper(f, negative.m, { available: -100n, frozen: 100n, negativeSince: EARLIER });
    const frozenOnly = await blockedMember(f, 300n);
    await tamper(f, frozenOnly.m, { available: 300n, frozen: 0n, negativeSince: null });
    const same = await blockedMember(f, -50n);
    await tamper(f, same.m, { available: -50n, frozen: 100n, negativeSince: EARLIER });
    const cases = [
      { c: positive, before: [50n, 100n], after: [400n, 100n], changed: true },
      { c: negative, before: [-100n, 100n], after: [-700n, 100n], changed: true },
      { c: frozenOnly, before: [300n, 0n], after: [300n, 100n], changed: true },
      { c: same, before: [-50n, 100n], after: [-50n, 100n], changed: false },
    ] as const;
    for (const { c, before, after, changed } of cases) {
      const row = await withdrawalNow(f, c.withdrawalId);
      const diff = await seedMismatch(f, c.m);
      await expectRecalculated(f, await h.recalc(diff.id, { reason: '不跨零' }), {
        m: c.m,
        before: { available: before[0], frozen: before[1] },
        after: { available: after[0], frozen: after[1] },
        changed,
      });
      expect(await withdrawalNow(f, c.withdrawalId), `${before[0]} → ${after[0]}`).toEqual(row);
    }
    expect(await events(f), '没有任何事件').toEqual([]);
  });
});

it('[AC-B2-02x#28] 拒绝时也不跨零处理：缓存 100、分录 available −350 而 frozen 合计为负 → 20001 [recon_diff_id]，不发事件；缓存 −100、分录 available 为正而 frozen 合计为负 → 拦截不解除', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const down = await plainMember(f, 0n);
    await shift(f, down.userId, -400n);
    await rawVoucher(f, down, [
      { sub_account: 'frozen', amount_fen: 50n },
      { sub_account: 'available', amount_fen: -50n },
    ]);
    const downCache = await tamper(f, down, { available: 100n, frozen: 0n, negativeSince: null });
    const downDiff = await seedMismatch(f, down);
    await notApplicable(await h.recalc(downDiff.id, { reason: '冻结为负' }));
    expect(await cacheOf(f, down)).toEqual(downCache);

    const up = await blockedMember(f, 200n);
    await rawVoucher(f, up.m, [
      { sub_account: 'frozen', amount_fen: 300n },
      { sub_account: 'available', amount_fen: -300n },
    ]);
    const row = await withdrawalNow(f, up.withdrawalId);
    const upCache = await tamper(f, up.m, {
      available: -100n,
      frozen: 100n,
      negativeSince: EARLIER,
    });
    const upDiff = await seedMismatch(f, up.m);
    await notApplicable(await h.recalc(upDiff.id, { reason: '冻结为负' }));
    expect(await cacheOf(f, up.m)).toEqual(upCache);
    expect(await withdrawalNow(f, up.withdrawalId), '拦截不解除').toEqual(row);
    expect(await events(f), '拒绝不发事件').toEqual([]);
  });
});

it('[AC-B2-02x#29] 同一事务：变负的重算在写审计、写余额或发事件时失败 → 50001，余额行不变、没有事件、没有审计；回正的重算在写审计时失败 → 拦截不解除；再调一次（新的短信验证）即一次生效、恰好一条事件', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 0n);
    await shift(f, m.userId, -300n);
    const cache = await tamper(f, m, { available: 200n, frozen: 0n, negativeSince: null });
    const diff = await seedMismatch(f, m);
    for (const point of ['audit', 'balance', 'event'] as const) {
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.recalc(diff.id, { reason: `失败于 ${point}` });
      expect(h.fault.tripped, `${point} 必须在重算事务里执行`).toBe(tripped + 1);
      h.fault.point = null;
      await answer(sent, 50001);
      expect(await cacheOf(f, m), point).toEqual(cache);
      expect(await events(f), point).toEqual([]);
      expect(await audits(f, RECALC_ACTION), point).toEqual([]);
    }
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '重试' }), {
      m,
      before: { available: 200n, frozen: 0n },
      after: { available: -300n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, m)).toEqual(
      written(cache, { available: -300n, frozen: 0n, negativeSince: DAY }),
    );
    expect(await wentNegative(f, m.userId)).toHaveLength(1);

    const { m: back, withdrawalId } = await blockedMember(f, 500n);
    const row = await withdrawalNow(f, withdrawalId);
    const backCache = await tamper(f, back, {
      available: -200n,
      frozen: 100n,
      negativeSince: EARLIER,
    });
    const backDiff = await seedMismatch(f, back);
    const tripped = h.fault.tripped;
    h.fault.point = 'audit';
    const sent = await h.recalc(backDiff.id, { reason: '回正失败' });
    expect(h.fault.tripped).toBe(tripped + 1);
    h.fault.point = null;
    await answer(sent, 50001);
    expect(await cacheOf(f, back)).toEqual(backCache);
    expect(await withdrawalNow(f, withdrawalId), '回滚后拦截仍在').toEqual(row);
  });
});
