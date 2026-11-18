// B2-02x sums that cannot be a balance (claude-independent, SPEC_REF ba6655b1):
// recalcBalanceAdminReconDiff (CT-24zzna, D10-2032 ②) — under the locks, a negative frozen sum or an
// available / frozen sum outside the PostgreSQL bigint range (−2^63 … 2^63 − 1) → 20001
// data.fields=[recon_diff_id] (no data.reason); the account_balances row is not written
// (available_fen, frozen_fen, version and negative_since all stay); one audit record of action
// recon_diff_balance_recalc with the difference, the member, the trimmed reason, the cause and the
// sums as computed is committed; the difference is not closed, no hold is released, no event.
// Such entries are written directly (kit.ts rawVoucher): no posting would produce them.
import { expect, it } from 'vitest';
import {
  BIGINT_MAX,
  EARLIER,
  RECALC_ACTION,
  auditText,
  audits,
  cacheOf,
  entrySums,
  expectMentions,
  expectNoPersonalData,
  fixture,
  notApplicable,
  plainMember,
  rawVoucher,
  seedHold,
  seedMismatch,
  suite,
  tamper,
  untouched,
  withRecalcAdmin,
  type AdjustFixture,
  type Member,
} from './kit.ts';

const s = suite();

/** The one refusal record: caller, difference, member, reason and every computed sum (exact). */
async function expectRefusalAudit(
  f: AdjustFixture,
  e: {
    readonly adminId: string;
    readonly diffId: string;
    readonly m: Member;
    readonly reason: string;
    readonly sums: readonly bigint[];
  },
): Promise<void> {
  const recorded = await audits(f, RECALC_ACTION);
  expect(recorded, '拒绝也写一条审计').toHaveLength(1);
  const row = recorded[0]!;
  expect(row.admin_id).toBe(e.adminId);
  expectMentions(row, { ids: [e.diffId, e.m.userId], values: [e.reason] });
  const text = await auditText(f, row.id);
  for (const sum of e.sums) {
    expect(text, `算出的合计 ${sum} 记入审计`).toContain(sum.toString());
  }
  expectNoPersonalData(row);
}

it('[AC-B2-02x#30] frozen 合计为负：分录 available 1700 / frozen −700 → 20001 data.fields=[recon_diff_id]，余额行（含 version、negative_since）原样，审计记差错单、会员、原因与算出的合计；差错单不关、冻结记录不解除、没有事件', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, 1000n);
    await rawVoucher(f, m, [
      { sub_account: 'frozen', amount_fen: 700n },
      { sub_account: 'available', amount_fen: -700n },
    ]);
    expect(await entrySums(f, m)).toEqual({ available: 1700n, frozen: -700n });
    const cache = await tamper(f, m, { available: -20n, frozen: 0n, negativeSince: EARLIER });
    const diff = await seedMismatch(f, m);
    await seedHold(f, {
      user_id: m.userId,
      reason: 'ledger_mismatch',
      source_ref: `recon_diff:${diff.id}`,
      created_by: 'system',
    });
    const trace = await untouched(f);

    await notApplicable(await h.recalc(diff.id, { reason: '  冻结合计为负  ' }));
    expect(await cacheOf(f, m), '余额行与 version 都没变').toEqual(cache);
    expect(await untouched(f), '差错单、冻结记录、凭证、分录、事件都不变').toEqual(trace);
    await expectRefusalAudit(f, {
      adminId: h.recon.id,
      diffId: diff.id,
      m,
      reason: '冻结合计为负',
      sums: [1700n, -700n],
    });
  });
});

it('[AC-B2-02x#31] 合计超出 bigint：available 合计 300 + 2·(2^63 − 1)、available 合计 300 − 2·(2^63 − 1)、frozen 合计 2·(2^63 − 1) → 各回 20001 [recon_diff_id]，余额行（含 version、negative_since）原样，每次一条审计，文本含精确合计', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const cases = [
      { sub: 'available', sign: -1n, sum: 300n + 2n * BIGINT_MAX },
      { sub: 'available', sign: 1n, sum: 300n - 2n * BIGINT_MAX },
      { sub: 'frozen', sign: -1n, sum: 2n * BIGINT_MAX },
    ] as const;
    let count = 0;
    for (const c of cases) {
      const m = await plainMember(f, 300n);
      for (let i = 0; i < 2; i += 1) {
        await rawVoucher(f, m, [{ sub_account: c.sub, amount_fen: c.sign * BIGINT_MAX }]);
      }
      const sums = await entrySums(f, m);
      expect(c.sub === 'available' ? sums.available : sums.frozen).toBe(c.sum);
      const cache = await tamper(f, m, { available: -5n, frozen: 0n, negativeSince: EARLIER });
      const diff = await seedMismatch(f, m);
      const trace = await untouched(f);
      await notApplicable(await h.recalc(diff.id, { reason: `越界 ${c.sub}` }));
      count += 1;
      expect(await cacheOf(f, m), `${c.sub} ${c.sign}`).toEqual(cache);
      expect(await untouched(f)).toEqual(trace);
      const recorded = await audits(f, RECALC_ACTION);
      expect(recorded, '每次拒绝一条审计').toHaveLength(count);
      const row = recorded[recorded.length - 1]!;
      expect(row.admin_id).toBe(h.recon.id);
      expectMentions(row, { ids: [diff.id, m.userId], values: [`越界 ${c.sub}`] });
      expect(await auditText(f, row.id)).toContain(c.sum.toString());
      expectNoPersonalData(row);
    }
  });
});
