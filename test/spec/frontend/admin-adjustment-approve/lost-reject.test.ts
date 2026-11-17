// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ERROR,
  REASON,
  TEXT,
  createApproveServer,
  detailPath,
  rejectPath,
  statusName,
  stillRunning,
  type ApproveServer,
} from './fixtures.ts';
import {
  approveDialog,
  assertNoVerification,
  assertRejection,
  decisionsLocked,
  dialogsTitled,
  openApprove,
  pressEverything,
  pressReject,
  ready,
  refreshedAfter,
  rowApprove,
  rowOf,
  settle,
  settled,
  shows,
  statusOf,
  typeReason,
} from './helpers.ts';

// S2 (编排 D10-1733): the rejection is carried out by the server (the form is REJECTED) but its
// answer never reaches the page — a network failure, or 40901 while it was still running. The
// dialog reads the form again (GET /admin/v1/adjustments/{adjust_id}); until that read returns
// neither 【驳回】 nor 【批准并短信验证】 is usable and pressing them sends nothing; once it shows
// the form is no longer PENDING the page says so, refreshes and sends no second rejection.

/** How the answer of the one rejection is lost (the server has rejected the form either way). */
type Loss = (server: ApproveServer) => void;

/** The rejection is carried out; the page gets a network failure instead of its answer. */
function lostToNetwork(server: ApproveServer): void {
  server.lose('POST', rejectPath(ADJ.prefilled));
}
/** The rejection is carried out; the page gets 40901 (it was still running) instead. */
function lostToRunning(server: ApproveServer): void {
  server.once('POST', rejectPath(ADJ.prefilled), () => {
    server.rejectElsewhere(ADJ.prefilled);
    return stillRunning();
  });
}

async function lostRejection(loss: Loss): Promise<void> {
  const server = createApproveServer();
  await ready(server);
  const dialog = await openApprove(server, rowOf(ADJ.prefilled));
  await typeReason(dialog, REASON);
  loss(server);
  const release = server.hold('GET', detailPath(ADJ.prefilled), () => {
    return server.rejections().length > 0;
  });
  await pressReject(dialog);
  await waitFor(() => expect(server.rejections()).toHaveLength(1));
  const sent = server.rejections()[0]!;
  assertRejection(sent, ADJ.prefilled, REASON);
  expect(server.forms.find((form) => form.adjust_id === ADJ.prefilled)?.status).toBe('REJECTED');

  await waitFor(() => expect(refreshedAfter(server, sent, ADJ.prefilled)).toBe(true));
  await settle();
  expect(approveDialog()).toBe(dialog);
  await waitFor(() => expect(decisionsLocked(dialog)).toBe(true));
  expect(shows(ERROR.stale)).toBe(false);
  await pressEverything(dialog);
  expect(decisionsLocked(dialog)).toBe(true);
  expect(server.rejections()).toHaveLength(1);
  expect(server.approvals()).toEqual([]);
  assertNoVerification(server);

  release();
  await settled(server);
  await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
  await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
  await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('REJECTED')));
  await settled(server);
  expect(rowApprove(ADJ.prefilled)).toEqual([]);
  expect(server.rejections()).toHaveLength(1);
  expect(server.approvals()).toEqual([]);
  assertNoVerification(server);
}

it(
  '[AC-F1-08cc-RETRY#5] 驳回其实已生效、只是回答丢了（网络断开）：重新读取该单返回前【驳回】【批准并短信验证】都不可用、再点不发任何请求；读取显示已驳回后提示「该调账单已不是待批准状态，已刷新」、关对话框、列表显示已驳回且不再有【批准】；只发过一次驳回，全程不验证',
  { timeout: 120_000 },
  async () => {
    await lostRejection(lostToNetwork);
  },
);

it(
  '[AC-F1-08cc-RETRY#6] 驳回其实已生效、回答是 40901：重新读取该单返回前【驳回】【批准并短信验证】都不可用、再点不发任何请求；读取显示已驳回后提示「该调账单已不是待批准状态，已刷新」、关对话框、列表显示已驳回且不再有【批准】；只发过一次驳回，全程不验证',
  { timeout: 120_000 },
  async () => {
    await lostRejection(lostToRunning);
  },
);
