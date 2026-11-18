// B2-02x negative_since (claude-independent, SPEC_REF ba6655b1): recalcBalanceAdminReconDiff
// (CT-24zzna) — when the cache is written, negative_since follows the rule of the posting path
// (08 BR-FUND-12; apps/api/src/modules/ledger/application/ledger.ts computeWrite): new available
// < 0 and old available < 0 with a negative_since → kept; new < 0 and old ≥ 0 (or no
// negative_since) → the Clock's +08:00 accounting day; new ≥ 0 → NULL (D10-2032 ①). The kept value
// is the cache's own, not a day derived from the entries. The entries of these members are posted
// on the plain ledger on other days (its Clock moved there and back), so the expected values can
// only come from the rule.
import { expect, it } from 'vitest';
import {
  EARLIER,
  cacheOf,
  entrySums,
  expectRecalculated,
  fixture,
  plainMember,
  seedMismatch,
  seedWithdrawal,
  shift,
  suite,
  tamper,
  withRecalcAdmin,
  written,
  type AdjustFixture,
  type Member,
} from './kit.ts';

const s = suite();

/** A day between EARLIER and the clock: neither the entries' day nor today. */
const MIDDLE = '2026-10-20';
/** 2026-11-19 00:30 +08:00: the UTC date is still 2026-11-18. */
const AFTER_MIDNIGHT = '2026-11-18T16:30:00.000Z';
const AFTER_MIDNIGHT_DAY = '2026-11-19';

/** A member whose entries sum to `available` (posted at noon +08:00 of EARLIER). */
async function memberAt(f: AdjustFixture, available: bigint): Promise<Member> {
  const saved = f.clock.now();
  f.clock.set(`${EARLIER}T04:00:00.000Z`);
  try {
    const m = await plainMember(f, available > 0n ? available : 0n);
    if (available < 0n) await shift(f, m.userId, available);
    return m;
  } finally {
    f.clock.set(saved);
  }
}

it('[AC-B2-02x#21] 分支一：重算后 < 0 且重算前也 < 0、有 negative_since → 沿用缓存里的原值（不是今天，也不是分录变负的那天）', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await memberAt(f, -300n);
    expect(await entrySums(f, m)).toEqual({ available: -300n, frozen: 0n });
    const before = await tamper(f, m, { available: -500n, frozen: 0n, negativeSince: MIDDLE });
    const diff = await seedMismatch(f, m);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '负到负' }), {
      m,
      before: { available: -500n, frozen: 0n },
      after: { available: -300n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, m)).toEqual(
      written(before, { available: -300n, frozen: 0n, negativeSince: MIDDLE }),
    );
  });
});

it('[AC-B2-02x#22] 分支二：重算后 < 0 而重算前 ≥ 0（200、正好 0）或重算前 < 0 却没有 negative_since → 当天会计日（+08:00：UTC 仍是 11-18 的 00:30 记 2026-11-19）', async () => {
  const f = fixture(s, AFTER_MIDNIGHT);
  await withRecalcAdmin(f, async (h) => {
    for (const cache of [
      { available: 200n, frozen: 0n, negativeSince: null },
      { available: 0n, frozen: 0n, negativeSince: null },
      { available: -500n, frozen: 0n, negativeSince: null },
    ]) {
      const m = await memberAt(f, -300n);
      const before = await tamper(f, m, cache);
      const diff = await seedMismatch(f, m);
      await expectRecalculated(f, await h.recalc(diff.id, { reason: '变负' }), {
        m,
        before: { available: cache.available, frozen: 0n },
        after: { available: -300n, frozen: 0n },
        changed: true,
      });
      expect(await cacheOf(f, m), `before ${cache.available}`).toEqual(
        written(before, { available: -300n, frozen: 0n, negativeSince: AFTER_MIDNIGHT_DAY }),
      );
    }
  });
});

it('[AC-B2-02x#23] 分支三：重算后 ≥ 0（正好 0、正数）→ negative_since 置 NULL，不论缓存原来是否为负、是否有 negative_since', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const cases = [
      { entries: 0n, cache: { available: -50n, frozen: 0n, negativeSince: EARLIER } },
      { entries: 250n, cache: { available: -50n, frozen: 0n, negativeSince: MIDDLE } },
      { entries: 250n, cache: { available: 900n, frozen: 0n, negativeSince: MIDDLE } },
    ];
    for (const c of cases) {
      const m = await memberAt(f, c.entries);
      const before = await tamper(f, m, c.cache);
      const diff = await seedMismatch(f, m);
      await expectRecalculated(f, await h.recalc(diff.id, { reason: '回到非负' }), {
        m,
        before: { available: c.cache.available, frozen: 0n },
        after: { available: c.entries, frozen: 0n },
        changed: true,
      });
      expect(await cacheOf(f, m), `${c.cache.available} → ${c.entries}`).toEqual(
        written(before, { available: c.entries, frozen: 0n, negativeSince: null }),
      );
    }
  });
});

it('[AC-B2-02x#24] 前后都为负时原值不动：缓存 −1 → 分录 −900 仍沿用缓存的 negative_since；available 不变只改 frozen（−900 / 0 → −900 / 400）时也沿用', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const deeper = await memberAt(f, -900n);
    const before = await tamper(f, deeper, { available: -1n, frozen: 0n, negativeSince: MIDDLE });
    const diff = await seedMismatch(f, deeper);
    await expectRecalculated(f, await h.recalc(diff.id, { reason: '更负' }), {
      m: deeper,
      before: { available: -1n, frozen: 0n },
      after: { available: -900n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, deeper)).toEqual(
      written(before, { available: -900n, frozen: 0n, negativeSince: MIDDLE }),
    );

    const frozen = await plainMember(f, 1000n);
    await seedWithdrawal(f, frozen.userId, { status: 'APPROVED', amount: 400n });
    await shift(f, frozen.userId, -1500n);
    expect(await entrySums(f, frozen)).toEqual({ available: -900n, frozen: 400n });
    const cached = await tamper(f, frozen, {
      available: -900n,
      frozen: 0n,
      negativeSince: EARLIER,
    });
    const frozenDiff = await seedMismatch(f, frozen, {}, '06');
    await expectRecalculated(f, await h.recalc(frozenDiff.id, { reason: '只差冻结' }), {
      m: frozen,
      before: { available: -900n, frozen: 0n },
      after: { available: -900n, frozen: 400n },
      changed: true,
    });
    expect(await cacheOf(f, frozen)).toEqual(
      written(cached, { available: -900n, frozen: 400n, negativeSince: EARLIER }),
    );
  });
});
