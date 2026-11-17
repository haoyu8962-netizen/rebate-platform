// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ERROR,
  TEXT,
  WO,
  WRITEOFFS,
  approvePath,
  createWriteoffServer,
  networkDown,
  passOf,
  stillRunning,
  unavailable,
  writeoffRead,
  writeoffStatusName,
  yuan,
  type RequestLog,
} from './fixtures.ts';
import {
  approveDialog,
  approveLocked,
  approveOpen,
  approveWithSms,
  assertApproval,
  dialogsTitled,
  idemOf,
  openApprove,
  pressApprove,
  pressEverything,
  ready,
  refreshedAfter,
  rowApprove,
  settle,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  verifySms,
} from './helpers.ts';

// A write whose outcome is unknown (a network failure, a 5xx or 40901) may have been carried out:
// the dialog reads the list again (GET /admin/v1/bad-debt-writeoffs) before the operator can
// submit again; while the candidate is PENDING the next submission replays the same
// Idempotency-Key, once it is not PENDING any more nothing is sent (编排 D10-1731).

it(
  '[AC-F1-08cd-RETRY#1] 批准结果未定（网络断开、50001、40901）：每次提示「提交失败，请稍后重试」、对话框保留、不自动重发，并在失败后重新读取候选单列表；再次批准重新短信验证、沿用同一个 Idempotency-Key 与请求体 {}，最终只核销一次',
  { timeout: 180_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    const sent: RequestLog[] = [];
    for (const reply of [networkDown, unavailable, stillRunning]) {
      server.once('POST', approvePath(WO.recent), reply);
      const request = await approveWithSms(server, dialog);
      sent.push(request);
      await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
      await waitFor(() => expect(refreshedAfter(server, request)).toBe(true));
      await settled(server);
      expect(approveDialog()).toBe(dialog);
      await waitFor(() => expect(approveOpen(dialog)).toBe(true));
      expect(statusOf(WO.recent)).toBe(writeoffStatusName('PENDING'));
      expect(server.approvals()).toHaveLength(sent.length);
    }
    sent.push(await approveWithSms(server, dialog));
    for (const [index, request] of sent.entries())
      assertApproval(server, request, WO.recent, passOf(index + 1));
    expect(sent.map(idemOf)).toEqual(Array.from({ length: 4 }, () => idemOf(sent[0]!)));
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(server.approvals()).toHaveLength(4);
  },
);

it(
  '[AC-F1-08cd-RETRY#2] 先刷新再允许重提：批准网络失败后重新读取列表，读取返回前【批准核销】不可用、再点不发码不发请求；读取返回仍待批准后才可用，再次批准沿用原键',
  { timeout: 120_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    server.once('POST', approvePath(WO.recent), networkDown);
    const read = writeoffRead();
    const release = server.hold('GET', WRITEOFFS, (request) => {
      return server.approvals().length > 0 && read(request);
    });
    await pressApprove(dialog);
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(1));
    const failed = server.approvals()[0]!;
    await waitFor(() => expect(refreshedAfter(server, failed)).toBe(true));
    await settle();
    expect(approveDialog()).toBe(dialog);
    await waitFor(() => expect(approveLocked(dialog)).toBe(true));
    await pressEverything(dialog);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.approvals()).toHaveLength(1);
    expect(stepUpDialogs()).toEqual([]);

    release();
    await settled(server);
    await waitFor(() => expect(approveOpen(dialog)).toBe(true));
    const second = await approveWithSms(server, dialog);
    assertApproval(server, second, WO.recent, passOf(2));
    expect(idemOf(second)).toBe(idemOf(failed));
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    expect(server.approvals()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cd-RETRY#3] 批准其实已生效、只是回答丢了（网络断开）：重新读取后该行已核销 → 提示「该核销候选单已不是待批准状态，已刷新」、关对话框、该行不再有【批准核销】；不再发批准、不再发码',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    server.lose('POST', approvePath(WO.recent));
    const request = await approveWithSms(server, dialog);
    assertApproval(server, request, WO.recent, passOf(1));
    await waitFor(() => expect(refreshedAfter(server, request)).toBe(true));
    await settled(server);
    await waitFor(() => expect(shows(ERROR.stale)).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(rowApprove(WO.recent)).toEqual([]);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
  },
);
