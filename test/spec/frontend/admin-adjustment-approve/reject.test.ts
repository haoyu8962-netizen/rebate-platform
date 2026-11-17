// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADMIN,
  COLUMN,
  ERROR,
  FIELD,
  READ_TEXT,
  REASON,
  TEXT,
  createApproveServer,
  statusName,
} from './fixtures.ts';
import {
  approveDialog,
  assertNoVerification,
  assertRejection,
  buttons,
  cellOf,
  dialogsTitled,
  drawer,
  fieldValue,
  hasText,
  nonReadsSince,
  openApprove,
  openDetail,
  pressApprove,
  pressReject,
  ready,
  reasonValue,
  rejectOnce,
  rowApprove,
  rowOf,
  settled,
  shows,
  stepUpDialogs,
  typeReason,
} from './helpers.ts';

/** 200 characters: the longest reason the contract takes. */
const LONGEST = '驳'.repeat(200);

it(
  '[AC-F1-08cc-REJECT#1] 驳回原因本地校验：不填或只有空白时按【驳回】提示「请填写驳回原因」，去首尾空白后超过 200 字提示「驳回原因最多 200 字」；都不发请求、不弹验证，对话框保留、已填不丢',
  { timeout: 60_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const since = server.log.length;
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));

    await pressReject(dialog);
    await waitFor(() => expect(hasText(dialog, ERROR.rejectReasonRequired)).toBe(true));
    await typeReason(dialog, ' \n  ');
    await pressReject(dialog);
    await waitFor(() => expect(hasText(dialog, ERROR.rejectReasonRequired)).toBe(true));
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);

    const tooLong = `  ${LONGEST}驳  `;
    await typeReason(dialog, tooLong);
    await pressReject(dialog);
    await waitFor(() => expect(hasText(dialog, ERROR.rejectReasonTooLong)).toBe(true));
    await settled(server);
    expect(approveDialog()).toBe(dialog);
    expect(reasonValue(dialog)).toBe(tooLong);
    expect(stepUpDialogs()).toEqual([]);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-REJECT#2] 行上【驳回】：不发验证码、不弹任何二次验证，只发一次 POST …/reject，请求体恰为去首尾空白的 reason（没有别的字段），不带 X-Step-Up-Token、带 Idempotency-Key；成功提示单号、关对话框、列表刷新：该行已驳回、不再有【批准】',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    const reads = server.tableReads(ADJUSTMENTS).length;
    await typeReason(dialog, `  ${REASON}  `);
    const request = await rejectOnce(server, dialog);
    assertRejection(request, ADJ.prefilled, REASON);
    assertNoVerification(server);

    await waitFor(() => expect(shows(TEXT.rejected(ADJ.prefilled))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads));
    await settled(server);
    const rowStatus = (): string | undefined => cellOf(ADJ.prefilled, COLUMN.status);
    await waitFor(() => expect(rowStatus()).toBe(statusName('REJECTED')));
    expect(cellOf(ADJ.prefilled, COLUMN.amount)).toBe(READ_TEXT.dash);
    expect(rowApprove(ADJ.prefilled)).toEqual([]);
    expect(server.rejections()).toHaveLength(1);
    expect(server.approvals()).toEqual([]);
    expect(server.unexpected()).toEqual([]);
    assertNoVerification(server);
  },
);

it(
  '[AC-F1-08cc-REJECT#3] 详情上【驳回】，原因恰 200 字（两端带空白）：请求体 reason 为去空白后的 200 字；成功后详情重新读取，显示已驳回、驳回原因原样、审核人为驳回人、金额仍「—」，不再有【批准】；列表同时刷新',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    await openDetail(server, ADJ.prefilled);
    const dialog = await openApprove(server, drawer());
    const reads = server.detailReads(ADJ.prefilled).length;
    const listReads = server.tableReads(ADJUSTMENTS).length;
    await typeReason(dialog, `\n ${LONGEST} `);
    const request = await rejectOnce(server, dialog);
    assertRejection(request, ADJ.prefilled, LONGEST);
    assertNoVerification(server);

    await waitFor(() => expect(shows(TEXT.rejected(ADJ.prefilled))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBeGreaterThan(reads));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(fieldValue(drawer(), FIELD.status)).toBe(statusName('REJECTED')));
    expect(fieldValue(drawer(), FIELD.rejectNote)).toBe(LONGEST);
    expect(fieldValue(drawer(), FIELD.reviewer)).toBe(ADMIN.first);
    expect(fieldValue(drawer(), FIELD.amount)).toBe(READ_TEXT.dash);
    expect(buttons(drawer(), TEXT.approveEntry)).toEqual([]);
    expect(server.rejections()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cc-REJECT#4] 未登记验证手机号的账号：【批准并短信验证】发码返回 10003 verify_phone_missing → 提示「这项操作需要短信验证，请先登记验证手机号」、不弹验证、不发批准；同一对话框里【驳回】照常可用，只发一次驳回、不带 X-Step-Up-Token',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer({ verifyPhone: false });
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    await pressApprove(dialog);
    await waitFor(() => expect(server.codeSends()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(shows(ERROR.verifyPhoneMissing)).toBe(true));
    expect(stepUpDialogs()).toEqual([]);
    expect(server.verifications()).toEqual([]);
    expect(server.approvals()).toEqual([]);
    expect(approveDialog()).toBe(dialog);

    await typeReason(dialog, REASON);
    const request = await rejectOnce(server, dialog);
    assertRejection(request, ADJ.prefilled, REASON);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    await waitFor(() => expect(shows(TEXT.rejected(ADJ.prefilled))).toBe(true));
    expect(server.approvals()).toEqual([]);
    expect(server.rejections()).toHaveLength(1);
  },
);
