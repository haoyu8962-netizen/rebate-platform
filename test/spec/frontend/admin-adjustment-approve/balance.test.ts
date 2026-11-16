// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  BALANCE,
  BALANCE_LABELS,
  DELETING_AVAILABLE,
  READ_TEXT,
  REASON,
  TEXT,
  USER,
  createApproveServer,
  detailPath,
  networkDown,
  passOf,
  statusName,
  unavailable,
  yuan,
  type ApproveServer,
} from './fixtures.ts';
import {
  approveDialog,
  approveWithSms,
  assertApproval,
  assertNoVerification,
  assertRejection,
  button,
  buttons,
  click,
  dialogsTitled,
  fields,
  hasText,
  nonReadsSince,
  ready,
  rejectOnce,
  rowOf,
  settle,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  typeReason,
  usable,
} from './helpers.ts';

// BR-FUND-24 ④ (编排 D10-1893): the approval page shows available before and after the decrease
// before anything can be approved. The dialog reads the form (GET /admin/v1/adjustments/{id},
// balance_preview) when it opens; until that read has answered, and while it has failed,
// 【批准并短信验证】 is shown but not usable (pressing it sends no code and no request) and no
// balance figure is shown, while 【驳回】 stays usable. A failed read shows 「调账单读取失败」 (the
// same text as the detail drawer, READ_TEXT.detailFailed) with 【重新读取】; once a read answers
// the balance lines show and 【批准并短信验证】 is usable in the same moment.

/** The dialog's button that reads the form again after its read failed. */
const REREAD = '重新读取';

/** The BALANCE lines of a PENDING decrease of the whole `available` (> 0). */
function preview(available: number): Record<string, string> {
  return {
    [BALANCE.before]: yuan(available),
    [BALANCE.amount]: yuan(available),
    [BALANCE.after]: yuan(0),
  };
}
/** Any figure of the preview of `available` appears anywhere in `dialog` (hidden text included). */
function figuresIn(dialog: HTMLElement, available: number): boolean {
  const text = dialog.textContent ?? '';
  return [yuan(available), yuan(0)].some((figure) => text.includes(figure));
}
/**
 * Opens 【批准】 of the list row `adjustId` and waits for the dialog and for its read of the form
 * to be sent, without waiting for that read to answer (a test may hold it).
 */
async function openReading(server: ApproveServer, adjustId: string): Promise<HTMLElement> {
  const reads = server.detailReads(adjustId).length;
  const entry = button(rowOf(adjustId), TEXT.approveEntry);
  entry.focus();
  await click(entry);
  await settle();
  await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toHaveLength(1));
  await waitFor(() => expect(server.detailReads(adjustId)).toHaveLength(reads + 1));
  await settle();
  return approveDialog();
}
/**
 * 【批准并短信验证】 of `dialog` is shown and not usable, and pressing it sends nothing after the
 * log position `since` (no code, no verification, no approval) and opens no step-up dialog.
 */
async function approveBlocked(
  server: ApproveServer,
  dialog: HTMLElement,
  since: number,
): Promise<void> {
  expect(buttons(dialog, TEXT.approve), TEXT.approve).toHaveLength(1);
  expect(usable(dialog, TEXT.approve), TEXT.approve).toEqual([]);
  await click(buttons(dialog, TEXT.approve)[0]!);
  await settle();
  expect(stepUpDialogs()).toEqual([]);
  expect(nonReadsSince(server, since)).toEqual([]);
}

it(
  '[AC-F1-08cc-BALANCE#1] 打开【批准】、读单（GET …/adjustments/{id}）未返回时：前后余额未显示，【批准并短信验证】显示但不可用、点了不发码不发请求，【驳回】可用；读单返回后显示调账前后余额（¥20.00 → ¥0.00），【批准并短信验证】才可用',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const since = server.log.length;
    const release = server.hold('GET', detailPath(ADJ.prefilled));
    const dialog = await openReading(server, ADJ.prefilled);
    expect(server.pending, 'the read of the form is still running').toBeGreaterThan(0);
    expect(figuresIn(dialog, DELETING_AVAILABLE)).toBe(false);
    await approveBlocked(server, dialog, since);
    expect(usable(dialog, TEXT.reject), TEXT.reject).toHaveLength(1);
    expect(figuresIn(dialog, DELETING_AVAILABLE)).toBe(false);

    release();
    await settled(server);
    await waitFor(() =>
      expect(fields(dialog, BALANCE_LABELS)).toEqual(preview(DELETING_AVAILABLE)),
    );
    expect(usable(dialog, TEXT.approve), TEXT.approve).toHaveLength(1);
    expect(usable(dialog, TEXT.reject), TEXT.reject).toHaveLength(1);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-BALANCE#2] 读单失败（50001）：对话框里显示「调账单读取失败」与可用的【重新读取】，前后余额未显示，【批准并短信验证】不可用、点了不发码不发请求；【驳回】可用，填原因后只发一次驳回、全程不验证，成功提示并刷新列表',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const since = server.log.length;
    server.once('GET', detailPath(ADJ.prefilled), unavailable);
    const dialog = await openReading(server, ADJ.prefilled);
    await settled(server);
    await waitFor(() => expect(hasText(dialog, READ_TEXT.detailFailed)).toBe(true));
    expect(usable(dialog, REREAD), REREAD).toHaveLength(1);
    expect(figuresIn(dialog, DELETING_AVAILABLE)).toBe(false);
    await approveBlocked(server, dialog, since);

    expect(usable(dialog, TEXT.reject), TEXT.reject).toHaveLength(1);
    await typeReason(dialog, REASON);
    const request = await rejectOnce(server, dialog);
    assertRejection(request, ADJ.prefilled, REASON);
    await waitFor(() => expect(shows(TEXT.rejected(ADJ.prefilled))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await settled(server);
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('REJECTED')));
    expect(server.rejections()).toHaveLength(1);
    expect(server.approvals()).toEqual([]);
    assertNoVerification(server);
  },
);

it(
  '[AC-F1-08cc-BALANCE#3] 读单网络断开：显示「调账单读取失败」与【重新读取】、【批准并短信验证】不可用、【驳回】可用；按【重新读取】再读一次成功后读取失败提示消失、前后余额显示、【批准并短信验证】可用，之后批准照常：短信验证后只发一次 POST …/approve、请求体恰为 {}',
  { timeout: 120_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const since = server.log.length;
    server.once('GET', detailPath(ADJ.prefilled), networkDown);
    const dialog = await openReading(server, ADJ.prefilled);
    await settled(server);
    await waitFor(() => expect(hasText(dialog, READ_TEXT.detailFailed)).toBe(true));
    expect(figuresIn(dialog, DELETING_AVAILABLE)).toBe(false);
    await approveBlocked(server, dialog, since);
    expect(usable(dialog, TEXT.reject), TEXT.reject).toHaveLength(1);

    const reads = server.detailReads(ADJ.prefilled).length;
    await click(button(dialog, REREAD));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() =>
      expect(fields(dialog, BALANCE_LABELS)).toEqual(preview(DELETING_AVAILABLE)),
    );
    expect(hasText(dialog, READ_TEXT.detailFailed)).toBe(false);
    expect(usable(dialog, TEXT.approve), TEXT.approve).toHaveLength(1);
    expect(nonReadsSince(server, since)).toEqual([]);

    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));
    await waitFor(() =>
      expect(shows(TEXT.approved(ADJ.prefilled, yuan(DELETING_AVAILABLE)))).toBe(true),
    );
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await settled(server);
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(server.approvals()).toHaveLength(1);
    expect(server.rejections()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-BALANCE#4] 读单成功、余额一显示（可用余额 ¥12.34 → ¥0.00）【批准并短信验证】即可用（同一时刻，不再另等）；批准后提示的实际调减为 ¥12.34',
  { timeout: 90_000 },
  async () => {
    const available = 1234;
    const server = createApproveServer();
    server.setAvailable(USER.deleting, available);
    await ready(server);
    const release = server.hold('GET', detailPath(ADJ.prefilled));
    const dialog = await openReading(server, ADJ.prefilled);
    expect(figuresIn(dialog, available)).toBe(false);
    expect(usable(dialog, TEXT.approve), TEXT.approve).toEqual([]);

    release();
    await waitFor(() => expect(figuresIn(dialog, available)).toBe(true));
    expect(usable(dialog, TEXT.approve), 'usable as soon as the balance shows').toHaveLength(1);
    expect(fields(dialog, BALANCE_LABELS)).toEqual(preview(available));
    await settled(server);

    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, ADJ.prefilled, passOf(1));
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(available)))).toBe(true));
    expect(server.approvals()).toHaveLength(1);
    expect(server.rejections()).toEqual([]);
  },
);
