// B2-02ze (claude-independent, SPEC_REF d49d8aa5): 08 BR-ID-33 on the free text of
// recalcBalanceAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc, body
// `reason`, audit recon_diff_balance_recalc) through the real admin entry
// (../../ledger/admin-recon-balance-recalc/kit.ts: fund.recon, sms step-up). The amounts are
// 13-digit, one negative: structured *_fen values must come through as they are (task brief §9.1 #3,
// D10-2315 (a)). Top-level it() only.
import { expect, it } from 'vitest';
import {
  EARLIER,
  RECALC_ACTION,
  audits,
  expectRecalculated,
  fixture,
  plainMember,
  seedMismatch,
  suite,
  tamper,
  withRecalcAdmin,
} from '../../ledger/admin-recon-balance-recalc/kit.ts';
import { expectRedacted, leafValues, sampleB } from './kit.ts';

const s = suite();

/** A 13-digit amount in fen (not a phone, not a card: a structured *_fen value). */
const BIG = 1_234_567_890_123n;

it('[AC-B2-02ze#6] 余额重算的原因里写了带加号与子域的邮箱、校验位正确的 18 位纯数字身份证、日期合法的 15 位老身份证、连字符分组且过 Luhn 的卡号、手机号：重算照常成功，recon_diff_balance_recalc 审计全文不含任何一项明文；原因仍在（说明文字保留，邮箱 @ 前整段遮成 ***@mail.corp.example.cn、手机 139****1111、两种证件都只留首末各 1 位、卡号只露末 4 位；校验位错的 18 位号与日期不合法的 15 位号按兜底只留末四位，B2-02zg D10-3266）；13 位金额（含负数）、差错单与会员 id 原样', async () => {
  const f = fixture(s);
  await withRecalcAdmin(f, async (h) => {
    const m = await plainMember(f, BIG);
    await tamper(f, m, { available: -BIG, frozen: 0n, negativeSince: EARLIER });
    const diff = await seedMismatch(f, m);
    const sample = sampleB('己');
    await expectRecalculated(f, await h.recalc(diff.id, { reason: sample.text }), {
      m,
      before: { available: -BIG, frozen: 0n },
      after: { available: BIG, frozen: 0n },
      changed: true,
    });

    const rows = await audits(f, RECALC_ACTION);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expectRedacted(row, sample);
    const values = leafValues(row);
    expect(values, '13 位金额原样').toContain(String(BIG));
    expect(values, '13 位负金额原样').toContain(String(-BIG));
    expect(
      values.some((value) => value.includes(diff.id)),
      '差错单 id 原样',
    ).toBe(true);
    expect(
      values.some((value) => value.includes(m.userId)),
      '会员 id 原样',
    ).toBe(true);
  });
});
