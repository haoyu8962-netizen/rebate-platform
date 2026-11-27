// B2-02ze (claude-independent, SPEC_REF d49d8aa5): 08 BR-ID-33 on the free text of the withdrawal
// review's rejection, adminRejectWithdrawal (POST /admin/v1/withdrawals/{withdrawal_id}/reject,
// body `note`, audit withdrawal_reject) through the real admin entry
// (../../payout/admin-withdrawal-review/review-harness.ts: withdraw.review, totp step-up,
// Idempotency-Key). Task brief §9.1 #1, #3, #4. Top-level it() only.
import { expect, it } from 'vitest';
import {
  REJECT_ACTION,
  audits,
  fixture,
  member,
  rejectBody,
  rejectedBy,
  seedReview,
  suite,
  withReviewAdmin,
} from '../../payout/admin-withdrawal-review/review-harness.ts';
import { expectRedacted, sampleB } from './kit.ts';

const s = suite();

it('[AC-B2-02ze#4] 提现驳回的备注里写了带加号与子域的邮箱、校验位正确的 18 位纯数字身份证、日期合法的 15 位老身份证、连字符分组且过 Luhn 的卡号、手机号：驳回照常成功，withdrawal_reject 审计全文不含任何一项明文；备注仍在（说明文字保留，邮箱 @ 前整段遮成 ***@mail.corp.example.cn、手机 139****1111、两种证件都只留首末各 1 位、卡号只露末 4 位；校验位错的 18 位号与日期不合法的 15 位号按兜底只留末四位，B2-02zg D10-3266）；提现单 id、状态与原因码原样', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const row = await seedReview(f, h, who);
    const sample = sampleB('丁');
    await rejectedBy(
      f,
      await h.reject(row.id, rejectBody({ note: sample.text })),
      row,
      h.reviewer.id,
      'PAYEE_INFO_INVALID',
    );

    const rows = (await audits(f, REJECT_ACTION)).filter((audit) => audit.target === row.id);
    expect(rows).toHaveLength(1);
    const audit = rows[0]!;
    expectRedacted(audit, sample);
    expect(audit.before).toMatchObject({ withdrawal_id: row.id, status: 'PENDING_REVIEW' });
    expect(audit.after).toMatchObject({
      withdrawal_id: row.id,
      status: 'REJECTED',
      reason_code: 'PAYEE_INFO_INVALID',
    });
  });
});
