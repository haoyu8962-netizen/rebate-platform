// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DASH,
  EXECUTE,
  QID,
  QNO,
  RESULT_SHOWN,
  VIEW_EXECUTE,
  createPayoutServer,
  type PayoutServer,
} from './fixtures.ts';
import {
  COLUMN,
  ENTRY,
  FLOW_TIMEOUT,
  TAB,
  cellsOf,
  click,
  entry,
  everyGrant,
  gridWith,
  listed,
  mount,
  openTab,
  pageHeading,
  pageSizeOf,
  rowIn,
  settled,
} from './helpers.ts';

// F1-08ba ③: 结果待确认 lists adminListUnknownPayouts (GET /admin/v1/unknown-payouts, payout.execute;
// BR-WDR-14: PAYING with needs_manual after T+24h, longest waiting first) with the contract's
// paging only. Columns from the answer: 实付 through @couli/money, 首次转账 T in Beijing time
// (null → —), 最近一次查询 as the result's name (dictionary) followed by its Beijing time (null → —).
// Each row's 【处置】 opens withdrawals/{id}, where the disposal itself lives (F1-08aj); the tab reads
// no withdrawal list of its own.

const ROWS = [QNO.stuck, QNO.untried];

/** Opens 结果待确认 and waits for its read to finish. */
async function openUnknown(server: PayoutServer): Promise<HTMLElement> {
  const panel = await openTab(TAB.unknown);
  await waitFor(() => expect(server.unknownReads().length).toBeGreaterThan(0));
  await settled(server);
  return panel;
}

it(
  '[AC-F1-08ba-UNKNOWN#1] 进「结果待确认」：只发一次 unknown-payouts（{page:1, page_size}）、不读提现单列表，按接口顺序列出 2 张；实付 ¥100.00 / ¥200.00，首次转账 2026-11-12 10:00:05 / —，最近一次查询「结果未知（只查询、不重发）2026-11-13 10:00:05」/ —，每行有可用的【处置】',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(server, everyGrant(VIEW_EXECUTE));
    await settled(server);
    const lists = server.listReads().length;
    const panel = await openUnknown(server);
    await listed(panel, ROWS);
    const size = pageSizeOf(server.unknownReads());
    const queries = server.unknownReads().map((read) => read.query);
    expect(queries, 'one unknown read').toEqual([{ page: '1', page_size: size }]);
    expect(server.listReads().slice(lists), 'no withdrawal list read').toEqual([]);
    const grid = gridWith(panel, COLUMN.firstTransfer);
    const cells = cellsOf(grid, [COLUMN.net, COLUMN.firstTransfer, COLUMN.latestQuery]);
    expect(cells).toEqual([
      ['¥100.00', '2026-11-1210:00:05', `${RESULT_SHOWN.unknown}2026-11-1310:00:05`],
      ['¥200.00', DASH, DASH],
    ]);
    for (const number of ROWS) entry(rowIn(grid, number), ENTRY.handle);
  },
);

it(
  '[AC-F1-08ba-UNKNOWN#2] 行【处置】进 withdrawals/{id}：读该单详情并显示该单号',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(server, everyGrant(VIEW_EXECUTE));
    const panel = await openUnknown(server);
    await listed(panel, ROWS);
    const grid = gridWith(panel, COLUMN.firstTransfer);
    await click(entry(rowIn(grid, QNO.stuck), ENTRY.handle));
    await waitFor(() => expect(server.detailReads(QID.stuck).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(pageHeading()).toBe(QNO.stuck));
  },
);

it(
  '[AC-F1-08ba-UNKNOWN#3] 只持 payout.execute：「结果待确认」照常读 unknown-payouts 并列出 2 张',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: EXECUTE });
    await mount(server, everyGrant(EXECUTE));
    const panel = await openUnknown(server);
    await listed(panel, ROWS);
    const size = pageSizeOf(server.unknownReads());
    const queries = server.unknownReads().map((read) => read.query);
    expect(queries, 'one unknown read').toEqual([{ page: '1', page_size: size }]);
  },
);
