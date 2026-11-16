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
  createApproveServer,
  passOf,
  rejectPath,
  stateChanged,
  statusName,
  stillRunning,
  unavailable,
  type ApproveServer,
  type RequestLog,
} from './fixtures.ts';
import {
  approveDialog,
  approveWithSms,
  assertApproval,
  assertRejection,
  buttons,
  decisionsOpen,
  dialogsTitled,
  drawer,
  fieldValue,
  openApprove,
  openDetail,
  ready,
  refreshedAfter,
  rejectOnce,
  rowApprove,
  rowOf,
  settle,
  settled,
  shows,
  statusOf,
  typeReason,
} from './helpers.ts';

// 编排 D10-1893: after a decision whose outcome is unknown (an enveloped 40901 or 50001) the dialog
// reads the form again; it is still PENDING, so the operator presses the *other* decision. The
// server answers 20902 (data.resource=admin_adjustment: meanwhile the form was decided) → the page
// says 「该调账单已不是待批准状态，已刷新」, closes the dialog, reads the list (and an open detail)
// again and sends nothing by itself: exactly two writes in all, the first decision and the other.

/** adminApproveAdjustment and adminRejectAdjustment requests, in the order they were sent. */
function writes(server: ApproveServer): RequestLog[] {
  const decisions = new Set([...server.approvals(), ...server.rejections()]);
  return server.log.filter((request) => decisions.has(request));
}

it(
  '[AC-F1-08cc-SWITCH#1] 批准结果未定（带外壳的 40901）→ 重新读单仍待批准、两个决定都可用 → 改按【驳回】→ 20902（data.resource=admin_adjustment，单已被批准）→ 提示「该调账单已不是待批准状态，已刷新」、关对话框、列表重新读取显示已生效且不再有【批准】；不自动重发，全程写请求恰 2 次（1 次批准 + 1 次驳回）、只验证 1 次',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    server.once('POST', approvePath(ADJ.prefilled), stillRunning);
    const approval = await approveWithSms(server, dialog);
    assertApproval(server, approval, ADJ.prefilled, passOf(1));
    await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
    await waitFor(() => expect(refreshedAfter(server, approval, ADJ.prefilled)).toBe(true));
    await settled(server);
    expect(approveDialog()).toBe(dialog);
    await waitFor(() => expect(decisionsOpen(dialog)).toBe(true));
    expect(statusOf(ADJ.prefilled)).toBe(statusName('PENDING'));

    const listReads = server.tableReads(ADJUSTMENTS).length;
    await typeReason(dialog, REASON);
    server.once('POST', rejectPath(ADJ.prefilled), () => {
      server.approveElsewhere(ADJ.prefilled);
      return stateChanged();
    });
    const rejection = await rejectOnce(server, dialog);
    assertRejection(rejection, ADJ.prefilled, REASON);

    await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(rowApprove(ADJ.prefilled)).toEqual([]);
    await settle();
    const sent = writes(server);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(approval);
    expect(sent[1]).toBe(rejection);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
    expect(server.unexpected()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-SWITCH#2] 详情上驳回结果未定（带外壳的 50001）→ 重新读单仍待批准、两个决定都可用 → 改按【批准并短信验证】→ 20902（单已被别人驳回）→ 提示「该调账单已不是待批准状态，已刷新」、关对话框、详情与列表重新读取显示已驳回、审核人为驳回人、不再有【批准】；不自动重发，全程写请求恰 2 次（1 次驳回 + 1 次批准）、只验证 1 次',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    await openDetail(server, ADJ.prefilled);
    const dialog = await openApprove(server, drawer());
    await typeReason(dialog, REASON);
    server.once('POST', rejectPath(ADJ.prefilled), unavailable);
    const rejection = await rejectOnce(server, dialog);
    assertRejection(rejection, ADJ.prefilled, REASON);
    await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
    await waitFor(() => expect(refreshedAfter(server, rejection, ADJ.prefilled)).toBe(true));
    await settled(server);
    expect(approveDialog()).toBe(dialog);
    await waitFor(() => expect(decisionsOpen(dialog)).toBe(true));
    expect(fieldValue(drawer(), FIELD.status)).toBe(statusName('PENDING'));

    const detailReads = server.detailReads(ADJ.prefilled).length;
    const listReads = server.tableReads(ADJUSTMENTS).length;
    server.once('POST', approvePath(ADJ.prefilled), () => {
      server.rejectElsewhere(ADJ.prefilled);
      return stateChanged();
    });
    const approval = await approveWithSms(server, dialog);
    assertApproval(server, approval, ADJ.prefilled, passOf(1));

    await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() =>
      expect(server.detailReads(ADJ.prefilled).length).toBeGreaterThan(detailReads),
    );
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS).length).toBeGreaterThan(listReads));
    await settled(server);
    await waitFor(() => expect(fieldValue(drawer(), FIELD.status)).toBe(statusName('REJECTED')));
    expect(fieldValue(drawer(), FIELD.reviewer)).toBe(ADMIN.second);
    expect(buttons(drawer(), TEXT.approveEntry)).toEqual([]);
    expect(statusOf(ADJ.prefilled)).toBe(statusName('REJECTED'));
    await settle();
    const sent = writes(server);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(rejection);
    expect(sent[1]).toBe(approval);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
    expect(server.unexpected()).toEqual([]);
  },
);
