// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADMIN,
  ERROR,
  FIELD,
  REASON,
  TEXT,
  approvePath,
  conflict,
  createApproveServer,
  denied,
  passOf,
  reasonInvalid,
  rejectPath,
  stateChanged,
  statusName,
  stepUpRequired,
  unknownForm,
  yuan,
} from './fixtures.ts';
import {
  approveDialog,
  approveWithSms,
  assertApproval,
  assertNoVerification,
  assertRejection,
  buttons,
  decisionsOpen,
  dialogsTitled,
  drawer,
  fieldValue,
  idemOf,
  openApprove,
  openDetail,
  pressApprove,
  ready,
  reasonValue,
  rejectOnce,
  rowApprove,
  rowOf,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  typeReason,
  verifySms,
} from './helpers.ts';

it(
  '[AC-F1-08cc-ERROR#1] 批准时单已被别人驳回：POST …/approve 返回 20902（data.resource=admin_adjustment）→ 提示「该调账单已不是待批准状态，已刷新」、关对话框、列表重新读取：该行已驳回、不再有【批准】；不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    const reads = server.tableReads(ADJUSTMENTS).length;
    server.once('POST', approvePath(ADJ.prefilled), () => {
      server.rejectElsewhere(ADJ.prefilled);
      return stateChanged();
    });
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));

    await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('REJECTED')));
    expect(rowApprove(ADJ.prefilled)).toEqual([]);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cc-ERROR#2] 详情上驳回时单已被别人批准：POST …/reject 返回 20902 → 提示「该调账单已不是待批准状态，已刷新」、关对话框，详情与列表重新读取后显示已生效、审核人为批准人、不再有【批准】；不自动重发、不弹验证',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    await openDetail(server, ADJ.prefilled);
    const dialog = await openApprove(server, drawer());
    const reads = server.detailReads(ADJ.prefilled).length;
    const listReads = server.tableReads(ADJUSTMENTS).length;
    await typeReason(dialog, REASON);
    server.once('POST', rejectPath(ADJ.prefilled), () => {
      server.approveElsewhere(ADJ.prefilled);
      return stateChanged();
    });
    const request = await rejectOnce(server, dialog);
    assertRejection(request, ADJ.prefilled, REASON);

    await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBeGreaterThan(reads));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(fieldValue(drawer(), FIELD.status)).toBe(statusName('APPROVED')));
    expect(fieldValue(drawer(), FIELD.reviewer)).toBe(ADMIN.second);
    expect(buttons(drawer(), TEXT.approveEntry)).toEqual([]);
    expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED'));
    expect(server.rejections()).toHaveLength(1);
    assertNoVerification(server);
  },
);

it(
  '[AC-F1-08cc-ERROR#3] POST …/approve 返回 10003 data.tier=sms（验证已失效）：重新发验证码、再弹短信验证，验证后用新的验证重放请求体 {} 与同一个 Idempotency-Key（契约：重放沿用原键），成功只批准一次',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    server.once('POST', approvePath(ADJ.prefilled), stepUpRequired);
    await pressApprove(dialog);
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(1));
    await waitFor(() => expect(server.codeSends()).toHaveLength(2));
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(2));
    await settled(server);
    await waitFor(() => expect(stepUpDialogs()).toEqual([]));

    const [first, second] = server.approvals();
    assertApproval(server, first!, ADJ.prefilled, passOf(1));
    assertApproval(server, second!, ADJ.prefilled, passOf(2));
    expect(idemOf(second!)).toBe(idemOf(first!));
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(server.approvals()).toHaveLength(2);
    expect(server.verifications()).toHaveLength(2);
    expect(server.rejections()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-ERROR#4] 10403（本地有 fund.adjust、服务端不认）：批准与驳回各提示「无权限执行调账」，对话框保留、驳回原因不丢，都不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    server.once('POST', approvePath(ADJ.prefilled), denied);
    await approveWithSms(server, dialog);
    await waitFor(() => expect(shows(ERROR.forbidden)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    await settled(server);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);

    await waitFor(() => expect(decisionsOpen(dialog)).toBe(true));
    await typeReason(dialog, REASON);
    server.once('POST', rejectPath(ADJ.prefilled), denied);
    const request = await rejectOnce(server, dialog);
    assertRejection(request, ADJ.prefilled, REASON);
    await waitFor(() => expect(shows(ERROR.forbidden)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    expect(reasonValue(dialog)).toBe(REASON);
    await settled(server);
    expect(server.rejections()).toHaveLength(1);
    expect(server.approvals()).toHaveLength(1);
    expect(statusOf(ADJ.prefilled)).toBe(statusName('PENDING'));
  },
);

it(
  '[AC-F1-08cc-ERROR#5] 20001 按 data.fields 提示：批准返回 fields=[adjust_id] → 「调账单不存在或已不可见，请刷新后重试」；驳回返回 fields=[reason] → 「驳回原因须为 1–200 字，请修改后重试」，驳回原因不丢；都只发一次、不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    server.once('POST', approvePath(ADJ.prefilled), unknownForm);
    await approveWithSms(server, dialog);
    await waitFor(() => expect(shows(ERROR.missing)).toBe(true));
    await settled(server);
    expect(server.approvals()).toHaveLength(1);

    await waitFor(() => expect(decisionsOpen(approveDialog())).toBe(true));
    const kept = approveDialog();
    await typeReason(kept, REASON);
    server.once('POST', rejectPath(ADJ.prefilled), reasonInvalid);
    const request = await rejectOnce(server, kept);
    assertRejection(request, ADJ.prefilled, REASON);
    await waitFor(() => expect(shows(ERROR.rejectReasonInvalid)).toBe(true));
    expect(approveDialog()).toBe(kept);
    expect(reasonValue(kept)).toBe(REASON);
    await settled(server);
    expect(server.rejections()).toHaveLength(1);
    expect(server.approvals()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cc-ERROR#6] 20901（同键不同请求体）：提示「提交失败，请稍后重试」、对话框保留、不自动重发；再次批准时重新短信验证并换新的 Idempotency-Key（error-codes 20901：生成新幂等键后由用户重新提交），成功只批准一次',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    server.once('POST', approvePath(ADJ.prefilled), conflict);
    const first = await approveWithSms(server, dialog);
    await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    await settled(server);
    expect(server.approvals()).toHaveLength(1);

    await waitFor(() => expect(decisionsOpen(dialog)).toBe(true));
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, ADJ.prefilled, passOf(2));
    expect(idemOf(second)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(server.approvals()).toHaveLength(2);
  },
);
