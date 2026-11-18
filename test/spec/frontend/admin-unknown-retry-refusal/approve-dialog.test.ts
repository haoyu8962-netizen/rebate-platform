// @vitest-environment jsdom
// F1-08as（编排 D10-2060 ③）：「批准调账单」对话框（ApproveDialog，系统预填单，adminApproveAdjustment 短信档）
// 的批准决定一旦进入「上次提交结果未知」，再按【批准并短信验证】（即原样重试）收到带外壳的 10403
// admin_permission_denied（契约先判 fund.adjust、后做幂等回放；未知窗口内权限被撤）时第一次批准仍可能已生效：
// 仍显示结果未知提示与「无权限执行调账」、【取消】仍换成【去列表核对】、对话框不能关（无右上角关闭、Esc 不关），
// 再批准沿用原 Idempotency-Key 与请求体 {}（BR-FUND-24 ①⑧、BR-ID-34 短信档）。对话框自己管 unknown /
// onFailed，只修 useAdjustmentWrite 的新建流程不够。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { pressEscape } from '../admin-adjustment-create/helpers.ts';
import {
  ADJ,
  ERROR,
  TEXT,
  approvePath,
  createApproveServer,
  denied,
  networkDown,
  passOf,
  statusName,
  yuan,
  type ApproveServer,
  type RequestLog,
} from '../admin-adjustment-approve/fixtures.ts';
import {
  approveDialog,
  approveWithSms,
  assertApproval,
  buttons,
  dialogsTitled,
  hasText,
  idemOf,
  openApprove,
  ready,
  refreshedAfter,
  rowOf,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  usable,
} from '../admin-adjustment-approve/helpers.ts';

/** texts/adjustments.ts approve.unknown: a decision got no reply in the unified envelope. */
const UNKNOWN =
  '上次提交结果未知：可能已经生效。重新读取后仍待批准时，再按同一个决定用原内容原样重新提交（不会重复执行），或按【去列表核对】查看是否已处理。';
const CHECK = '去列表核对';

/** The write that carries the step-up pass `pass`. */
function carrying(pass: string) {
  return (request: RequestLog): boolean => request.headers.get('X-Step-Up-Token') === pass;
}

/**
 * The approval of `dialog` is in the result-unknown state: the notice shown, 【去列表核对】 in place
 * of 【取消】, no corner close, Escape does not close it, no step-up open.
 */
async function stillUnknown(server: ApproveServer, dialog: HTMLElement): Promise<void> {
  expect(dialogsTitled(TEXT.approveTitle)).toEqual([dialog]);
  expect(hasText(dialog, UNKNOWN)).toBe(true);
  expect(usable(dialog, CHECK)).toHaveLength(1);
  expect(buttons(dialog, TEXT.cancel)).toEqual([]);
  expect(buttons(dialog, 'Close')).toEqual([]);
  await pressEscape(dialog);
  await settled(server);
  expect(dialogsTitled(TEXT.approveTitle)).toEqual([dialog]);
  expect(approveDialog()).toBe(dialog);
  expect(hasText(dialog, UNKNOWN)).toBe(true);
  expect(stepUpDialogs()).toEqual([]);
}

it(
  '[AC-F1-08as-APPROVE#1] 批准调账单：批准没拿到带外壳的回答 → 结果未知（重新读取后仍待批准）；再按【批准并短信验证】短信验证后原键、请求体 {} 收到带外壳的 10403 admin_permission_denied：仍显示结果未知提示并显示「无权限执行调账」、【去列表核对】代替【取消】、无右上角关闭、Esc 不关、不清键；再批准沿用原 Idempotency-Key 与请求体 {} 才解除：提示「已批准，调账单号 …，实际调减 ¥20.00」、关对话框、该单已生效，只批准一次',
  { timeout: 180_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));

    // 1. The approval never reaches the service; its reply is lost: result unknown.
    server.once('POST', approvePath(ADJ.prefilled), networkDown);
    const first = await approveWithSms(server, dialog);
    assertApproval(server, first, ADJ.prefilled, passOf(1));
    await waitFor(() => expect(refreshedAfter(server, first, ADJ.prefilled)).toBe(true));
    await settled(server);
    await waitFor(() => expect(usable(dialog, TEXT.approve)).toHaveLength(1));
    await stillUnknown(server, dialog);

    // 2. The retry is refused with 10403 (fund.adjust withdrawn meanwhile): still unknown.
    server.once('POST', approvePath(ADJ.prefilled), denied, carrying(passOf(2)));
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, ADJ.prefilled, passOf(2));
    expect(idemOf(second)).toBe(idemOf(first));
    await waitFor(() => expect(shows(ERROR.forbidden)).toBe(true));
    await settled(server);
    await stillUnknown(server, dialog);
    expect(server.approvals()).toHaveLength(2);
    expect(server.forms.find((form) => form.adjust_id === ADJ.prefilled)?.status).toBe('PENDING');

    // 3. Approving again sends the original key and {}: carried out once.
    await waitFor(() => expect(usable(dialog, TEXT.approve)).toHaveLength(1));
    const third = await approveWithSms(server, dialog);
    assertApproval(server, third, ADJ.prefilled, passOf(3));
    expect([first, second, third].map(idemOf)).toEqual([
      idemOf(first),
      idemOf(first),
      idemOf(first),
    ]);
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(server.approvals()).toHaveLength(3);
    expect(server.rejections()).toEqual([]);
    expect(server.unexpected()).toEqual([]);
  },
);
