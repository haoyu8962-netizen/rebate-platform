import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  button,
  buttons,
  click,
  fill,
  mount as mountShell,
  panel,
  rowWith,
  settle,
  settled,
  textbox,
  usable,
  waitColumn,
} from '../admin-adjustments-readonly/helpers.ts';
import {
  dialogsTitled,
  idemOf,
  shows,
  smsDialog,
  stepUpDialogs,
} from '../admin-adjustment-create/helpers.ts';
import {
  ADJUSTER,
  ADJUSTMENT_ORDER,
  COLUMN,
  LABEL,
  OTP,
  TEXT,
  approvePath,
  rejectPath,
  type ApproveServer,
  type RequestLog,
} from './fixtures.ts';

// The page is reached only through the real shell (the frozen F1-08ca mount, menu id
// `adjustments`), so a missing entry is an assertion failure, not an import error. What this task
// decides about the page (texts in fixtures.ts TEXT / LABEL / SUMMARY / BALANCE / ERROR):
// - 【批准】 on every PENDING row of the 调账单 table and in the detail of a PENDING form, only with
//   fund.adjust (super admins included); no other row or detail has it, and 【驳回】 is only in the
//   dialog. It opens one dialog titled 「批准调账单」 with the consequence notice, the read-only
//   SUMMARY items, the linked documents table (单据类型 / 单据号), the BALANCE lines of
//   adminGetAdjustment balance_preview with the note that the actual amount is taken at approval,
//   the one input 「驳回原因」 (used by 【驳回】 only), and 【取消】【驳回】【批准并短信验证】.
// - 【批准并短信验证】 sends POST /admin/v1/auth/step-up/sms-codes, opens the StepUpModal (sms tier,
//   「二次验证 · 短信」, input 「验证码」, 【验证并继续】 → POST /admin/v1/auth/step-up) and then
//   sends one POST …/approve with the body {} and the X-Step-Up-Token of that verification.
// - 【驳回】 checks 驳回原因 locally (1–200 characters after trimming) and sends one POST …/reject
//   with the trimmed reason only, without any step-up.
// - After a write whose outcome is unknown (network, 5xx, 40901) the dialog reads the form again
//   (GET /admin/v1/adjustments/{adjust_id}) before it lets the operator submit again.
// Every compared text has its whitespace collapsed and trimmed (the frozen helpers).
export * from '../admin-adjustments-readonly/helpers.ts';
export { dialogsTitled, idemOf, shows, smsDialog, stepUpDialogs };
export type { ApproveServer };

/** Mounts the real shell on 资金 / 调账与核销 over the approve server (fund.adjust, sms tier). */
export async function mount(server: ApproveServer, snapshot: PermissionSnapshot = ADJUSTER) {
  return mountShell(server, { snapshot });
}
/** Mounts and waits for the first page of the list in `order` (and every read to finish). */
export async function ready(
  server: ApproveServer,
  order: readonly string[] = ADJUSTMENT_ORDER,
  snapshot: PermissionSnapshot = ADJUSTER,
): Promise<void> {
  await mount(server, snapshot);
  await waitColumn(COLUMN.id, order);
  await settled(server);
}

// ---- entries and the dialog ----------------------------------------------------------------

/** The list row `adjustId` of the shown panel. */
export function rowOf(adjustId: string): HTMLElement {
  return rowWith(panel(), COLUMN.id, adjustId).element;
}
/** The cell of the list row `adjustId` under the column `title`. */
export function cellOf(adjustId: string, title: string): string | undefined {
  return rowWith(panel(), COLUMN.id, adjustId).cells[title];
}
/** The 状态 cell of the list row `adjustId`. */
export function statusOf(adjustId: string): string | undefined {
  return cellOf(adjustId, COLUMN.status);
}
/** GET /admin/v1/adjustments/{adjust_id} was sent after `request` (the form was read again). */
export function refreshedAfter(
  server: ApproveServer,
  request: RequestLog,
  adjustId: string,
): boolean {
  const at = server.log.indexOf(request);
  return server.detailReads(adjustId).some((read) => server.log.indexOf(read) > at);
}
/** The 【批准】 buttons of the list row `adjustId`. */
export function rowApprove(adjustId: string): HTMLElement[] {
  return buttons(rowOf(adjustId), TEXT.approveEntry);
}
/** Ids of `order` whose list row offers 【批准】, in list order. */
export function rowsWithApprove(order: readonly string[]): string[] {
  return order.filter((adjustId) => rowApprove(adjustId).length > 0);
}
/** The one open dialog 「批准调账单」. */
export function approveDialog(): HTMLElement {
  const found = dialogsTitled(TEXT.approveTitle);
  expect(found, `one open dialog titled ${TEXT.approveTitle}`).toHaveLength(1);
  return found[0]!;
}
/**
 * Opens 【批准】 of `root` (a list row or the detail drawer; focused first, as a keyboard user
 * would), waits for the dialog and for every read it starts; returns the dialog.
 */
export async function openApprove(server: ApproveServer, root: HTMLElement): Promise<HTMLElement> {
  const entry = button(root, TEXT.approveEntry);
  entry.focus();
  await click(entry);
  await settle();
  await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toHaveLength(1));
  await settled(server);
  return approveDialog();
}

// ---- the two decisions ---------------------------------------------------------------------

/** Types `value` into 「驳回原因」 of `root`. */
export async function typeReason(root: HTMLElement, value: string): Promise<void> {
  await fill(textbox(root, LABEL.rejectReason), value);
  await settle();
}
/** The current value of 「驳回原因」 of `root`. */
export function reasonValue(root: HTMLElement): string {
  return textbox(root, LABEL.rejectReason).value;
}
/** Presses 【批准并短信验证】 of `root` only (no verification). */
export async function pressApprove(root: HTMLElement): Promise<void> {
  await click(button(root, TEXT.approve));
  await settle();
}
/** Presses 【驳回】 of `root` only. */
export async function pressReject(root: HTMLElement): Promise<void> {
  await click(button(root, TEXT.reject));
  await settle();
}
/**
 * Types the SMS code into the open StepUpModal, presses 【验证并继续】 and waits for the
 * verification request (not for the write after it, which a test may hold).
 */
export async function verifySms(server: ApproveServer): Promise<void> {
  const checks = server.verifications().length;
  const dialog = await smsDialog();
  const inputs = within(dialog).queryAllByLabelText('验证码', { exact: true });
  expect(inputs, 'the sms code input').toHaveLength(1);
  await fill(inputs[0]!, OTP);
  await click(button(dialog, '验证并继续'));
  await waitFor(() => expect(server.verifications()).toHaveLength(checks + 1));
  await settle();
}
/**
 * Presses 【批准并短信验证】 of `root`, checks that a code was sent and nothing approved before
 * the verification, verifies and waits for the one approval that follows (and every read after).
 */
export async function approveWithSms(
  server: ApproveServer,
  root: HTMLElement,
): Promise<RequestLog> {
  const approvals = server.approvals().length;
  const sends = server.codeSends().length;
  const checks = server.verifications().length;
  await pressApprove(root);
  await smsDialog();
  await waitFor(() => expect(server.codeSends()).toHaveLength(sends + 1));
  expect(server.verifications()).toHaveLength(checks);
  expect(server.approvals(), 'nothing approved before the verification').toHaveLength(approvals);
  await verifySms(server);
  await waitFor(() => expect(server.approvals()).toHaveLength(approvals + 1));
  await settled(server);
  await waitFor(() => expect(stepUpDialogs()).toEqual([]));
  return server.approvals().at(-1)!;
}
/** Presses 【驳回】 of `root` and waits for the one rejection that follows (and every read after). */
export async function rejectOnce(server: ApproveServer, root: HTMLElement): Promise<RequestLog> {
  const rejections = server.rejections().length;
  await pressReject(root);
  await waitFor(() => expect(server.rejections()).toHaveLength(rejections + 1));
  await settled(server);
  return server.rejections().at(-1)!;
}

/**
 * One approval as the contract wants it: POST /admin/v1/adjustments/{adjust_id}/approve without a
 * query, the body exactly {} (no amount), the admin bearer, the step-up pass `pass` and an
 * Idempotency-Key; right before it the sms-tier verification with the typed code, and before that
 * a code sent.
 */
export function assertApproval(
  server: ApproveServer,
  request: RequestLog,
  adjustId: string,
  pass: string,
): void {
  expect(request.method).toBe('POST');
  expect(request.path).toBe(approvePath(adjustId));
  expect(request.query).toEqual({});
  expect(request.body).toStrictEqual({});
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(pass);
  idemOf(request);
  const at = (one: RequestLog): number => server.log.indexOf(one);
  const check = server
    .verifications()
    .filter((one) => at(one) < at(request))
    .at(-1);
  expect(check?.body).toEqual({ tier: 'sms', code: OTP });
  const sends = server.codeSends().filter((one) => at(one) < at(check!));
  expect(sends.length, 'a code was sent before the verification').toBeGreaterThan(0);
}
/**
 * One rejection as the contract wants it: POST /admin/v1/adjustments/{adjust_id}/reject without a
 * query, the body exactly { reason } (trimmed), the admin bearer, an Idempotency-Key and no
 * X-Step-Up-Token.
 */
export function assertRejection(request: RequestLog, adjustId: string, reason: string): void {
  expect(request.method).toBe('POST');
  expect(request.path).toBe(rejectPath(adjustId));
  expect(request.query).toEqual({});
  expect(request.body).toStrictEqual({ reason });
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBeNull();
  idemOf(request);
}
/** No step-up at all: no code sent, no verification, no step-up dialog. */
export function assertNoVerification(server: ApproveServer): void {
  expect(server.codeSends()).toEqual([]);
  expect(server.verifications()).toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
}

/** The requests other than GET logged after the first `since`. */
export function nonReadsSince(server: ApproveServer, since = 0): RequestLog[] {
  return server.log.slice(since).filter((r) => r.method !== 'GET');
}
/** Both decisions of `root` shown and neither usable (a submission or its refresh is running). */
export function decisionsLocked(root: HTMLElement): boolean {
  return (
    buttons(root, TEXT.approve).length === 1 &&
    usable(root, TEXT.approve).length === 0 &&
    buttons(root, TEXT.reject).length === 1 &&
    usable(root, TEXT.reject).length === 0
  );
}
/** Both decisions of `root` shown and usable. */
export function decisionsOpen(root: HTMLElement): boolean {
  return usable(root, TEXT.approve).length === 1 && usable(root, TEXT.reject).length === 1;
}
/** Clicks every 【批准并短信验证】 and 【驳回】 of `root` (usable or not). */
export async function pressEverything(root: HTMLElement): Promise<void> {
  for (const node of [...buttons(root, TEXT.approve), ...buttons(root, TEXT.reject)])
    await click(node);
  await settle();
}
