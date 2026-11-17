// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  ADMIN,
  BALANCE,
  BALANCE_LABELS,
  COLUMN,
  DIRECTION_NAME,
  DOC,
  ERROR,
  FIELD,
  LABEL,
  READ_TEXT,
  REASON,
  REF_TYPE_NAME,
  SECOND,
  SECOND_AVAILABLE,
  SECOND_USER,
  SUBJECT_NAME,
  SUMMARY,
  SUMMARY_LABELS,
  TEXT,
  USER,
  createApproveServer,
  passOf,
  reasonName,
  secondPending,
  statusName,
  yuan,
} from './fixtures.ts';
import {
  approveDialog,
  approveWithSms,
  assertApproval,
  assertRejection,
  buttons,
  dialogsTitled,
  drawer,
  fieldValue,
  fields,
  hasText,
  idemOf,
  nonReadsSince,
  openApprove,
  openDetail,
  panel,
  pick,
  ready,
  refRows,
  rejectOnce,
  rowApprove,
  rowOf,
  rowWith,
  settled,
  shows,
  stepUpDialogs,
  textbox,
  typeReason,
  usable,
  waitColumn,
} from './helpers.ts';

const ROW_TITLES = [COLUMN.direction, COLUMN.amount, COLUMN.reason, COLUMN.status];

/** The list row of `adjustId` after a decision, by direction / amount / reason / status. */
function decidedRow(adjustId: string, amount: string, code: string): void {
  expect(pick(rowWith(panel(), COLUMN.id, adjustId), ROW_TITLES)).toEqual({
    [COLUMN.direction]: DIRECTION_NAME.decrease,
    [COLUMN.amount]: amount,
    [COLUMN.reason]: reasonName('ACCOUNT_CLOSED'),
    [COLUMN.status]: statusName(code),
  });
}

it(
  '[AC-F1-08cc-APPROVE#1] 行上【批准】打开「批准调账单」：单据摘要（单号、用户、调减、注销放弃余额、佣金收入、系统、创建时间）、关联注销单、余额前后预览（¥20.00 → ¥0.00）与「实际金额以批准时余额为准」、后果说明；唯一输入是「驳回原因」，没有金额等可改项；有可用的【取消】【驳回】【批准并短信验证】；打开不发写请求、不弹验证',
  { timeout: 60_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const since = server.log.length;
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    expect(fields(dialog, SUMMARY_LABELS)).toEqual({
      [SUMMARY.id]: ADJ.prefilled,
      [SUMMARY.user]: USER.deleting,
      [SUMMARY.direction]: DIRECTION_NAME.decrease,
      [SUMMARY.reason]: reasonName('ACCOUNT_CLOSED'),
      [SUMMARY.subject]: SUBJECT_NAME.COMMISSION_REVENUE,
      [SUMMARY.creator]: READ_TEXT.system,
      [SUMMARY.created]: '2026-12-01 02:00:00',
    });
    expect(refRows(dialog)).toEqual([[REF_TYPE_NAME.account_deletion, DOC.deletionPending]]);
    await waitFor(() =>
      expect(fields(dialog, BALANCE_LABELS)).toEqual({
        [BALANCE.before]: yuan(2000),
        [BALANCE.amount]: yuan(2000),
        [BALANCE.after]: yuan(0),
      }),
    );
    expect(hasText(dialog, TEXT.actualAmount)).toBe(true);
    expect(hasText(dialog, TEXT.consequence)).toBe(true);

    const inputs = within(dialog).queryAllByRole('textbox');
    expect(inputs).toEqual([textbox(dialog, LABEL.rejectReason)]);
    expect(within(dialog).queryAllByRole('spinbutton')).toEqual([]);
    expect(within(dialog).queryAllByRole('combobox')).toEqual([]);
    expect(within(dialog).queryAllByRole('radio')).toEqual([]);
    expect(within(dialog).queryAllByRole('checkbox')).toEqual([]);
    for (const name of [TEXT.cancel, TEXT.reject, TEXT.approve]) {
      expect(usable(dialog, name), name).toHaveLength(1);
      expect(buttons(dialog, name), name).toHaveLength(1);
    }
    expect(stepUpDialogs()).toEqual([]);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-APPROVE#2] 行上【批准并短信验证】：先发验证码、短信验证通过后只发一次 POST …/approve，请求体恰为 {}（不带金额），带 X-Step-Up-Token 与 Idempotency-Key；成功提示单号与实际调减金额、关对话框、列表刷新：该行已生效、金额 ¥20.00、不再有【批准】',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    const reads = server.tableReads(ADJUSTMENTS).length;
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));
    expect(server.approvals()).toHaveLength(1);

    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads));
    await settled(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    decidedRow(ADJ.prefilled, yuan(2000), 'APPROVED');
    expect(rowApprove(ADJ.prefilled)).toEqual([]);
    expect(server.approvals()).toHaveLength(1);
    expect(server.rejections()).toEqual([]);
    expect(server.creations()).toEqual([]);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-APPROVE#3] 预览之后余额变了（¥20.00 → ¥25.00）且驳回原因框里已填字：批准请求体仍恰为 {}，提示与列表按服务端批准时取的金额 ¥25.00；不发驳回',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    await waitFor(() => expect(fieldValue(dialog, BALANCE.before)).toBe(yuan(2000)));
    server.setAvailable(USER.deleting, 2500);
    await typeReason(dialog, REASON);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));

    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2500)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await settled(server);
    await waitFor(() => decidedRow(ADJ.prefilled, yuan(2500), 'APPROVED'));
    expect(server.approvals()).toHaveLength(1);
    expect(server.rejections()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-APPROVE#4] 详情上【批准】：对话框同样显示余额预览；批准成功后详情重新读取，显示已生效、金额 ¥20.00、审核人为批准人，不再有【批准】；列表同时刷新',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    await openDetail(server, ADJ.prefilled);
    const dialog = await openApprove(server, drawer());
    const reads = server.detailReads(ADJ.prefilled).length;
    const listReads = server.tableReads(ADJUSTMENTS).length;
    await waitFor(() =>
      expect(fields(dialog, BALANCE_LABELS)).toEqual({
        [BALANCE.before]: yuan(2000),
        [BALANCE.amount]: yuan(2000),
        [BALANCE.after]: yuan(0),
      }),
    );
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));

    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBeGreaterThan(reads));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(fieldValue(drawer(), FIELD.status)).toBe(statusName('APPROVED')));
    expect(fieldValue(drawer(), FIELD.amount)).toBe(yuan(2000));
    expect(fieldValue(drawer(), FIELD.reviewer)).toBe(ADMIN.first);
    expect(buttons(drawer(), TEXT.approveEntry)).toEqual([]);
    decidedRow(ADJ.prefilled, yuan(2000), 'APPROVED');
    expect(server.approvals()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cc-APPROVE#5] 预览后可用余额降到 0：批准返回 20001 adjust_no_balance → 对话框里提示「可用余额不大于 0，不能批准，请驳回」、对话框保留、单仍待批准，不自动重发；随后【驳回】不再验证、只发一次驳回即可处理',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    await waitFor(() => expect(fieldValue(dialog, BALANCE.before)).toBe(yuan(2000)));
    server.setAvailable(USER.deleting, 0);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));
    await waitFor(() => expect(hasText(approveDialog(), ERROR.noBalance)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    expect(server.approvals()).toHaveLength(1);
    const rowStatus = rowWith(panel(), COLUMN.id, ADJ.prefilled).cells[COLUMN.status];
    expect(rowStatus).toBe(statusName('PENDING'));

    await waitFor(() => expect(usable(dialog, TEXT.reject)).toHaveLength(1));
    await typeReason(dialog, REASON);
    const rejection = await rejectOnce(server, dialog);
    assertRejection(rejection, ADJ.prefilled, REASON);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
    await waitFor(() => expect(shows(TEXT.rejected(ADJ.prefilled))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await settled(server);
    await waitFor(() => decidedRow(ADJ.prefilled, READ_TEXT.dash, 'REJECTED'));
    expect(server.approvals()).toHaveLength(1);
    expect(server.rejections()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cc-APPROVE#6] 两张待批准单依次批准：各自短信验证一次、各发一次请求体 {} 的 POST 到各自的单号，两次的 Idempotency-Key 不同（成功后换新键）；两行都显示已生效与各自的金额',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer({ extra: [secondPending()] });
    const order = [SECOND, ...ADJUSTMENT_ORDER];
    await ready(server, order);

    const first = await approveWithSms(server, await openApprove(server, rowOf(SECOND)));
    assertApproval(server, first, SECOND, passOf(1));
    await waitFor(() => expect(shows(TEXT.approved(SECOND, yuan(SECOND_AVAILABLE)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await settled(server);
    await waitFor(() => expect(rowApprove(SECOND)).toEqual([]));

    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    expect(fieldValue(dialog, SUMMARY.user)).toBe(USER.deleting);
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, ADJ.prefilled, passOf(2));
    expect(idemOf(second)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await settled(server);
    await waitFor(() => decidedRow(ADJ.prefilled, yuan(2000), 'APPROVED'));
    decidedRow(SECOND, yuan(SECOND_AVAILABLE), 'APPROVED');
    expect(rowWith(panel(), COLUMN.id, SECOND).cells[COLUMN.user]).toBe(SECOND_USER);
    expect(server.approvals()).toHaveLength(2);
    expect(server.rejections()).toEqual([]);
  },
);
