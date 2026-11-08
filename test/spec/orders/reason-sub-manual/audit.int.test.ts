// B1-09v: the audit record of an accepted punish upload (rights_import_create, one for the whole
// file) carries the reason_sub part as sent (`none` as is), next to what it already had; it carries
// no personal information and nothing of the file's cells (sub-order numbers, 违规单号). Real admin
// entry, permissions and PostgreSQL. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ANSWER,
  CLAIM,
  IMPORT_AUDIT,
  NONE,
  accepted,
  attributedOrder,
  auditsOf,
  jsonOf,
  punishFields,
  setup,
  upload,
} from './kit.ts';

const h = useHarness();

it.each(['FAKE_TRADE', 'PUNISH_ORDER', NONE])(
  '[AC-B1-09v#6] 违规单导入带 reason_sub=%s 受理后：审计 rights_import_create 恰一条，after.reason_sub 为所选原值（none 原样），仍带 kind / platform，不含子订单号、违规单号与用户信息',
  async (value) => {
    const s = await setup(h, { grants: CLAIM });
    const order = await attributedOrder(s);

    const created = await accepted<{ import_id: string }>(
      await upload(s, punishFields('jd', value), order.sub_order_id),
      ANSWER.punish,
    );

    const audits = await auditsOf(s, IMPORT_AUDIT);
    expect(audits.map((row) => [row.target, row.admin_id])).toEqual([
      [`rights_imports:${created.import_id}`, s.admin.id],
    ]);
    const after = jsonOf(audits[0]?.after);
    expect(after).toMatchObject({ kind: 'punish', platform: 'jd', reason_sub: value });
    const text = JSON.stringify([audits[0]?.before ?? null, audits[0]?.after ?? null]);
    for (const secret of [order.sub_order_id, order.parent_order_id, 'PN-1', s.userId]) {
      expect(text).not.toContain(String(secret));
    }
  },
  120_000,
);
