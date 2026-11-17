// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  ADJ,
  ADJUSTMENTS,
  BALANCE,
  BALANCE_LABELS,
  DELETING_AVAILABLE,
  SMS_CODES,
  TEXT,
  VERIFY,
  approvePath,
  createApproveServer,
  detailPath,
  ok,
  rejectPath,
  unavailable,
  yuan,
  type ApproveServer,
} from '../admin-adjustment-approve/fixtures.ts';
import {
  approveDialog,
  button,
  click,
  dialogsTitled,
  fields,
  hasText,
  norm,
  openApprove,
  ready,
  rowApprove,
  rowOf,
  settled,
  statusOf,
  stepUpDialogs,
  usable,
} from '../admin-adjustment-approve/helpers.ts';

type Detail = Schema<'AdminAdjustmentDetail'>;
type Processed = Exclude<Detail['adjustment']['status'], 'PENDING'>;

// BR-FUND-24 / BR-ID-34：列表仍是待批准，打开时的读单才发现已经处理。
// 复用冻结假服务端的日志与挂载；仅在 GET 回答时更新服务端单据，供后续列表重读。
// APPROVED 也明确返回空预览，不能因 balance_preview 为空而把操作员留在对话框里。
function processedOnRead(server: ApproveServer, status: Processed): void {
  server.once('GET', detailPath(ADJ.prefilled), () => {
    if (status === 'APPROVED') server.approveElsewhere(ADJ.prefilled);
    if (status === 'REJECTED') server.rejectElsewhere(ADJ.prefilled);
    const form = server.forms.find((item) => item.adjust_id === ADJ.prefilled);
    expect(form).toBeDefined();
    form!.status = status;
    const detail: Detail = { adjustment: structuredClone(form!), balance_preview: null };
    return ok(detail);
  });
}

function assertNoWrites(server: ApproveServer): void {
  expect(server.requests('POST', approvePath(ADJ.prefilled)).length).toBe(0);
  expect(server.requests('POST', rejectPath(ADJ.prefilled)).length).toBe(0);
  expect(server.requests('POST', SMS_CODES).length).toBe(0);
  expect(server.requests('POST', VERIFY).length).toBe(0);
  expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(stepUpDialogs()).toEqual([]);
}

function assertDetailReads(server: ApproveServer, count: number): void {
  expect(
    server.detailReads(ADJ.prefilled).map((request) => ({
      method: request.method,
      path: request.path,
      query: request.query,
    })),
  ).toEqual(
    Array.from({ length: count }, () => ({
      method: 'GET',
      path: `/admin/v1/adjustments/${ADJ.prefilled}`,
      query: {},
    })),
  );
}

async function assertStale(
  server: ApproveServer,
  previousLists: number,
  detailCount: number,
  statusText: string,
): Promise<void> {
  // 主干每个 it 块都在这里断言失败：首次读单 / 读取失败后的重试均未触发 onStale。
  await waitFor(() => expect(dialogsTitled('批准调账单')).toEqual([]));
  await settled(server);
  const warnings = screen
    .queryAllByRole('alert')
    .filter((alert) => alert.classList.contains('ant-alert-warning'));
  expect(warnings.map((alert) => norm(alert.textContent))).toEqual([
    '该调账单已不是待批准状态，已刷新',
  ]);
  await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusText));
  expect(rowApprove(ADJ.prefilled)).toEqual([]);
  const lists = server.tableReads(ADJUSTMENTS);
  expect(lists.length).toBe(previousLists + 1);
  expect(lists.at(-1)?.method).toBe('GET');
  expect(lists.at(-1)?.path).toBe('/admin/v1/adjustments');
  expect(server.log.indexOf(lists.at(-1)!)).toBeGreaterThan(
    server.log.indexOf(server.detailReads(ADJ.prefilled).at(-1)!),
  );
  assertDetailReads(server, detailCount);
  assertNoWrites(server);
}

it(
  '[AC-F1-08cg-OPEN#1] PENDING 仍展示余额且允许批准；取消后再打开读回 APPROVED 空预览，关闭并完整提示 warning、刷新为已生效，全程零写请求和二次验证',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const lists = server.tableReads(ADJUSTMENTS).length;
    expect(statusOf(ADJ.prefilled)).toBe('待批准');
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    expect(dialogsTitled('批准调账单').length).toBe(1);
    expect(fields(dialog, BALANCE_LABELS)).toEqual({
      [BALANCE.before]: yuan(DELETING_AVAILABLE),
      [BALANCE.amount]: yuan(DELETING_AVAILABLE),
      [BALANCE.after]: yuan(0),
    });
    expect(usable(dialog, '批准并短信验证').length).toBe(1);
    expect(hasText(document.body, '该调账单已不是待批准状态，已刷新')).toBe(false);
    expect(server.tableReads(ADJUSTMENTS).length).toBe(lists);
    assertDetailReads(server, 1);
    assertNoWrites(server);

    await click(button(dialog, TEXT.cancel));
    await waitFor(() => expect(dialogsTitled('批准调账单')).toEqual([]));
    expect(statusOf(ADJ.prefilled)).toBe('待批准');
    processedOnRead(server, 'APPROVED');
    await click(button(rowOf(ADJ.prefilled), TEXT.approveEntry));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBe(2));
    await assertStale(server, lists, 2, '已生效');
  },
);

it(
  '[AC-F1-08cg-OPEN#2] 列表待批准，打开读回 REJECTED 空预览：关闭并完整提示 warning、刷新为已驳回，零批准、驳回和二次验证请求',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const lists = server.tableReads(ADJUSTMENTS).length;
    expect(statusOf(ADJ.prefilled)).toBe('待批准');
    processedOnRead(server, 'REJECTED');
    await click(button(rowOf(ADJ.prefilled), TEXT.approveEntry));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBe(1));
    await assertStale(server, lists, 1, '已驳回');
  },
);

it(
  '[AC-F1-08cg-OPEN#3] 列表待批准，打开读回 CANCELLED 空预览：关闭并完整提示 warning、刷新为已撤回，零批准、驳回和二次验证请求',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const lists = server.tableReads(ADJUSTMENTS).length;
    expect(statusOf(ADJ.prefilled)).toBe('待批准');
    processedOnRead(server, 'CANCELLED');
    await click(button(rowOf(ADJ.prefilled), TEXT.approveEntry));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBe(1));
    await assertStale(server, lists, 1, '已撤回');
  },
);

it(
  '[AC-F1-08cg-REREAD#1] 打开读单先返回 5xx，显示读取失败；重新读取返回 APPROVED 空预览，关闭并完整提示 warning、刷新为已生效，全程零写请求和二次验证',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const lists = server.tableReads(ADJUSTMENTS).length;
    expect(statusOf(ADJ.prefilled)).toBe('待批准');
    server.once('GET', detailPath(ADJ.prefilled), unavailable);
    await openApprove(server, rowOf(ADJ.prefilled));
    const dialog = approveDialog();
    expect(hasText(dialog, '调账单读取失败')).toBe(true);
    expect(usable(dialog, '重新读取').length).toBe(1);
    expect(hasText(document.body, '该调账单已不是待批准状态，已刷新')).toBe(false);
    expect(server.tableReads(ADJUSTMENTS).length).toBe(lists);
    assertDetailReads(server, 1);
    assertNoWrites(server);

    processedOnRead(server, 'APPROVED');
    await click(button(dialog, '重新读取'));
    await waitFor(() => expect(server.detailReads(ADJ.prefilled).length).toBe(2));
    await assertStale(server, lists, 2, '已生效');
  },
);
