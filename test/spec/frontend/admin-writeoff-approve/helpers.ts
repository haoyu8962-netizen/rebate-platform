import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  button,
  buttons,
  click,
  fill,
  mount as mountShell,
  openTab,
  panel,
  rowWith,
  settle,
  settled,
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
  OTP,
  READ_TEXT,
  TEXT,
  WRITEOFFER,
  WRITEOFFS,
  WRITEOFF_COLUMN,
  WRITEOFF_ORDER,
  approvePath,
  type RequestLog,
  type WriteoffServer,
} from './fixtures.ts';

// The page is reached only through the real shell (the frozen F1-08ca mount, menu id
// `adjustments`), so a missing entry is an assertion failure, not an import error. What this task
// decides about the page (texts in fixtures.ts TEXT / SUMMARY / ERROR):
// - 【批准核销】 on every PENDING row of the 坏账核销 table (approve_blocked or not), only with
//   fund.writeoff (super admins included); APPROVED and CANCELLED rows have none, and no account
//   without fund.writeoff sees it. It opens one dialog titled 「批准坏账核销」 with the read-only
//   SUMMARY items of the row (the current available and frozen among them), the note that the
//   amount is taken at approval, the consequence notice, the frozen-money notice when the row says
//   approve_blocked, no input, and 【取消】【批准核销】.
// - 【批准核销】 of the dialog sends POST /admin/v1/auth/step-up/sms-codes, opens the StepUpModal
//   (sms tier, 「二次验证 · 短信」, input 「验证码」, 【验证并继续】 → POST /admin/v1/auth/step-up)
//   and then sends one POST /admin/v1/bad-debt-writeoffs/{id}/approve with the body {} and the
//   X-Step-Up-Token of that verification.
// - After a write whose outcome is unknown (network, 5xx, 40901) the dialog reads the list again
//   (GET /admin/v1/bad-debt-writeoffs) before it lets the operator submit again.
// Every compared text has its whitespace collapsed and trimmed (the frozen helpers).
export * from '../admin-adjustments-readonly/helpers.ts';
export { dialogsTitled, idemOf, shows, smsDialog, stepUpDialogs };
export type { WriteoffServer };

/** Mounts the real shell on 资金 / 调账与核销 over the write-off server (fund.writeoff, sms tier). */
export async function mount(server: WriteoffServer, snapshot: PermissionSnapshot = WRITEOFFER) {
  return mountShell(server, { snapshot });
}
/**
 * Mounts, opens the 坏账核销 tab (the only tab, or the one after 调账单) and waits for the rows
 * in `order` and for every read to finish.
 */
export async function ready(
  server: WriteoffServer,
  snapshot: PermissionSnapshot = WRITEOFFER,
  order: readonly string[] = WRITEOFF_ORDER,
): Promise<void> {
  await mount(server, snapshot);
  await openTab(READ_TEXT.writeoffsTab);
  await waitColumn(WRITEOFF_COLUMN.id, order);
  await settled(server);
}

// ---- rows, entries and the dialog ----------------------------------------------------------

/** The 坏账核销 row `id` of the shown panel. */
export function rowOf(id: string): HTMLElement {
  return rowWith(panel(), WRITEOFF_COLUMN.id, id).element;
}
/** The cell of the row `id` under the column `title`. */
export function cellOf(id: string, title: string): string | undefined {
  return rowWith(panel(), WRITEOFF_COLUMN.id, id).cells[title];
}
/** The 状态 cell of the row `id`. */
export function statusOf(id: string): string | undefined {
  return cellOf(id, WRITEOFF_COLUMN.status);
}
/** The 【批准核销】 buttons of the row `id`. */
export function rowApprove(id: string): HTMLElement[] {
  return buttons(rowOf(id), TEXT.approveEntry);
}
/** Ids of `order` whose row offers 【批准核销】, in list order. */
export function rowsWithApprove(order: readonly string[] = WRITEOFF_ORDER): string[] {
  return order.filter((id) => rowApprove(id).length > 0);
}
/** The one open dialog 「批准坏账核销」. */
export function approveDialog(): HTMLElement {
  const found = dialogsTitled(TEXT.title);
  expect(found, `one open dialog titled ${TEXT.title}`).toHaveLength(1);
  return found[0]!;
}
/**
 * Opens 【批准核销】 of the row `id` (focused first, as a keyboard user would), waits for the
 * dialog and for every read it starts; returns the dialog.
 */
export async function openApprove(server: WriteoffServer, id: string): Promise<HTMLElement> {
  const entry = button(rowOf(id), TEXT.approveEntry);
  entry.focus();
  await click(entry);
  await settle();
  await waitFor(() => expect(dialogsTitled(TEXT.title)).toHaveLength(1));
  await settled(server);
  return approveDialog();
}

// ---- approving -----------------------------------------------------------------------------

/** Presses 【批准核销】 of the dialog `root` only (no verification). */
export async function pressApprove(root: HTMLElement): Promise<void> {
  await click(button(root, TEXT.approve));
  await settle();
}
/**
 * Types the SMS code into the open StepUpModal, presses 【验证并继续】 and waits for the
 * verification request (not for the write after it, which a test may hold).
 */
export async function verifySms(server: WriteoffServer): Promise<void> {
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
 * Presses 【批准核销】 of the dialog `root`, checks that a code was sent and nothing approved
 * before the verification, verifies and waits for the one approval that follows (and every read
 * after it).
 */
export async function approveWithSms(
  server: WriteoffServer,
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

/**
 * One approval as the contract wants it: POST /admin/v1/bad-debt-writeoffs/{id}/approve without a
 * query, the body exactly {} (no amount), the admin bearer, the step-up pass `pass` and an
 * Idempotency-Key; right before it the sms-tier verification with the typed code, and before that
 * a code sent.
 */
export function assertApproval(
  server: WriteoffServer,
  request: RequestLog,
  id: string,
  pass: string,
): void {
  expect(request.method).toBe('POST');
  expect(request.path).toBe(approvePath(id));
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

/** GET /admin/v1/bad-debt-writeoffs (a table read) was sent after `request`. */
export function refreshedAfter(server: WriteoffServer, request: RequestLog): boolean {
  const at = server.log.indexOf(request);
  return server.tableReads(WRITEOFFS).some((read) => server.log.indexOf(read) > at);
}
/** The requests other than GET logged after the first `since`. */
export function nonReadsSince(server: WriteoffServer, since = 0): RequestLog[] {
  return server.log.slice(since).filter((r) => r.method !== 'GET');
}
/** The dialog's 【批准核销】 shown and not usable (a submission or its refresh is running). */
export function approveLocked(root: HTMLElement): boolean {
  return buttons(root, TEXT.approve).length === 1 && usable(root, TEXT.approve).length === 0;
}
/** The dialog's 【批准核销】 shown and usable. */
export function approveOpen(root: HTMLElement): boolean {
  return buttons(root, TEXT.approve).length === 1 && usable(root, TEXT.approve).length === 1;
}
/** Clicks every 【批准核销】 of `root` (usable or not). */
export async function pressEverything(root: HTMLElement): Promise<void> {
  for (const node of buttons(root, TEXT.approve)) await click(node);
  await settle();
}
