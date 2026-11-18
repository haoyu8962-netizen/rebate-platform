// @vitest-environment jsdom
// F1-08as（编排 D10-2060 ③）：「批准坏账核销」对话框（WriteoffApproveDialog，adminApproveBadDebtWriteoff 短信档）
// 的批准一旦进入「上次提交结果未知」，再按【批准核销】（即原样重试）收到带外壳的 10403
// admin_permission_denied（契约先判 fund.writeoff、后做幂等回放；未知窗口内权限被撤）时第一次批准仍可能已
// 生效：仍显示结果未知提示与「无权限执行坏账核销」、【取消】仍换成【去列表核对】、对话框不能关（无右上角关闭、
// Esc 不关），再批准沿用原 Idempotency-Key 与请求体 {}（BR-FUND-24 ①、BR-ID-34 短信档）。对话框自己管
// unknown / onFailed，只修 useAdjustmentWrite 的新建流程不够。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { pressEscape } from '../admin-adjustment-create/helpers.ts';
import {
  ERROR,
  TEXT,
  WO,
  approvePath,
  createWriteoffServer,
  denied,
  networkDown,
  passOf,
  writeoffStatusName,
  yuan,
  type RequestLog,
  type WriteoffServer,
} from '../admin-writeoff-approve/fixtures.ts';
import {
  approveDialog,
  approveOpen,
  approveWithSms,
  assertApproval,
  buttons,
  dialogsTitled,
  hasText,
  idemOf,
  openApprove,
  ready,
  refreshedAfter,
  rowApprove,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  usable,
} from '../admin-writeoff-approve/helpers.ts';

/** texts/adjustments.ts writeoffApprove.unknown: the approval got no reply in the envelope. */
const UNKNOWN =
  '上次提交结果未知：可能已经生效。重新读取后仍待批准时，再按【批准核销】用原内容原样重新提交（不会重复核销），或按【去列表核对】查看是否已处理。';
const CHECK = '去列表核对';

/** The write that carries the step-up pass `pass`. */
function carrying(pass: string) {
  return (request: RequestLog): boolean => request.headers.get('X-Step-Up-Token') === pass;
}

/**
 * The approval of `dialog` is in the result-unknown state: the notice shown, 【去列表核对】 in place
 * of 【取消】, no corner close, Escape does not close it, no step-up open.
 */
async function stillUnknown(server: WriteoffServer, dialog: HTMLElement): Promise<void> {
  expect(dialogsTitled(TEXT.title)).toEqual([dialog]);
  expect(hasText(dialog, UNKNOWN)).toBe(true);
  expect(usable(dialog, CHECK)).toHaveLength(1);
  expect(buttons(dialog, TEXT.cancel)).toEqual([]);
  expect(buttons(dialog, 'Close')).toEqual([]);
  await pressEscape(dialog);
  await settled(server);
  expect(dialogsTitled(TEXT.title)).toEqual([dialog]);
  expect(approveDialog()).toBe(dialog);
  expect(hasText(dialog, UNKNOWN)).toBe(true);
  expect(stepUpDialogs()).toEqual([]);
}

it(
  '[AC-F1-08as-WRITEOFF#1] 批准坏账核销：批准没拿到带外壳的回答 → 结果未知（重新读取列表后仍待批准）；再按【批准核销】短信验证后原键、请求体 {} 收到带外壳的 10403 admin_permission_denied：仍显示结果未知提示并显示「无权限执行坏账核销」、【去列表核对】代替【取消】、无右上角关闭、Esc 不关、不清键；再批准沿用原 Idempotency-Key 与请求体 {} 才解除：提示「已核销，候选单号 …，核销金额 ¥3.00」、关对话框、该行已核销，只核销一次',
  { timeout: 180_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);

    // 1. The approval never reaches the service; its reply is lost: result unknown.
    server.once('POST', approvePath(WO.recent), networkDown);
    const first = await approveWithSms(server, dialog);
    assertApproval(server, first, WO.recent, passOf(1));
    await waitFor(() => expect(refreshedAfter(server, first)).toBe(true));
    await settled(server);
    await waitFor(() => expect(approveOpen(dialog)).toBe(true));
    await stillUnknown(server, dialog);

    // 2. The retry is refused with 10403 (fund.writeoff withdrawn meanwhile): still unknown.
    server.once('POST', approvePath(WO.recent), denied, carrying(passOf(2)));
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, WO.recent, passOf(2));
    expect(idemOf(second)).toBe(idemOf(first));
    await waitFor(() => expect(shows(ERROR.forbidden)).toBe(true));
    await settled(server);
    await stillUnknown(server, dialog);
    expect(server.approvals()).toHaveLength(2);
    expect(server.candidates.find((one) => one.id === WO.recent)?.status).toBe('PENDING');

    // 3. Approving again sends the original key and {}: carried out once.
    await waitFor(() => expect(approveOpen(dialog)).toBe(true));
    const third = await approveWithSms(server, dialog);
    assertApproval(server, third, WO.recent, passOf(3));
    expect([first, second, third].map(idemOf)).toEqual([
      idemOf(first),
      idemOf(first),
      idemOf(first),
    ]);
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(rowApprove(WO.recent)).toEqual([]);
    expect(server.approvals()).toHaveLength(3);
    expect(server.unexpected()).toEqual([]);
  },
);
