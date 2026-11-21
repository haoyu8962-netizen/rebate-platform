// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BASE_URL,
  REVIEW_GRANTS,
  createServer,
  snapshot,
  type Server,
} from '../../admin-withdrawals/fixtures.ts';
import { settled } from '../../admin-withdrawals/helpers.ts';
import { MULTI_TIMEOUT, mountAt, unmountPage } from '../../admin-route-status-param/helpers.ts';
import { countQueries, listQueries, tabCounts } from './route-status-counts.ts';

/** Opens the page at `address` and waits for its list reads to finish. */
async function open(address: string, server: Server = createServer()): Promise<Server> {
  await mountAt(address, server, snapshot(REVIEW_GRANTS), BASE_URL);
  await waitFor(() => expect(server.reads().length, 'a list read').toBeGreaterThan(0));
  await settled(server);
  return server;
}

it(
  '[AC-F1-08an-COUNTS#1] 进页 /withdrawals 与 /withdrawals?status=PENDING_REVIEW：恰 5 个 page_size=1 的页签计数读（全部 / 待审 / 驳回 / 手动 / 自动，各只带该页签的快捷筛选、不带地址里的 status），列表读恰 1 条',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const bare = await open('/withdrawals');
    await waitFor(() => expect(countQueries(bare), 'five tab counts').toEqual(tabCounts()));
    await settled(bare);
    expect(countQueries(bare), 'five tab counts, once each').toEqual(tabCounts());
    expect(listQueries(bare), 'one list read').toHaveLength(1);
    unmountPage();
    const server = await open('/withdrawals?status=PENDING_REVIEW');
    await waitFor(() => expect(countQueries(server), 'five tab counts').toEqual(tabCounts()));
    await settled(server);
    expect(countQueries(server), 'no address status in the counts').toEqual(tabCounts());
    expect(listQueries(server), 'one list read').toHaveLength(1);
  },
);
