// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NUMBER } from '../admin-orders/orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  loaded,
  mainElement,
  mount,
  query,
  row,
  settled,
} from '../admin-orders/orders-helpers.ts';
import { listRequestAfter } from '../admin-orders-standard/kit.ts';
import { RECORD, statusName } from '../admin-orders-sync/fixtures.ts';
import {
  SYNC_ERROR_MESSAGE,
  createPageServer,
  expectInitialSync,
  expectSummaryAboveList,
  serverWithFailedSync,
} from './kit.ts';

it(
  '[AC-F1-07edb-SYNC-BAR#1] 初次加载只取最近一条同步记录，列表上方常驻平台、中文状态和北京时间',
  async () => {
    const { server } = await mount(createPageServer());
    await loaded();
    await settled(server);
    expectInitialSync(server);
    const latest = ['淘宝', statusName(RECORD.queued.status), /10[-/]22\s*17:00/];
    await waitFor(() => expectSummaryAboveList(latest));

    await query();
    expect(await listRequestAfter(server, 1)).toEqual({ page: '1', page_size: '20' });
    await loaded();
    expectSummaryAboveList(latest);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-SYNC-BAR#2] 没有同步记录时状态条显示空态，订单仍可见',
  async () => {
    const { server } = await mount(createPageServer(undefined, { records: [] }));
    await loaded();
    await settled(server);
    expectInitialSync(server);
    await waitFor(() => expectSummaryAboveList(['暂无同步记录']));
    expect(row().textContent).toContain(NUMBER);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-SYNC-BAR#3] 同步记录读取失败只在状态条提示，列表照常显示且无全局错误',
  async () => {
    const { server } = await mount(serverWithFailedSync());
    await loaded();
    await settled(server);
    expectInitialSync(server);
    await waitFor(() => expectSummaryAboveList(['同步状态读取失败']));
    expect(row().textContent).toContain(NUMBER);
    expect(document.body.textContent).not.toContain(SYNC_ERROR_MESSAGE);
    const notices = document.querySelectorAll('.ant-notification-notice, .ant-message-notice');
    expect(notices).toHaveLength(0);
    expect(within(document.body).queryAllByRole('alertdialog')).toEqual([]);
    const main = mainElement();
    const alerts = within(document.body).queryAllByRole('alert');
    expect(alerts.filter((alert) => !main.contains(alert))).toEqual([]);
  },
  FLOW_TIMEOUT,
);
