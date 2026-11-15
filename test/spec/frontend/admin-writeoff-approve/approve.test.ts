// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENTS,
  TEXT,
  USER,
  WO,
  WRITEOFFS,
  WRITEOFF_COLUMN,
  createWriteoffServer,
  passOf,
  writeoffStatusName,
  yuan,
} from './fixtures.ts';
import {
  approveWithSms,
  assertApproval,
  cellOf,
  dialogsTitled,
  idemOf,
  openApprove,
  ready,
  rowApprove,
  settled,
  shows,
  statusOf,
} from './helpers.ts';

/** The row `id` after the decision: status, current available, and no 【批准核销】. */
async function decidedRow(id: string, status: string, available: string): Promise<void> {
  await waitFor(() => expect(statusOf(id)).toBe(writeoffStatusName(status)));
  expect(cellOf(id, WRITEOFF_COLUMN.available)).toBe(available);
  expect(rowApprove(id)).toEqual([]);
}

it(
  '[AC-F1-08cd-APPROVE#1] 【批准核销】：先发验证码、短信验证通过后只发一次 POST /admin/v1/bad-debt-writeoffs/{id}/approve，请求体恰为 {}（不带金额），带 X-Step-Up-Token 与 Idempotency-Key；返回已核销 → 提示候选单号与核销金额（written_off_fen 3 元）、关对话框、列表刷新：该行已核销、当前可用余额 0、不再有【批准核销】',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    const reads = server.tableReads(WRITEOFFS).length;
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.recent, passOf(1));
    expect(server.approvals()).toHaveLength(1);

    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(server.tableReads(WRITEOFFS).length).toBeGreaterThan(reads));
    await settled(server);
    await decidedRow(WO.recent, 'APPROVED', yuan(0));
    expect(statusOf(WO.blocked)).toBe(writeoffStatusName('PENDING'));
    expect(server.approvals()).toHaveLength(1);
    expect(server.unexpected()).toEqual([]);
    expect(server.requestsUnder(ADJUSTMENTS)).toEqual([]);
  },
);

it(
  '[AC-F1-08cd-APPROVE#2] 打开对话框之后用户入账、可用余额由负 3 元变为负 1.20 元：请求体仍恰为 {}，提示按服务端批准时的余额核销 1.20 元（不用生成时金额、也不用打开时的余额）；该行已核销、可用余额 0',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    server.setBalance(USER.negative, -120, 0);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.recent, passOf(1));

    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(120)))).toBe(true));
    expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(false);
    expect(shows(TEXT.approved(WO.recent, yuan(800)))).toBe(false);
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await settled(server);
    await decidedRow(WO.recent, 'APPROVED', yuan(0));
    expect(server.approvals()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-APPROVE#3] 批准前余额已回正（可用余额 2 元）：服务端仍回 200，候选单置为已取消、written_off_fen=0 → 提示「可用余额已回正，候选单已取消，未记坏账，候选单号 …」（不提示已核销）、关对话框、列表刷新：该行已取消、不再有【批准核销】；只发一次',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    const reads = server.tableReads(WRITEOFFS).length;
    server.setBalance(USER.negative, 200, 0);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.recent, passOf(1));

    await waitFor(() => expect(shows(TEXT.cancelled(WO.recent))).toBe(true));
    expect(shows(TEXT.approved(WO.recent, yuan(0)))).toBe(false);
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(server.tableReads(WRITEOFFS).length).toBeGreaterThan(reads));
    await settled(server);
    await decidedRow(WO.recent, 'CANCELLED', yuan(200));
    expect(server.approvals()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-APPROVE#4] 开关关闭（approve_blocked=false）时有冻结金额的候选单照常核销：请求体恰为 {}，提示核销金额 123.45 元，该行已核销；页面不按冻结金额自行拦截',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer({ requireNoFrozen: false });
    await ready(server);
    const dialog = await openApprove(server, WO.blocked);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.blocked, passOf(1));

    await waitFor(() => expect(shows(TEXT.approved(WO.blocked, yuan(12345)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await settled(server);
    await decidedRow(WO.blocked, 'APPROVED', yuan(0));
    expect(server.approvals()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-APPROVE#5] 两张候选单依次批准（第二张的冻结已在打开前处理完）：各自短信验证一次、各发一次请求体 {} 的 POST 到各自的候选单号，两次的 Idempotency-Key 不同（成功后换新键）；两行都显示已核销',
  { timeout: 120_000 },
  async () => {
    const server = createWriteoffServer();
    server.setBalance(USER.frozen, -12345, 0);
    await ready(server);

    const first = await approveWithSms(server, await openApprove(server, WO.recent));
    assertApproval(server, first, WO.recent, passOf(1));
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await settled(server);
    await decidedRow(WO.recent, 'APPROVED', yuan(0));

    const second = await approveWithSms(server, await openApprove(server, WO.blocked));
    assertApproval(server, second, WO.blocked, passOf(2));
    expect(idemOf(second)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.approved(WO.blocked, yuan(12345)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await settled(server);
    await decidedRow(WO.blocked, 'APPROVED', yuan(0));
    await decidedRow(WO.recent, 'APPROVED', yuan(0));
    expect(server.approvals()).toHaveLength(2);
  },
);
