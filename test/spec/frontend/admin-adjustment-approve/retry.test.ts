// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ERROR,
  REASON,
  TEXT,
  approvePath,
  createApproveServer,
  detailPath,
  networkDown,
  passOf,
  rejectPath,
  statusName,
  stillRunning,
  unavailable,
  yuan,
  type RequestLog,
} from './fixtures.ts';
import {
  approveDialog,
  approveWithSms,
  assertApproval,
  assertNoVerification,
  assertRejection,
  decisionsLocked,
  decisionsOpen,
  dialogsTitled,
  idemOf,
  openApprove,
  pressApprove,
  pressEverything,
  ready,
  reasonValue,
  refreshedAfter,
  rejectOnce,
  rowApprove,
  rowOf,
  settle,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  typeReason,
  verifySms,
} from './helpers.ts';

// A write whose outcome is unknown (a network failure, a 5xx or 40901) may have been carried out:
// the dialog reads the form again (GET /admin/v1/adjustments/{adjust_id}) before the operator can
// submit again; while it is PENDING the next submission replays the same Idempotency-Key, once it
// is not PENDING any more nothing is sent.

it(
  '[AC-F1-08cc-RETRY#1] 批准结果未定（网络断开、50001、40901）：每次提示「提交失败，请稍后重试」、对话框保留、不自动重发，并在失败后重新读取该单；再次批准重新短信验证、沿用同一个 Idempotency-Key 与请求体 {}，最终只批准一次',
  { timeout: 180_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    const sent: RequestLog[] = [];
    for (const reply of [networkDown, unavailable, stillRunning]) {
      server.once('POST', approvePath(ADJ.prefilled), reply);
      const request = await approveWithSms(server, dialog);
      sent.push(request);
      await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
      await waitFor(() => expect(refreshedAfter(server, request, ADJ.prefilled)).toBe(true));
      await settled(server);
      expect(approveDialog()).toBe(dialog);
      await waitFor(() => expect(decisionsOpen(dialog)).toBe(true));
      expect(server.approvals()).toHaveLength(sent.length);
    }
    sent.push(await approveWithSms(server, dialog));
    for (const [index, request] of sent.entries())
      assertApproval(server, request, ADJ.prefilled, passOf(index + 1));
    expect(sent.map(idemOf)).toEqual(Array.from({ length: 4 }, () => idemOf(sent[0]!)));
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(server.approvals()).toHaveLength(4);
    expect(server.rejections()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-RETRY#2] 先刷新再允许重提：批准网络失败后重新读取该单，读取返回前【批准并短信验证】【驳回】都不可用、再点不发码不发请求；读取返回仍待批准后才可用，再次批准沿用原键',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    server.once('POST', approvePath(ADJ.prefilled), networkDown);
    const release = server.hold('GET', detailPath(ADJ.prefilled), () => {
      return server.approvals().length > 0;
    });
    await pressApprove(dialog);
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(1));
    const failed = server.approvals()[0]!;
    await waitFor(() => expect(refreshedAfter(server, failed, ADJ.prefilled)).toBe(true));
    await settle();
    expect(approveDialog()).toBe(dialog);
    await waitFor(() => expect(decisionsLocked(dialog)).toBe(true));
    await typeReason(dialog, REASON);
    await pressEverything(dialog);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.approvals()).toHaveLength(1);
    expect(server.rejections()).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);

    release();
    await settled(server);
    await waitFor(() => expect(decisionsOpen(dialog)).toBe(true));
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, ADJ.prefilled, passOf(2));
    expect(idemOf(second)).toBe(idemOf(failed));
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    expect(server.approvals()).toHaveLength(2);
    expect(server.rejections()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-RETRY#3] 批准其实已生效、只是回答丢了（网络断开）：重新读取后单已是已生效 → 提示「该调账单已不是待批准状态，已刷新」、关对话框、列表显示已生效且不再有【批准】；不再发批准、不再发码',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    server.lose('POST', approvePath(ADJ.prefilled));
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));
    await waitFor(() => expect(refreshedAfter(server, request, ADJ.prefilled)).toBe(true));
    await settled(server);
    await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(rowApprove(ADJ.prefilled)).toEqual([]);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cc-RETRY#4] 驳回结果未定（50001）：提示「提交失败，请稍后重试」、对话框保留、驳回原因不丢，失败后重新读取该单；再次驳回沿用同一个 Idempotency-Key 与同一请求体，全程不验证，最终只驳回一次',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    await typeReason(dialog, REASON);
    server.once('POST', rejectPath(ADJ.prefilled), unavailable);
    const first = await rejectOnce(server, dialog);
    await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
    await waitFor(() => expect(refreshedAfter(server, first, ADJ.prefilled)).toBe(true));
    await settled(server);
    expect(approveDialog()).toBe(dialog);
    expect(reasonValue(dialog)).toBe(REASON);
    expect(server.rejections()).toHaveLength(1);

    await waitFor(() => expect(decisionsOpen(dialog)).toBe(true));
    const second = await rejectOnce(server, dialog);
    assertRejection(first, ADJ.prefilled, REASON);
    assertRejection(second, ADJ.prefilled, REASON);
    expect(idemOf(second)).toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.rejected(ADJ.prefilled))).toBe(true));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('REJECTED')));
    expect(server.rejections()).toHaveLength(2);
    expect(server.approvals()).toEqual([]);
    assertNoVerification(server);
  },
);
