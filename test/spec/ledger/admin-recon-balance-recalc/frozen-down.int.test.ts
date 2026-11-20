// B2-02xb frozen_fen written down and the ±(2^53 − 1) bounds of a recalculation (claude-independent,
// SPEC_REF ba6655b1; B2-02x Codex r5 / r6 S1, D10-2198 / D10-2200): contracts/openapi.yaml
// recalcBalanceAdminReconDiff — the server sets available_fen and frozen_fen of the balance row to
// the two entry sums, up or down, version + 1 (BR-FUND-19 细则「差异以分录为准修正」); under the
// lock, a negative frozen sum, an available / frozen sum or a cached available_fen / frozen_fen
// outside ±(2^53 − 1) (−9007199254740991 … 9007199254740991, D10-2064 ③) → 20001
// data.fields=[recon_diff_id], the balance row not written (values, version, negative_since), one
// audit record of recon_diff_balance_recalc naming the difference, the member, the reason and the
// cause (a negative frozen sum, a sum out of range, a cached value out of range: three causes); the
// bounds themselves are accepted and written. The wording of the cause is not pinned, only that the
// refusal is recorded and its causes differ. Entries no posting would write come from kit.ts
// rawVoucher; a frozen sum from a real WITHDRAW:FREEZE (APPROVED withdrawal).
// Audit values field by field (B2-02xb attempt 3; B2-02x r7 S2): the shape the implementation
// writes (recalcBalanceAuditRecord) — before {available_fen, frozen_fen} the cache read under the
// lock, after {…, available_fen, frozen_fen} the cache after the call, a refusal's sums as computed
// under a key naming the sums (entry_sums {available_fen, frozen_fen}); matched by key, not by name.
import { expect, it } from 'vitest';
import {
  DAY,
  EARLIER,
  RECALC_ACTION,
  auditLeaves,
  auditText,
  audits,
  cacheOf,
  entrySums,
  expectMentions,
  expectNoPersonalData,
  expectRecalcAudit,
  expectRecalculated,
  fixture,
  notApplicable,
  plainMember,
  rawVoucher,
  refusalCause,
  seedMismatch,
  seedWithdrawal,
  sideOf,
  suite,
  tamper,
  untouched,
  withRecalcAdmin,
  written,
  type AdjustFixture,
  type AuditRow,
  type Member,
  type RecalcAdmin,
  type Values,
} from './kit.ts';

const s = suite();

/** 2^53 − 1, the largest amount a response carries (Number.MAX_SAFE_INTEGER). */
const SAFE = 9_007_199_254_740_991n;
/** 2^53, one past it. */
const TWO_53 = SAFE + 1n;

type Field = 'available' | 'frozen';

/** The leaf key of a sub-account's value (available_fen / frozen_fen in the record). */
const FIELD: Readonly<Record<Field, RegExp>> = { available: /available/i, frozen: /frozen/i };
/** A path segment naming the entry sums of a refusal (entry_sums in the record). */
const SUMS = /sum/i;

function lastOf(path: readonly string[]): string {
  return path[path.length - 1] ?? '';
}

/** The values the record keeps under a key naming the entry sums, for the sub-account `field`. */
function sumLeaves(row: AuditRow, field: Field): string[] {
  return auditLeaves(row)
    .filter(
      (leaf) => leaf.path.some((seg) => SUMS.test(seg)) && FIELD[field].test(lastOf(leaf.path)),
    )
    .map((leaf) => leaf.value);
}

/**
 * The values the `side` part of the record keeps (outside the entry sums) for the sub-account
 * `field`: before is the cache read under the lock, after the cache as it stands after the call.
 */
function sideLeaves(row: AuditRow, side: 'before' | 'after', field: Field): string[] {
  return auditLeaves(row)
    .filter(
      (leaf) =>
        !leaf.path.some((seg) => SUMS.test(seg)) &&
        sideOf(leaf.path) === side &&
        FIELD[field].test(lastOf(leaf.path)),
    )
    .map((leaf) => leaf.value);
}

/**
 * Field by field: each given part of the record keeps exactly the given available and frozen
 * values, each under its own sub-account key (available and frozen swapped, a value only in a
 * note, or the sums and the cache swapped all fail).
 */
function expectFields(
  row: AuditRow,
  label: string,
  e: { readonly before?: Values; readonly after?: Values; readonly sums?: Values },
): void {
  const all = JSON.stringify([row.target, row.before, row.after]);
  for (const field of ['available', 'frozen'] as const) {
    if (e.before !== undefined) {
      expect(sideLeaves(row, 'before', field), `${label}：before.${field} ${all}`).toEqual([
        e.before[field].toString(),
      ]);
    }
    if (e.after !== undefined) {
      expect(sideLeaves(row, 'after', field), `${label}：after.${field} ${all}`).toEqual([
        e.after[field].toString(),
      ]);
    }
    if (e.sums !== undefined) {
      expect(sumLeaves(row, field), `${label}：分录合计 ${field} ${all}`).toEqual([
        e.sums[field].toString(),
      ]);
    }
  }
}

/**
 * One refused recalculation of the member's cache as it stands: 20001 [recon_diff_id]; the balance
 * row (values, version, negative_since) and everything else of the app untouched; exactly one more
 * recon_diff_balance_recalc record by the caller naming the difference, the member and the reason,
 * whose text carries every value of `shown` exactly, whose before part keeps the cache read under
 * the lock and whose entry sums keep the sums as computed, field by field (`kept`); the
 * record's cause (refusalCause), non-empty.
 */
async function expectRefused(
  f: AdjustFixture,
  h: RecalcAdmin,
  m: Member,
  reason: string,
  shown: readonly bigint[],
  kept: { readonly sums: Values; readonly cache: Values },
): Promise<string[]> {
  const cache = await cacheOf(f, m);
  const diff = await seedMismatch(f, m);
  const trace = await untouched(f);
  const count = (await audits(f, RECALC_ACTION)).length;
  await notApplicable(await h.recalc(diff.id, { reason }));
  expect(await cacheOf(f, m), `${reason}：余额行原样`).toEqual(cache);
  expect(await untouched(f), `${reason}：其余都不变`).toEqual(trace);
  const recorded = await audits(f, RECALC_ACTION);
  expect(recorded, `${reason}：拒绝写一条审计`).toHaveLength(count + 1);
  const row = recorded[recorded.length - 1]!;
  expect(row.admin_id).toBe(h.recon.id);
  expectMentions(row, { ids: [diff.id, m.userId], values: [reason] });
  const text = await auditText(f, row.id);
  for (const value of shown) {
    expect(text, `${reason}：审计含 ${value.toString()}`).toContain(value.toString());
  }
  expectFields(row, reason, { before: kept.cache, sums: kept.sums });
  const cause = refusalCause(row, { ids: [diff.id, m.userId], reason });
  expect(
    cause.length,
    `${reason}：审计记了拒绝原因 ${JSON.stringify([row.target, row.before, row.after])}`,
  ).toBeGreaterThan(0);
  expectNoPersonalData(row);
  return cause;
}

/** A refusal of the other cause for reference: entries available 1700 / frozen −700. */
async function negativeFrozenCause(f: AdjustFixture, h: RecalcAdmin): Promise<string[]> {
  const ref = await plainMember(f, 1000n);
  await rawVoucher(f, ref, [
    { sub_account: 'frozen', amount_fen: 700n },
    { sub_account: 'available', amount_fen: -700n },
  ]);
  expect(await entrySums(f, ref)).toEqual({ available: 1700n, frozen: -700n });
  await tamper(f, ref, { available: 100n, frozen: 0n, negativeSince: null });
  return expectRefused(f, h, ref, '参照：冻结合计为负', [1700n, -700n], {
    sums: { available: 1700n, frozen: -700n },
    cache: { available: 100n, frozen: 0n },
  });
}

it('[AC-B2-02xb#3] frozen 下调落库：缓存 available 300 / frozen 50、分录合计 300 / 0 → 成功 changed=true（before 300 / 50、after 300 / 0），读余额行 available_fen=300、frozen_fen=0、negative_since 为空、version 恰 +1，审计前后各记其值', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 300n);
    expect(await entrySums(f, m)).toEqual({ available: 300n, frozen: 0n });
    const cache = await tamper(f, m, { available: 300n, frozen: 50n, negativeSince: null });
    expect(cache.frozen_fen, '预置缓存 frozen 50').toBe(50n);
    const diff = await seedMismatch(f, m, {}, '06');

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '冻结下调' }), {
      m,
      before: { available: 300n, frozen: 50n },
      after: { available: 300n, frozen: 0n },
      changed: true,
    });
    const row = await cacheOf(f, m);
    expect(row.available_fen, '余额行 available_fen').toBe(300n);
    expect(row.frozen_fen, '余额行 frozen_fen 下调到分录合计 0').toBe(0n);
    expect(row.version, 'version 恰 +1').toBe(cache.version + 1n);
    expect(row).toEqual(written(cache, { available: 300n, frozen: 0n, negativeSince: null }));
    await expectRecalcAudit(f, {
      adminId: h.recon.id,
      diffId: diff.id,
      userId: m.userId,
      reason: '冻结下调',
      changed: true,
      before: { available: 300n, frozen: 50n },
      after: { available: 300n, frozen: 0n },
    });
  });
});

it('[AC-B2-02xb#4] available 与 frozen 同时下调：缓存 900 / 300、分录合计 500 / 100（已批提现单冻结 100）→ 成功 changed=true，读余额行 available_fen=500、frozen_fen=100、negative_since 为空、version 恰 +1', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 600n);
    await seedWithdrawal(f, m.userId, { status: 'APPROVED', amount: 100n });
    expect(await entrySums(f, m)).toEqual({ available: 500n, frozen: 100n });
    const cache = await tamper(f, m, { available: 900n, frozen: 300n, negativeSince: null });
    const diff = await seedMismatch(f, m);

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '两项下调' }), {
      m,
      before: { available: 900n, frozen: 300n },
      after: { available: 500n, frozen: 100n },
      changed: true,
    });
    const row = await cacheOf(f, m);
    expect(row.available_fen, '余额行 available_fen 下调到分录合计').toBe(500n);
    expect(row.frozen_fen, '余额行 frozen_fen 下调到分录合计').toBe(100n);
    expect(row.version, 'version 恰 +1').toBe(cache.version + 1n);
    expect(row).toEqual(written(cache, { available: 500n, frozen: 100n, negativeSince: null }));
  });
});

it('[AC-B2-02xb#5] 分录合计越 ±(2^53 − 1)：available 合计 2^53、available 合计 −2^53、frozen 合计 2^53（available 300）→ 各回 20001 [recon_diff_id]，余额行与 version 原样，每次一条拒绝审计（含精确合计；按字段：分录合计 available / frozen 记各自的精确合计，before available / frozen 记锁内缓存 100 / 0），原因与冻结合计为负的拒绝可区分', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const negative = await negativeFrozenCause(f, h);
    const cases = [
      {
        label: 'available 合计 2^53',
        start: 0n,
        sub: 'available',
        amount: -TWO_53,
        sums: { available: TWO_53, frozen: 0n },
        shown: TWO_53,
      },
      {
        label: 'available 合计 −2^53',
        start: 0n,
        sub: 'available',
        amount: TWO_53,
        sums: { available: -TWO_53, frozen: 0n },
        shown: -TWO_53,
      },
      {
        label: 'frozen 合计 2^53',
        start: 300n,
        sub: 'frozen',
        amount: -TWO_53,
        sums: { available: 300n, frozen: TWO_53 },
        shown: TWO_53,
      },
    ] as const;
    for (const c of cases) {
      const m = await plainMember(f, c.start);
      await rawVoucher(f, m, [{ sub_account: c.sub, amount_fen: c.amount }]);
      expect(await entrySums(f, m), c.label).toEqual(c.sums);
      await tamper(f, m, { available: 100n, frozen: 0n, negativeSince: null });
      const cause = await expectRefused(f, h, m, `越界 ${c.label}`, [c.shown], {
        sums: c.sums,
        cache: { available: 100n, frozen: 0n },
      });
      expect(cause, `${c.label}：与冻结为负的原因可区分`).not.toEqual(negative);
    }
  });
});

it('[AC-B2-02xb#6] 边界本身接受并写入：分录合计 available 2^53 − 1 / frozen 0、available −(2^53 − 1) / frozen 2^53 − 1 → 成功，余额行等于分录合计、version 恰 +1（跨到负数的 negative_since 为当日）；锁内缓存恰为 −(2^53 − 1) / 2^53 − 1 也接受，写成分录合计', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const top = await plainMember(f, 0n);
    await rawVoucher(f, top, [{ sub_account: 'available', amount_fen: -SAFE }]);
    expect(await entrySums(f, top)).toEqual({ available: SAFE, frozen: 0n });
    const topCache = await tamper(f, top, { available: 100n, frozen: 0n, negativeSince: null });
    const topDiff = await seedMismatch(f, top);
    await expectRecalculated(f, await h.recalc(topDiff.id, { reason: '上界' }), {
      m: top,
      before: { available: 100n, frozen: 0n },
      after: { available: SAFE, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, top), '上界写入').toEqual(
      written(topCache, { available: SAFE, frozen: 0n, negativeSince: null }),
    );

    const bottom = await plainMember(f, 0n);
    await rawVoucher(f, bottom, [
      { sub_account: 'available', amount_fen: SAFE },
      { sub_account: 'frozen', amount_fen: -SAFE },
    ]);
    expect(await entrySums(f, bottom)).toEqual({ available: -SAFE, frozen: SAFE });
    const bottomCache = await tamper(f, bottom, {
      available: 100n,
      frozen: 0n,
      negativeSince: null,
    });
    const bottomDiff = await seedMismatch(f, bottom);
    await expectRecalculated(f, await h.recalc(bottomDiff.id, { reason: '下界' }), {
      m: bottom,
      before: { available: 100n, frozen: 0n },
      after: { available: -SAFE, frozen: SAFE },
      changed: true,
    });
    expect(await cacheOf(f, bottom), '下界与 frozen 上界写入').toEqual(
      written(bottomCache, { available: -SAFE, frozen: SAFE, negativeSince: DAY }),
    );

    const cached = await plainMember(f, 300n);
    const edge = await tamper(f, cached, {
      available: -SAFE,
      frozen: SAFE,
      negativeSince: EARLIER,
    });
    const cachedDiff = await seedMismatch(f, cached);
    await expectRecalculated(f, await h.recalc(cachedDiff.id, { reason: '缓存在边界' }), {
      m: cached,
      before: { available: -SAFE, frozen: SAFE },
      after: { available: 300n, frozen: 0n },
      changed: true,
    });
    expect(await cacheOf(f, cached), '缓存在边界照常写成分录合计').toEqual(
      written(edge, { available: 300n, frozen: 0n, negativeSince: null }),
    );
  });
});

it('[AC-B2-02xb#7] 锁内缓存越 ±(2^53 − 1)（分录合计 300 / 0 在范围内）：缓存 available 2^53、available −2^53、frozen 2^53 → 各回 20001 [recon_diff_id]，余额行与 version 原样，每次一条拒绝审计（含缓存值；按字段：before available / frozen 记锁内缓存值、分录合计 available / frozen 记 300 / 0，与分录合计越界那条——分录合计记 2^53 / 0、before 记缓存 100 / 0——各记各的），原因与冻结合计为负、与分录合计越界的拒绝都可区分', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const negative = await negativeFrozenCause(f, h);
    const sumRef = await plainMember(f, 0n);
    await rawVoucher(f, sumRef, [{ sub_account: 'available', amount_fen: -TWO_53 }]);
    await tamper(f, sumRef, { available: 100n, frozen: 0n, negativeSince: null });
    expect(await entrySums(f, sumRef), '参照：分录合计越界').toEqual({
      available: TWO_53,
      frozen: 0n,
    });
    const sumOut = await expectRefused(f, h, sumRef, '参照：分录合计越界', [TWO_53], {
      sums: { available: TWO_53, frozen: 0n },
      cache: { available: 100n, frozen: 0n },
    });

    const cases = [
      {
        label: '缓存 available 2^53',
        cache: { available: TWO_53, frozen: 0n, negativeSince: null },
        shown: TWO_53,
      },
      {
        label: '缓存 available −2^53',
        cache: { available: -TWO_53, frozen: 0n, negativeSince: EARLIER },
        shown: -TWO_53,
      },
      {
        label: '缓存 frozen 2^53',
        cache: { available: 300n, frozen: TWO_53, negativeSince: null },
        shown: TWO_53,
      },
    ] as const;
    for (const c of cases) {
      const m = await plainMember(f, 300n);
      expect(await entrySums(f, m), c.label).toEqual({ available: 300n, frozen: 0n });
      await tamper(f, m, c.cache);
      const cause = await expectRefused(f, h, m, `越界 ${c.label}`, [c.shown], {
        sums: { available: 300n, frozen: 0n },
        cache: { available: c.cache.available, frozen: c.cache.frozen },
      });
      expect(cause, `${c.label}：与冻结合计为负的原因可区分`).not.toEqual(negative);
      expect(cause, `${c.label}：与分录合计越界的原因可区分`).not.toEqual(sumOut);
    }
  });
});

it('[AC-B2-02xb#8] 锁内缓存恰在正端点也接受：缓存 available 2^53 − 1 / frozen 0、缓存 available 300 / frozen 2^53 − 1，分录合计 300 / 0 → 各自成功 changed=true，读余额行 available_fen=300、frozen_fen=0、negative_since 为空、version 恰 +1；审计 before 按字段记缓存端点、after 按字段记 300 / 0（上限写成 >= 即红）', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const cases = [
      { label: '缓存 available 2^53 − 1', cache: { available: SAFE, frozen: 0n } },
      { label: '缓存 frozen 2^53 − 1', cache: { available: 300n, frozen: SAFE } },
    ] as const;
    const sums: Values = { available: 300n, frozen: 0n };
    for (const c of cases) {
      const m = await plainMember(f, 300n);
      expect(await entrySums(f, m), c.label).toEqual(sums);
      const cache = await tamper(f, m, { ...c.cache, negativeSince: null });
      expect(
        { available: cache.available_fen, frozen: cache.frozen_fen },
        `${c.label}：预置缓存`,
      ).toEqual(c.cache);
      const diff = await seedMismatch(f, m);

      await expectRecalculated(f, await h.recalc(diff.id, { reason: c.label }), {
        m,
        before: c.cache,
        after: sums,
        changed: true,
      });
      const row = await cacheOf(f, m);
      expect(row.available_fen, `${c.label}：余额行 available_fen`).toBe(300n);
      expect(row.frozen_fen, `${c.label}：余额行 frozen_fen`).toBe(0n);
      expect(row.version, `${c.label}：version 恰 +1`).toBe(cache.version + 1n);
      expect(row, c.label).toEqual(written(cache, { ...sums, negativeSince: null }));
      const audit = await expectRecalcAudit(f, {
        adminId: h.recon.id,
        diffId: diff.id,
        userId: m.userId,
        reason: c.label,
        changed: true,
        before: c.cache,
        after: sums,
      });
      expectFields(audit, c.label, { before: c.cache, after: sums });
    }
  });
});

it('[AC-B2-02xb#9] 成功审计按子户字段记前后值：缓存 available 2600 / frozen 400、分录合计 available 2000 / frozen 1000（已批提现单冻结 1000）→ 成功 changed=true，读余额行 2000 / 1000、version 恰 +1；审计 before.available=2600、before.frozen=400、after.available=2000、after.frozen=1000 逐字段断言（可提现与冻结互换即红）', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 3000n);
    await seedWithdrawal(f, m.userId, { status: 'APPROVED', amount: 1000n });
    const sums: Values = { available: 2000n, frozen: 1000n };
    expect(await entrySums(f, m)).toEqual(sums);
    const before: Values = { available: 2600n, frozen: 400n };
    const cache = await tamper(f, m, { ...before, negativeSince: null });
    const diff = await seedMismatch(f, m);

    await expectRecalculated(f, await h.recalc(diff.id, { reason: '子户字段' }), {
      m,
      before,
      after: sums,
      changed: true,
    });
    expect(await cacheOf(f, m)).toEqual(written(cache, { ...sums, negativeSince: null }));
    const audit = await expectRecalcAudit(f, {
      adminId: h.recon.id,
      diffId: diff.id,
      userId: m.userId,
      reason: '子户字段',
      changed: true,
      before,
      after: sums,
    });
    expectFields(audit, '子户字段', { before, after: sums });
  });
});
