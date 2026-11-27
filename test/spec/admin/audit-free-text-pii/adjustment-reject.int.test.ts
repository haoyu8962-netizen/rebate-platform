// B2-02ze (claude-independent, SPEC_REF d49d8aa5): 08 BR-ID-33 on the free text of the adjustment
// rejection, adminRejectAdjustment (POST /admin/v1/adjustments/{adjust_id}/reject, body `reason`,
// audit adjustment_reject) through the real admin entry
// (../../ledger/admin-adjustments-closing/kit.ts: fund.adjust, no step-up, Idempotency-Key) on the
// system-prefilled ACCOUNT_CLOSED form of a member in deletion. Task brief §9.1 #1, #3.
// Top-level it() only.
import { expect, it } from 'vitest';
import {
  REJECT_ACTION,
  TIMEOUT,
  answer,
  audits,
  fixture,
  formNow,
  member,
  seedPrefill,
  seedRequest,
  suite,
  withClosingAdmin,
} from '../../ledger/admin-adjustments-closing/kit.ts';
import { expectRedacted, serialized, sampleA } from './kit.ts';

const s = suite();

it(
  '[AC-B2-02ze#5] 调账驳回的原因里写了邮箱、18 位身份证（末位 X）、空格分组且过 Luhn 的银行卡号、手机号：驳回照常成功，adjustment_reject 审计全文不含任何一项明文；原因仍在（说明文字保留，邮箱 @ 前整段遮成 ***@example.com、手机 138****5678、证件 1****************X、卡号只露末 4 位；同长同分组但不过 Luhn 的对照号按兜底也只留末四位，B2-02zg D10-3266）；调账单与会员 id 原样',
  async () => {
    const f = fixture(s);
    await withClosingAdmin(f, async (h) => {
      const userId = await member(f, { available: 1200n, status: 'deleting' });
      const request = await seedRequest(f, userId);
      const form = await seedPrefill(f, userId, {
        refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
      });
      const sample = sampleA('戊');
      await answer(await h.reject(form.adjust_id, { reason: sample.text }), 0);
      expect((await formNow(f, form.adjust_id))?.status).toBe('REJECTED');

      const rows = (await audits(f, REJECT_ACTION)).filter((row) =>
        serialized(row).includes(form.adjust_id),
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expectRedacted(row, sample);
      expect(serialized(row)).toContain(userId);
    });
  },
  TIMEOUT,
);
