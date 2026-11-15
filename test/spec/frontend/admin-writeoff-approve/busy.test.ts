// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  TEXT,
  WO,
  approvePath,
  createWriteoffServer,
  writeoffStatusName,
  yuan,
} from './fixtures.ts';
import {
  approveDialog,
  approveLocked,
  button,
  click,
  dialogsTitled,
  nonReadsSince,
  openApprove,
  pressApprove,
  pressEverything,
  ready,
  rowOf,
  settle,
  settled,
  shows,
  statusOf,
  stepUpDialogs,
  usable,
  verifySms,
} from './helpers.ts';

it(
  '[AC-F1-08cd-BUSY#1] 批准提交中：【批准核销】【取消】都不可用、对话框保留，再点不发第二次、不再发码；返回成功后只有一次批准',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const dialog = await openApprove(server, WO.recent);
    const release = server.hold('POST', approvePath(WO.recent));
    await pressApprove(dialog);
    await verifySms(server);
    await waitFor(() => expect(server.approvals()).toHaveLength(1));
    await waitFor(() => expect(approveLocked(dialog)).toBe(true));
    expect(usable(dialog, TEXT.cancel)).toEqual([]);
    await pressEverything(dialog);
    await settle();
    expect(approveDialog()).toBe(dialog);
    expect(server.approvals()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
    expect(stepUpDialogs()).toEqual([]);

    release();
    await settled(server);
    await waitFor(() => expect(shows(TEXT.approved(WO.recent, yuan(300)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    expect(server.approvals()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cd-BUSY#2] 对话框【取消】：关闭后焦点回到打开它的那一行的【批准核销】（两张待批准候选单各试一次）；都不发任何写请求、候选单仍待批准',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const since = server.log.length;
    for (const id of [WO.recent, WO.blocked]) {
      const entry = button(rowOf(id), TEXT.approveEntry);
      const dialog = await openApprove(server, id);
      await click(button(dialog, TEXT.cancel));
      await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
      await waitFor(() => expect(document.activeElement).toBe(entry));
      await settled(server);
      expect(nonReadsSince(server, since), id).toEqual([]);
      expect(statusOf(id), id).toBe(writeoffStatusName('PENDING'));
    }
  },
);
