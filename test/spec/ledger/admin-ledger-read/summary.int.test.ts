// B2-02u balance card rule tests (claude-independent, SPEC_REF 39756e36): contracts/openapi.yaml
// adminGetUserFundSummary; 08 BR-FUND-13 (one balance, available + frozen), BR-FUND-18
// (withdrawn_fen = Σ amount_fen of PAID_API / PAID_MANUAL withdrawals; balances are the
// account_balances values, not a sum of entries); D10-1057: withdraw_block lists the distinct kinds
// of the holds in effect (released_at null and hold_until not passed), in withdraw_hold_kind order.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  credit,
  fieldsError,
  fixture,
  member,
  ok,
  openMember,
  seedHold,
  seedWithdrawal,
  setCache,
  suite,
  withLedgerAdmin,
  type Fixture,
} from './kit.ts';

const s = suite();
const MINUTE = 60_000;

/** An instant `minutes` from the fixture's clock (negative: in the past). */
function from(f: Fixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() + minutes * MINUTE);
}

it('[AC-B2-02u#5] 余额卡：available_fen / frozen_fen / negative_since 取 account_balances 缓存行原值（缓存与分录不一致时仍取缓存）；withdrawn_fen 只计本人 PAID_API 与 PAID_MANUAL 提现单的 amount_fen', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  const b = await openMember(f);
  await credit(f, a, 9_000n);
  // Entries say 9000 / 0 / not negative; the cache row says otherwise and wins.
  await setCache(f, a, { available: -4_321n, frozen: 678n, negativeSince: '2026-10-20' });
  // Paid rows with fee and tax: amount 1000 (fee 20, tax 100, net 880) and amount 2500 (tax 300,
  // net 2200). withdrawn_fen sums amount_fen (3500), not net_fen (3080) nor amount − fee (3180).
  await seedWithdrawal(f, a.userId, 1_000n, 'PAID_API', null, { feeFen: 20n, taxFen: 100n });
  await seedWithdrawal(f, a.userId, 2_500n, 'PAID_MANUAL', null, { feeFen: 0n, taxFen: 300n });
  for (const status of ['PENDING_REVIEW', 'APPROVED', 'PAYING', 'FAILED', 'REJECTED'] as const) {
    await seedWithdrawal(f, a.userId, 70n, status);
  }
  await seedWithdrawal(f, b.userId, 9_999n, 'PAID_API');
  await withLedgerAdmin(f, async (h) => {
    expect(await ok(await h.summary(a.userId))).toEqual({
      user_id: a.userId,
      available_fen: -4_321,
      frozen_fen: 678,
      negative_since: '2026-10-20',
      withdrawn_fen: 3_500,
      withdraw_block: { blocked: false, hold_kinds: [] },
    });
    expect(await ok(await h.summary(b.userId))).toEqual({
      user_id: b.userId,
      available_fen: 0,
      frozen_fen: 0,
      negative_since: null,
      withdrawn_fen: 9_999,
      withdraw_block: { blocked: false, hold_kinds: [] },
    });
  });
});

it('[AC-B2-02u#6] 余额卡：有账户且缓存与分录一致时照缓存给出（正余额 negative_since=null）；还没有账本账户的用户 → 0 / 0 / null，withdrawn_fen=0，未冻结', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  await credit(f, a, 800n);
  const bare = await member(f);
  await withLedgerAdmin(f, async (h) => {
    expect(await ok(await h.summary(a.userId))).toEqual({
      user_id: a.userId,
      available_fen: 800,
      frozen_fen: 0,
      negative_since: null,
      withdrawn_fen: 0,
      withdraw_block: { blocked: false, hold_kinds: [] },
    });
    expect(await ok(await h.summary(bare))).toEqual({
      user_id: bare,
      available_fen: 0,
      frozen_fen: 0,
      negative_since: null,
      withdrawn_fen: 0,
      withdraw_block: { blocked: false, hold_kinds: [] },
    });
  });
});

it('[AC-B2-02u#7] 提现冻结：生效的冻结记录（未释放且未过 hold_until）按 withdraw_hold_kind 枚举顺序去重列出、blocked=true；已释放、已过期、别的用户的不算；只剩已释放 / 已过期的 → {blocked:false, hold_kinds:[]}', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  const b = await openMember(f);
  const c = await openMember(f);
  // a: in effect — manual_failed_watch (no end), manual twice (one ends in an hour), recon_diff
  // released, ledger_mismatch expired.
  await seedHold(f, { user_id: a.userId, reason: 'manual_failed_watch' });
  await seedHold(f, { user_id: a.userId, reason: 'manual', hold_until: from(f, 60) });
  await seedHold(f, { user_id: a.userId, reason: 'manual' });
  await seedHold(f, {
    user_id: a.userId,
    reason: 'recon_diff',
    released_at: from(f, -10),
    released_by: 'synthetic',
  });
  await seedHold(f, { user_id: a.userId, reason: 'ledger_mismatch', hold_until: from(f, -1) });
  // b: only released and expired ones; c's own hold must not reach a or b.
  await seedHold(f, {
    user_id: b.userId,
    reason: 'manual',
    released_at: from(f, -5),
    released_by: 'synthetic',
  });
  await seedHold(f, { user_id: b.userId, reason: 'recon_diff', hold_until: from(f, -30) });
  await seedHold(f, { user_id: c.userId, reason: 'ledger_mismatch' });
  await withLedgerAdmin(f, async (h) => {
    const blockOf = async (userId: string) =>
      ((await ok(await h.summary(userId))) as Record<string, unknown>)['withdraw_block'];
    expect(await blockOf(a.userId)).toEqual({
      blocked: true,
      hold_kinds: ['manual', 'manual_failed_watch'],
    });
    expect(await blockOf(b.userId)).toEqual({ blocked: false, hold_kinds: [] });
    expect(await blockOf(c.userId)).toEqual({ blocked: true, hold_kinds: ['ledger_mismatch'] });
  });
});

it('[AC-B2-02u#8] 余额卡的拒绝：不存在的 user_id、别的 app 的用户、不是 UUID 的 user_id → 20001 data.fields=[user_id]', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const stranger = await openMember(other);
  await credit(other, stranger, 500n);
  await withLedgerAdmin(f, async (h) => {
    await fieldsError(await h.summary(randomUUID()), ['user_id']);
    await fieldsError(await h.summary(stranger.userId), ['user_id']);
    await fieldsError(await h.summary('not-a-user-id'), ['user_id']);
  });
});
