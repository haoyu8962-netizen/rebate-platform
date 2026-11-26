// B2-02ze (claude-independent, SPEC_REF d49d8aa5): 08 BR-ID-33 on the free text of
// closeAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/close, body `reason`, audit
// recon_diff_close) through the real admin entry (../../ledger/admin-recon-close/kit.ts). Task brief
// §9.1 #1, #3. Top-level it() only.
import { expect, it } from 'vitest';
import {
  CLOSE_ACTION,
  audits,
  closed,
  fixture,
  seedDiff,
  suite,
  withCloseAdmin,
} from '../../ledger/admin-recon-close/kit.ts';
import { expectRedacted, sampleA } from './kit.ts';

const s = suite();

it('[AC-B2-02ze#1] 关差错单的原因里写了邮箱、18 位身份证（末位 X）、空格分组且过 Luhn 的银行卡号、手机号：关闭照常成功，recon_diff_close 审计的 before / after 全文不含任何一项明文；原因仍在（说明文字保留，邮箱 al***@example.com、手机 138****5678、证件 1****************X、卡号只露末 4 位；同长同分组但不过 Luhn 的对照号按兜底也只留末四位，B2-02zg D10-3266）；差错单 id、状态与解冻数原样', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await seedDiff(f, {
      source: 'R3',
      type: 'ledger_mismatch',
      period: '2026-10-28',
      ref_type: 'account',
    });
    const sample = sampleA('甲');
    await closed(await h.close(diff.id, { reason: sample.text }));

    const rows = await audits(f, CLOSE_ACTION);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expectRedacted(row, sample);
    // Structured parts are not free text: kept as they are.
    expect(row.target).toBe(diff.id);
    expect(row.before).toMatchObject({ status: 'open', released_hold_count: 0 });
    expect(row.after).toMatchObject({ status: 'closed', released_hold_count: 0 });
  });
});
