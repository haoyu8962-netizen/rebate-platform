// B2-02ze (claude-independent, SPEC_REF d49d8aa5): 08 BR-ID-33 on the free text of
// writeOffAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/write-off, body `note`, audit
// recon_diff_write_off) through the real admin entry (../../ledger/admin-recon-write-off/kit.ts:
// payout.execute, totp step-up, Idempotency-Key). Task brief §9.1 #1, #3, #4. Top-level it() only.
import { expect, it } from 'vitest';
import {
  BODY,
  WRITE_OFF_ACTION,
  audits,
  fixture,
  seedCase,
  suite,
  withWriteOffAdmin,
  writtenOff,
} from '../../ledger/admin-recon-write-off/kit.ts';
import { expectRedacted, sampleB } from './kit.ts';

const s = suite();

it('[AC-B2-02ze#2] 差错核销的备注里写了带加号与子域的邮箱、校验位正确的 18 位纯数字身份证、日期合法的 15 位老身份证、连字符分组且过 Luhn 的卡号、手机号：核销照常成功，recon_diff_write_off 审计全文不含任何一项明文；备注仍在（说明文字保留，邮箱 @ 前整段遮成 ***@mail.corp.example.cn、手机 139****1111、两种证件都只留首末各 1 位、卡号只露末 4 位；校验位错的 18 位号与日期不合法的 15 位号按兜底只留末四位，B2-02zg D10-3266）；结构化的提现单号与状态原样', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const sample = sampleB('乙');
    const sent = await h.writeOff(c.diff.id, { ...BODY, note: sample.text });
    expect((await writtenOff(sent)).released_hold_count).toBe(1);

    const rows = (await audits(f, WRITE_OFF_ACTION)).filter((row) => row.target === c.diff.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expectRedacted(row, sample);
    expect(row.before).toMatchObject({ withdrawal_id: c.w.id, withdrawal_status: 'APPROVED' });
    expect(row.after).toMatchObject({ withdrawal_id: c.w.id, status: 'written_off' });
  });
});
