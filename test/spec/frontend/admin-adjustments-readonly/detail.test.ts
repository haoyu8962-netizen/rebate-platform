// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENT_ORDER,
  ADMIN,
  COLUMN,
  DIRECTION_NAME,
  DOC,
  FIELD,
  FIELD_LABELS,
  NOTE,
  REF_TYPE_NAME,
  SUBJECT_NAME,
  TEXT,
  USER,
  VIEW_GRANTS,
  VOUCHER,
  adjustmentPath,
  createServer,
  reasonName,
  rejected,
  statusName,
  unavailable,
  yuan,
} from './fixtures.ts';
import {
  button,
  click,
  detailDrawers,
  drawer,
  fieldNode,
  fieldValue,
  fields,
  hasText,
  mount,
  openDetail,
  panel,
  refRows,
  rowWith,
  settled,
  waitColumn,
} from './helpers.ts';

// adminGetAdjustment: { adjustment, balance_preview }. The drawer shows the form's items (labels in
// fixtures.ts FIELD; a null value is 「—」, 创建人 null is 「系统」, times in Beijing time), its
// linked documents (单据类型 by the enum names, 单据号 as given: an order shows its order_key), the
// 「已红冲」 mark when reversed_by_adjust_id is set, and 红冲单 as a link that opens that form.

it(
  '[AC-F1-08ca-DETAIL#1] 已被红冲的打款追回单：【详情】只发 GET /admin/v1/adjustments/{adjust_id}（无查询参数），抽屉「调账单详情」逐项显示单号、用户、方向、金额、原因、状态、对方科目、说明、凭证、原调账单、红冲单、创建与审核、驳回原因，关联单据两行，并有「已红冲」标记',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const sheet = await openDetail(server, ADJ.recovery);
    expect(server.detailReads(ADJ.recovery).map((read) => read.query)).toEqual([{}]);
    expect(server.requestsUnder(adjustmentPath(ADJ.recovery))).toHaveLength(1);
    expect(fields(sheet, FIELD_LABELS)).toEqual({
      [FIELD.id]: ADJ.recovery,
      [FIELD.user]: USER.payee,
      [FIELD.direction]: DIRECTION_NAME.decrease,
      [FIELD.amount]: yuan(10000),
      [FIELD.reason]: reasonName('PAYOUT_RECOVERY'),
      [FIELD.status]: statusName('APPROVED'),
      [FIELD.subject]: SUBJECT_NAME.CASH_ALIPAY,
      [FIELD.note]: NOTE.recovery,
      [FIELD.voucher]: VOUCHER.recovery,
      [FIELD.reverses]: TEXT.dash,
      [FIELD.reversedBy]: ADJ.reversal,
      [FIELD.creator]: ADMIN.first,
      [FIELD.created]: '2026-11-30 10:30:00',
      [FIELD.reviewer]: ADMIN.first,
      [FIELD.reviewed]: '2026-11-30 10:30:00',
      [FIELD.rejectNote]: TEXT.dash,
    });
    expect(refRows(sheet)).toEqual([
      [REF_TYPE_NAME.withdrawal, DOC.withdrawal],
      [REF_TYPE_NAME.recon_diff, DOC.payoutDiff],
    ]);
    expect(hasText(sheet, TEXT.reversed)).toBe(true);
  },
);

it(
  '[AC-F1-08ca-DETAIL#2] 红冲单号是链接：点开读红冲单，同一个抽屉改为显示红冲单（调增、原调账单指向原单、红冲单「—」、无关联单据），不再有「已红冲」标记',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const sheet = await openDetail(server, ADJ.recovery);
    await click(button(fieldNode(sheet, FIELD.reversedBy), ADJ.reversal));
    await waitFor(() => expect(server.detailReads(ADJ.reversal)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(fieldValue(drawer(), FIELD.id)).toBe(ADJ.reversal));
    expect(detailDrawers()).toHaveLength(1);
    expect(fields(drawer(), FIELD_LABELS)).toEqual({
      [FIELD.id]: ADJ.reversal,
      [FIELD.user]: USER.payee,
      [FIELD.direction]: DIRECTION_NAME.increase,
      [FIELD.amount]: yuan(10000),
      [FIELD.reason]: reasonName('PAYOUT_RECOVERY'),
      [FIELD.status]: statusName('APPROVED'),
      [FIELD.subject]: SUBJECT_NAME.CASH_ALIPAY,
      [FIELD.note]: NOTE.reversal,
      [FIELD.voucher]: VOUCHER.reversal,
      [FIELD.reverses]: ADJ.recovery,
      [FIELD.reversedBy]: TEXT.dash,
      [FIELD.creator]: ADMIN.second,
      [FIELD.created]: '2026-11-30 16:45:10',
      [FIELD.reviewer]: ADMIN.second,
      [FIELD.reviewed]: '2026-11-30 16:45:10',
      [FIELD.rejectNote]: TEXT.dash,
    });
    expect(refRows(drawer())).toEqual([]);
    expect(hasText(drawer(), TEXT.noRefs)).toBe(true);
    expect(hasText(drawer(), TEXT.reversed)).toBe(false);
  },
);

it(
  '[AC-F1-08ca-DETAIL#3] 系统预填的注销单（PENDING，金额与创建人为空）与已驳回的注销单：金额「—」、创建人「系统」、对方科目「佣金收入」，驳回单显示审核人、审核时间与驳回原因；关联单据为注销单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const pending = await openDetail(server, ADJ.prefilled);
    expect(fields(pending, FIELD_LABELS)).toEqual({
      [FIELD.id]: ADJ.prefilled,
      [FIELD.user]: USER.deleting,
      [FIELD.direction]: DIRECTION_NAME.decrease,
      [FIELD.amount]: TEXT.dash,
      [FIELD.reason]: reasonName('ACCOUNT_CLOSED'),
      [FIELD.status]: statusName('PENDING'),
      [FIELD.subject]: SUBJECT_NAME.COMMISSION_REVENUE,
      [FIELD.note]: TEXT.dash,
      [FIELD.voucher]: TEXT.dash,
      [FIELD.reverses]: TEXT.dash,
      [FIELD.reversedBy]: TEXT.dash,
      [FIELD.creator]: TEXT.system,
      [FIELD.created]: '2026-12-01 02:00:00',
      [FIELD.reviewer]: TEXT.dash,
      [FIELD.reviewed]: TEXT.dash,
      [FIELD.rejectNote]: TEXT.dash,
    });
    expect(refRows(pending)).toEqual([[REF_TYPE_NAME.account_deletion, DOC.deletionPending]]);
    expect(hasText(pending, TEXT.reversed)).toBe(false);

    const refused = await openDetail(server, ADJ.rejected);
    expect(fields(refused, FIELD_LABELS)).toEqual({
      [FIELD.id]: ADJ.rejected,
      [FIELD.user]: USER.retracted,
      [FIELD.direction]: DIRECTION_NAME.decrease,
      [FIELD.amount]: TEXT.dash,
      [FIELD.reason]: reasonName('ACCOUNT_CLOSED'),
      [FIELD.status]: statusName('REJECTED'),
      [FIELD.subject]: SUBJECT_NAME.COMMISSION_REVENUE,
      [FIELD.note]: TEXT.dash,
      [FIELD.voucher]: TEXT.dash,
      [FIELD.reverses]: TEXT.dash,
      [FIELD.reversedBy]: TEXT.dash,
      [FIELD.creator]: TEXT.system,
      [FIELD.created]: '2026-11-20 02:00:00',
      [FIELD.reviewer]: ADMIN.first,
      [FIELD.reviewed]: '2026-11-21 09:15:00',
      [FIELD.rejectNote]: NOTE.rejectNote,
    });
    expect(refRows(refused)).toEqual([[REF_TYPE_NAME.account_deletion, DOC.deletionRejected]]);
  },
);

it(
  '[AC-F1-08ca-DETAIL#4] 关联单据按返回顺序逐行：订单恢复单显示「子订单」+ order_key 原样、「差错单」+ 差错单 id；OTHER 单对方科目「营销费用」，说明代替单据（refs 为空）时显示「无关联单据」',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const restore = await openDetail(server, ADJ.restore);
    expect(refRows(restore)).toEqual([
      [REF_TYPE_NAME.order, DOC.order],
      [REF_TYPE_NAME.recon_diff, DOC.restoreDiff],
    ]);
    expect(fields(restore, [FIELD.amount, FIELD.subject, FIELD.note])).toEqual({
      [FIELD.amount]: yuan(2000),
      [FIELD.subject]: SUBJECT_NAME.COMMISSION_REVENUE,
      [FIELD.note]: NOTE.restore,
    });

    const other = await openDetail(server, ADJ.otherNote);
    expect(fields(other, [FIELD.amount, FIELD.subject, FIELD.note])).toEqual({
      [FIELD.amount]: yuan(5),
      [FIELD.subject]: SUBJECT_NAME.MKT_EXPENSE,
      [FIELD.note]: NOTE.otherNote,
    });
    expect(refRows(other)).toEqual([]);
    expect(hasText(other, TEXT.noRefs)).toBe(true);
  },
);

it(
  '[AC-F1-08ca-DETAIL#5] 详情返回 20001（data.fields=[adjust_id]，契约无 404）：抽屉内显示「调账单不存在或已不可见」，不显示该单的项目；列表照旧',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    server.once('GET', adjustmentPath(ADJ.reconFix), () => rejected(['adjust_id']));
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const row = rowWith(panel(), COLUMN.id, ADJ.reconFix);
    await click(button(row.element, TEXT.detailEntry));
    await waitFor(() => expect(server.detailReads(ADJ.reconFix)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(hasText(drawer(), TEXT.detailMissing)).toBe(true));
    expect(hasText(drawer(), FIELD.subject)).toBe(false);
    expect(hasText(drawer(), FIELD.voucher)).toBe(false);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  },
);

it(
  '[AC-F1-08ca-DETAIL#6] 详情读取失败（50001）：抽屉内显示「调账单读取失败」与【重试】，重试再读一次后显示该单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    server.once('GET', adjustmentPath(ADJ.reconFix), unavailable);
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const row = rowWith(panel(), COLUMN.id, ADJ.reconFix);
    await click(button(row.element, TEXT.detailEntry));
    await waitFor(() => expect(server.detailReads(ADJ.reconFix)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(hasText(drawer(), TEXT.detailFailed)).toBe(true));
    await click(button(drawer(), TEXT.retry));
    await waitFor(() => expect(server.detailReads(ADJ.reconFix)).toHaveLength(2));
    await settled(server);
    await waitFor(() => expect(fieldValue(drawer(), FIELD.id)).toBe(ADJ.reconFix));
    expect(fields(drawer(), [FIELD.amount, FIELD.created])).toEqual({
      [FIELD.amount]: yuan(123456789),
      [FIELD.created]: '2026-11-29 00:05:00',
    });
    expect(hasText(drawer(), TEXT.detailFailed)).toBe(false);
  },
);
