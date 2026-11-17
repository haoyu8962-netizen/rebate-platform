// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  REASON,
  TEXT,
  approvePath,
  createApproveServer,
  rejectPath,
  statusName,
  yuan,
} from './fixtures.ts';
import {
  approveDialog,
  assertRejection,
  button,
  click,
  decisionsLocked,
  dialogsTitled,
  drawer,
  nonReadsSince,
  openApprove,
  openDetail,
  pressApprove,
  pressEverything,
  pressReject,
  ready,
  rowOf,
  settle,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  typeReason,
  usable,
  verifySms,
} from './helpers.ts';

it(
  '[AC-F1-08cc-BUSY#1] 批准提交中：【批准并短信验证】【驳回】【取消】都不可用、对话框保留，再点不发第二次、不发驳回、不再发码；返回成功后只有一次批准',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    const release = server.hold('POST', approvePath(ADJ.prefilled));
    await pressApprove(dialog);
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(1));
    await waitFor(() => expect(decisionsLocked(dialog)).toBe(true));
    expect(usable(dialog, TEXT.cancel)).toEqual([]);
    await typeReason(dialog, REASON);
    await pressEverything(dialog);
    await settle();
    expect(approveDialog()).toBe(dialog);
    expect(server.approvals()).toHaveLength(1);
    expect(server.rejections()).toEqual([]);
    expect(server.codeSends()).toHaveLength(1);
    expect(stepUpDialogs()).toEqual([]);

    release();
    await settled(server);
    await waitFor(() => expect(shows(TEXT.approved(ADJ.prefilled, yuan(2000)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('APPROVED')));
    expect(server.approvals()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
    expect(server.rejections()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-BUSY#2] 驳回提交中：【驳回】【批准并短信验证】【取消】都不可用、对话框保留，再点不发第二次、不发批准、不发码；返回成功后只有一次驳回',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    await typeReason(dialog, REASON);
    const release = server.hold('POST', rejectPath(ADJ.prefilled));
    await pressReject(dialog);
    await waitFor(() => expect(server.rejections()).toHaveLength(1));
    await waitFor(() => expect(decisionsLocked(dialog)).toBe(true));
    expect(usable(dialog, TEXT.cancel)).toEqual([]);
    await pressEverything(dialog);
    await settle();
    expect(approveDialog()).toBe(dialog);
    expect(server.rejections()).toHaveLength(1);
    expect(server.approvals()).toEqual([]);
    expect(server.codeSends()).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);

    release();
    await settled(server);
    assertRejection(server.rejections()[0]!, ADJ.prefilled, REASON);
    await waitFor(() => expect(shows(TEXT.rejected(ADJ.prefilled))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(statusOf(ADJ.prefilled)).toBe(statusName('REJECTED')));
    expect(server.rejections()).toHaveLength(1);
    expect(server.approvals()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-BUSY#3] 对话框【取消】：行上打开的关闭后焦点回到该行【批准】，详情里打开的关闭后焦点回到详情的【批准】；都不发任何写请求、单仍待批准',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    const since = server.log.length;
    const entry = button(rowOf(ADJ.prefilled), TEXT.approveEntry);
    const dialog = await openApprove(server, rowOf(ADJ.prefilled));
    await typeReason(dialog, REASON);
    await click(button(dialog, TEXT.cancel));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);

    await openDetail(server, ADJ.prefilled);
    const inDrawer = button(drawer(), TEXT.approveEntry);
    await openApprove(server, drawer());
    await click(button(approveDialog(), TEXT.cancel));
    await waitFor(() => expect(dialogsTitled(TEXT.approveTitle)).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(inDrawer));
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);
    expect(statusOf(ADJ.prefilled)).toBe(statusName('PENDING'));
  },
);
