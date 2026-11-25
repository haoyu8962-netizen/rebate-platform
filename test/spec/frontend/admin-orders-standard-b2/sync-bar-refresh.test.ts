// @vitest-environment jsdom
import { act, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  NUMBER,
  ORDERS,
  PLATFORM_NAME,
  SYNCS,
  createServer,
  failure,
  ok,
  statusName,
  syncRecords,
  type Server,
  type SyncItem,
} from '../admin-orders-sync/fixtures.ts';
import {
  FLOW_TIMEOUT,
  SUBMITTED,
  click,
  freshText,
  main,
  mount,
  mountList,
  prepareOrderNos,
  settled,
  snapshotText,
  submit,
} from '../admin-orders-sync/helpers.ts';
import { SYNC_ERROR_MESSAGE, expectSummaryAboveList } from './kit.ts';

const FIRST_READ_AT = '2026-11-25T02:03:04Z';
const FIRST_UPDATED = /更新于\s*10:03:04(?!\d)/;
const SECOND_UPDATED = /更新于\s*01:08:09(?!\d)/;
const FIRST_RECORD = ['淘宝', statusName('queued'), /10[-/]22\s*17:00/];
const LATEST_QUERY = { page: '1', page_size: '1' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIRST_READ_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

function syncQueries(server: Server) {
  return server.recordReads().map(({ query }) => query);
}

function holdSyncReply(server: Server, item: SyncItem): () => void {
  const gate = Promise.withResolvers<void>();
  server.once('GET', SYNCS, async () => {
    await gate.promise;
    return ok({ items: [item], page: 1, page_size: 1, total: 1 });
  });
  return () => gate.resolve();
}

function refreshButton(): HTMLElement {
  const summary = expectSummaryAboveList(FIRST_RECORD);
  const table = within(main()).getByRole('table');
  // The button can sit beside the record within the bar above the list.
  let controls: HTMLElement[] = [];
  for (
    let scope: HTMLElement | null = summary;
    scope && !scope.contains(table);
    scope = scope.parentElement
  ) {
    controls = within(scope).queryAllByRole('button', { name: '刷新' });
    if (controls.length > 0) break;
  }
  expect(controls, '同步状态条旁应有【刷新】按钮').toHaveLength(1);
  return controls[0]!;
}

it(
  '[AC-F1-07edb-SYNC-REFRESH#1] 初次读取成功后，状态条显示读取成功时的北京时间「更新于 HH:mm:ss」',
  async () => {
    const server = createServer();
    const release = holdSyncReply(server, syncRecords()[0]!);
    vi.setSystemTime(new Date('2026-11-25T01:00:00Z'));
    try {
      await mount(server);
      await waitFor(() => expect(syncQueries(server)).toEqual([LATEST_QUERY]));
      vi.setSystemTime(new Date(FIRST_READ_AT));
    } finally {
      await act(async () => release());
    }

    await settled(server);
    await waitFor(() => expectSummaryAboveList([...FIRST_RECORD, FIRST_UPDATED]));
    expect(syncQueries(server)).toEqual([LATEST_QUERY]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-SYNC-REFRESH#2] 点击【刷新】只重读一次最近同步记录，更新条内的记录和读取时刻',
  async () => {
    const { server } = await mountList();
    await waitFor(() => expectSummaryAboveList(FIRST_RECORD));
    expect(syncQueries(server)).toEqual([LATEST_QUERY]);
    const listReadCount = server.requests('GET', ORDERS).length;
    const refresh = refreshButton();
    expectSummaryAboveList([...FIRST_RECORD, FIRST_UPDATED]);

    const release = holdSyncReply(server, {
      ...syncRecords()[1]!,
      created_at: '2026-11-25T02:30:00Z',
      finished_at: '2026-11-25T02:31:00Z',
    });
    try {
      vi.setSystemTime(new Date('2026-11-25T03:00:00Z'));
      await click(refresh);
      await waitFor(() => expect(syncQueries(server)).toEqual([LATEST_QUERY, LATEST_QUERY]));
      vi.setSystemTime(new Date('2026-11-25T17:08:09Z'));
    } finally {
      await act(async () => release());
    }

    await settled(server);
    await waitFor(() => {
      const summary = expectSummaryAboveList(['拼多多', statusName('done'), SECOND_UPDATED]);
      expect(summary.textContent).not.toContain('淘宝');
      expect(summary.textContent).not.toContain(statusName('queued'));
      expect(summary.textContent).not.toMatch(FIRST_UPDATED);
    });
    expect(syncQueries(server)).toEqual([LATEST_QUERY, LATEST_QUERY]);
    expect(server.requests('GET', ORDERS)).toHaveLength(listReadCount);
    expect(server.limitReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-SYNC-REFRESH#3] 刷新失败只在状态条提示，订单行仍在且无全局错误',
  async () => {
    const { server } = await mountList();
    await waitFor(() => expectSummaryAboveList(FIRST_RECORD));
    expect(syncQueries(server)).toEqual([LATEST_QUERY]);
    server.once('GET', SYNCS, () => failure(50001, undefined, SYNC_ERROR_MESSAGE));

    await click(refreshButton());
    const summary = await waitFor(() => expectSummaryAboveList(['同步状态读取失败']));
    await settled(server);
    expect(syncQueries(server)).toEqual([LATEST_QUERY, LATEST_QUERY]);
    const rows = within(within(main()).getByRole('table')).queryAllByRole('row');
    expect(rows.some((row) => row.textContent?.includes(NUMBER))).toBe(true);
    expect(document.body.textContent).not.toContain(SYNC_ERROR_MESSAGE);
    const notices = document.querySelectorAll('.ant-notification-notice, .ant-message-notice');
    expect(notices).toHaveLength(0);
    expect(within(document.body).queryAllByRole('alertdialog')).toEqual([]);
    const alerts = within(document.body).queryAllByRole('alert');
    const outsideBar = alerts.filter(
      (alert) => !summary.contains(alert) && !alert.contains(summary),
    );
    expect(outsideBar).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-SYNC-REFRESH#4] 手动同步受理后不重读状态条，保留初次读取的记录和时刻',
  async () => {
    const { server } = await mountList();
    await waitFor(() => expectSummaryAboveList(FIRST_RECORD));
    expect(syncQueries(server)).toEqual([LATEST_QUERY]);

    const dialog = await prepareOrderNos(server, PLATFORM_NAME.pdd, [NUMBER]);
    const before = snapshotText();
    vi.setSystemTime(new Date('2026-11-25T02:19:20Z'));
    await submit(dialog);
    await waitFor(() => expect(freshText(before)).toMatch(SUBMITTED));
    await settled(server);
    expect(server.posts()).toHaveLength(1);
    expect(server.created()).toHaveLength(1);
    expect(syncQueries(server)).toEqual([LATEST_QUERY]);
    expectSummaryAboveList([...FIRST_RECORD, FIRST_UPDATED]);
  },
  FLOW_TIMEOUT,
);
