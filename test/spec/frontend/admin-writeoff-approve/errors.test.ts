// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ERROR,
  TEXT,
  USER,
  WO,
  WRITEOFFS,
  approvePath,
  conflict,
  createWriteoffServer,
  denied,
  passOf,
  stateChanged,
  stepUpRequired,
  unknownCandidate,
  writeoffStatusName,
  yuan,
} from './fixtures.ts';
import {
  approveDialog,
  approveOpen,
  approveWithSms,
  assertApproval,
  buttons,
  click,
  dialogsTitled,
  hasText,
  idemOf,
  openApprove,
  pressApprove,
  ready,
  rowApprove,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  verifySms,
} from './helpers.ts';

it(
  '[AC-F1-08cd-ERROR#1] 拦截态：打开后用户又有了冻结金额，批准返回 20001 data.reason=writeoff_frozen_pending → 对话框里提示「该用户有冻结中的提现金额（提现单未到终态），暂不能核销：请先把提现单处理到终态，候选单保持待批准。」、对话框保留、该行仍待批准，不自动重发；提现单处理完（冻结回到 0）后再次批准重新短信验证、换新的 Idempotency-Key，核销成功',
  { timeout: 120_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    expect(hasText(dialog, ERROR.frozenPending)).toBe(false);
    server.setBalance(USER.negative, -300, 2000);
    const first = await approveWithSms(server, dialog);
    assertApproval(server, first, WO.recent, passOf(1));
    await waitFor(() => expect(hasText(approveDialog(), ERROR.frozenPending)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    await settled(server);
    expect(statusOf(WO.recent)).toBe(writeoffStatusName('PENDING'));
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);

    server.setBalance(USER.negative, -300, 0);
    await waitFor(() => expect(approveOpen(dialog)).toBe(true));
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, WO.recent, passOf(2));
    expect(idemOf(second)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(server.approvals()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cd-ERROR#2] 有冻结金额的候选单（approve_blocked=true）照样可以提交，服务端返回 writeoff_frozen_pending：冻结提示仍在、对话框保留、该行仍待批准且仍有【批准核销】；不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.blocked);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.blocked, passOf(1));
    await settled(server);
    await waitFor(() => expect(hasText(approveDialog(), ERROR.frozenPending)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    expect(statusOf(WO.blocked)).toBe(writeoffStatusName('PENDING'));
    expect(rowApprove(WO.blocked)).toHaveLength(1);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-ERROR#3] 批准时候选单已被别人核销：返回 20902（data.resource=bad_debt_writeoff）→ 提示「该核销候选单已不是待批准状态，已刷新」、关对话框、列表重新读取：该行已核销、不再有【批准核销】；不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    const reads = server.tableReads(WRITEOFFS).length;
    server.once('POST', approvePath(WO.recent), () => {
      server.approveElsewhere(WO.recent);
      return stateChanged();
    });
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.recent, passOf(1));

    await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(server.tableReads(WRITEOFFS).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(rowApprove(WO.recent)).toEqual([]);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-ERROR#4] 批准返回 10003 data.tier=sms（验证已失效）：重新发验证码、再弹短信验证，验证后用新的验证重放请求体 {} 与同一个 Idempotency-Key（契约：重放沿用原键），成功只核销一次',
  { timeout: 120_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    server.once('POST', approvePath(WO.recent), stepUpRequired);
    await pressApprove(dialog);
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(1));
    await waitFor(() => expect(server.codeSends()).toHaveLength(2));
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(2));
    await settled(server);
    await waitFor(() => expect(stepUpDialogs()).toEqual([]));

    const [first, second] = server.approvals();
    assertApproval(server, first!, WO.recent, passOf(1));
    assertApproval(server, second!, WO.recent, passOf(2));
    expect(idemOf(second!)).toBe(idemOf(first!));
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(server.approvals()).toHaveLength(2);
    expect(server.verifications()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cd-ERROR#5] 10403（本地有 fund.writeoff、服务端不认）：提示「无权限执行坏账核销」、对话框保留、该行仍待批准，不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    server.once('POST', approvePath(WO.recent), denied);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.recent, passOf(1));
    await waitFor(() => expect(shows(ERROR.forbidden)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    await settled(server);
    expect(statusOf(WO.recent)).toBe(writeoffStatusName('PENDING'));
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-ERROR#6] 20001 data.fields=[id]（没有 reason）：提示「核销候选单不存在或已不可见，请刷新后重试」，只发一次、不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    server.once('POST', approvePath(WO.recent), unknownCandidate);
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.recent, passOf(1));
    await waitFor(() => expect(shows(ERROR.missing)).toBe(true));
    expect(shows(ERROR.frozenPending)).toBe(false);
    await settled(server);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-ERROR#7] 20901（同键不同请求体）：提示「提交失败，请稍后重试」、对话框保留、不自动重发；再次批准重新短信验证并换新的 Idempotency-Key，成功只核销一次',
  { timeout: 120_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    server.once('POST', approvePath(WO.recent), conflict);
    const first = await approveWithSms(server, dialog);
    await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
    expect(approveDialog()).toBe(dialog);
    await settled(server);
    expect(server.approvals()).toHaveLength(1);

    await waitFor(() => expect(approveOpen(dialog)).toBe(true));
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, WO.recent, passOf(2));
    expect(idemOf(second)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(server.approvals()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cd-ERROR#8] 未登记验证手机号（发码返回 10003 data.reason=verify_phone_missing）：提示「这项操作需要短信验证，请先登记验证手机号」，不弹验证、不发批准，对话框保留；再按【批准核销】也不再发码、不弹验证',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer({ verifyPhone: false });
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    await pressApprove(dialog);
    await waitFor(() => expect(server.codeSends()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(shows(ERROR.verifyPhoneMissing)).toBe(true));
    expect(stepUpDialogs()).toEqual([]);
    expect(server.verifications()).toEqual([]);
    expect(server.approvals()).toEqual([]);
    expect(approveDialog()).toBe(dialog);

    for (const node of buttons(dialog, TEXT.approve)) await click(node);
    await settled(server);
    expect(stepUpDialogs()).toEqual([]);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toEqual([]);
    expect(server.approvals()).toEqual([]);
    expect(shows(ERROR.verifyPhoneMissing)).toBe(true);
  },
);
