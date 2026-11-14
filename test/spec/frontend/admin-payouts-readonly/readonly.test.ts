// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ALL, QNO, VIEW_EXECUTE, createPayoutServer, pausedOverview } from './fixtures.ts';
import {
  COLUMN,
  ENTRY,
  MULTI_TIMEOUT,
  SUB_TAB,
  SUPER,
  TAB,
  click,
  entry,
  everyGrant,
  gridWith,
  listed,
  mount,
  openDialog,
  openTab,
  rowIn,
  selectTab,
  settled,
  writeEntries,
} from './helpers.ts';

// F1-08ba ⑤: the two tabs are read only. Even for an account holding every payout point (and a super
// admin), with the queue paused and a channel paused, neither tab nor the 打款记录 drawer offers any
// write entry of the later payout tasks or of the detail (执行所选, 录入企业支付宝余额, 录入运营账户余额,
// 暂停队列, 解除暂停, 解除通道暂停, 手动成功, 立即查询, 人工处置 …), shown or hidden, usable or not,
// and nothing but GET requests is sent.

const ALL_ROWS = [QNO.approvedA, QNO.paying, QNO.approvedB, QNO.stuck, QNO.untried];

it(
  '[AC-F1-08ba-READONLY#1] 全部打款权限点与超管、队列与通道暂停时：「打款队列」（全部 / 打款中 / 待执行）、打款记录抽屉与「结果待确认」都没有任何写入口（含隐藏、置灰），全程只发 GET',
  { timeout: MULTI_TIMEOUT },
  async () => {
    // Since F1-08bc (D10-1712 (a)) the entries landed so far are exactly 【录入企业支付宝余额】 and
    // 【录入运营账户余额】 (fund.cash_entry, which a super admin holds and ALL does not), on the
    // 打款队列 tab whatever its sub-tab; since F1-08bd also the pause entries (switch.payout, which
    // a super admin holds and ALL does not): the queue is paused here, so 【解除暂停】, and one
    // 【解除通道暂停】 for each paused channel (企业支付宝 and 微信零钱).
    const landed = [
      '录入企业支付宝余额',
      '录入运营账户余额',
      '解除暂停',
      '解除通道暂停',
      '解除通道暂停',
    ].sort();
    const accounts = [everyGrant(ALL), SUPER];
    for (const snapshot of accounts) {
      const server = createPayoutServer({
        overview: pausedOverview(),
        permissions: snapshot === SUPER ? VIEW_EXECUTE : ALL,
      });
      await mount(server, snapshot);
      const queue = await openTab(TAB.queue);
      await listed(queue, ALL_ROWS);
      await waitFor(() => expect(server.overviewReads()).toHaveLength(1));
      await settled(server);
      const queueEntries = snapshot === SUPER ? landed : [];
      expect(writeEntries(queue).sort(), 'the write entries of 全部').toEqual(queueEntries);
      for (const tab of [SUB_TAB.paying, SUB_TAB.approved]) {
        await selectTab(queue, tab);
        await settled(server);
        expect(writeEntries(queue).sort(), `the write entries of ${tab}`).toEqual(queueEntries);
      }
      await selectTab(queue, SUB_TAB.all);
      await listed(queue, ALL_ROWS);
      const grid = gridWith(queue, COLUMN.net);
      await click(entry(rowIn(grid, QNO.paying), ENTRY.attempts));
      const drawer = await openDialog();
      await settled(server);
      expect(writeEntries(drawer), 'no write entry in the drawer').toEqual([]);

      const unknown = await openTab(TAB.unknown);
      await listed(unknown, [QNO.stuck, QNO.untried]);
      await settled(server);
      expect(writeEntries(unknown), 'no write entry in 结果待确认').toEqual([]);
      expect(server.writes(), 'no request other than GET').toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08bc-FROZEN#1] 非超管、持全部财务权限点再加 fund.cash_entry：「打款队列」的全部 / 打款中 / 待执行上写入口恰为【录入企业支付宝余额】【录入运营账户余额】，「结果待确认」没有写入口；回到「打款队列」按【录入企业支付宝余额】打开一个写着企业支付宝的对话框；全程只发 GET',
  { timeout: MULTI_TIMEOUT },
  async () => {
    // F1-08bc: the entries follow the point fund.cash_entry, not the super flag.
    const grants: typeof ALL = [...ALL, 'fund.cash_entry'];
    const landed = ['录入企业支付宝余额', '录入运营账户余额'].sort();
    const server = createPayoutServer({ permissions: grants });
    await mount(server, everyGrant(grants));
    const queue = await openTab(TAB.queue);
    await listed(queue, ALL_ROWS);
    await waitFor(() => expect(server.overviewReads().length).toBeGreaterThan(0));
    await settled(server);
    expect(writeEntries(queue).sort(), 'the write entries of 全部').toEqual(landed);
    for (const tab of [SUB_TAB.paying, SUB_TAB.approved]) {
      await selectTab(queue, tab);
      await settled(server);
      expect(writeEntries(queue).sort(), `the write entries of ${tab}`).toEqual(landed);
    }

    const unknown = await openTab(TAB.unknown);
    await listed(unknown, [QNO.stuck, QNO.untried]);
    await settled(server);
    expect(writeEntries(unknown), 'no write entry in 结果待确认').toEqual([]);

    const back = await openTab(TAB.queue);
    await selectTab(back, SUB_TAB.all);
    await listed(back, ALL_ROWS);
    await settled(server);
    await click(entry(back, '录入企业支付宝余额'));
    const dialog = await openDialog();
    await settled(server);
    expect(dialog.textContent ?? '', 'the dialog is for 企业支付宝').toContain('企业支付宝');
    expect(server.writes(), 'no request other than GET').toEqual([]);
  },
);
