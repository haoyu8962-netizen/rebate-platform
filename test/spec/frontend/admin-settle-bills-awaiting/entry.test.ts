// @vitest-environment jsdom
// F1-08dc (D10-1402, CT-24zzj): the workbench card settle_bill_pending opens
// /settle-bills?awaiting_confirm=true, and its count is the total of that filter. Opened at that
// address (browser router, as a deep link or from the card), the bill list starts with 「待确认」
// on: its very first read carries awaiting_confirm=true, and the sidebar marks 月结账单. Turning
// it off and querying drops the parameter, and the address no longer says awaiting_confirm=true.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BILL, SETTLE_GRANTS, snapshot } from '../admin-settle-bills/fixtures.ts';
import { billRows, click, listed, query, settled } from '../admin-settle-bills/helpers.ts';
import {
  CARDS,
  createServer as createDashboardServer,
} from '../admin-dashboard/dashboard-fixtures.ts';
import { card, loaded } from '../admin-dashboard/dashboard-helpers.ts';
import { menuLink, mount as mountShell, routes } from '../admin-planned/kit.ts';
import { AWAITING, ISSUED_NOT_WAITING, WAITING_TOTAL, createAwaitingServer } from './fixtures.ts';
import { awaitingSent, awaitingToggle, isOn, setAwaiting, tableReadsOf } from './helpers.ts';

it(
  '[AC-F1-08dc-ENTRY#1] 直接打开 /settle-bills?awaiting_confirm=true：「待确认」一进来就是勾上的，第一次列表请求就带 awaiting_confirm=true（此前没有不带它的列表请求），只列服务端返回的待确认账单，侧栏高亮月结账单',
  { timeout: 60_000 },
  async () => {
    const server = createAwaitingServer();
    await mountShell({
      route: '/settle-bills?awaiting_confirm=true',
      fetch: routes([[/^\/admin\/v1\/settle-(?:bills|batches)(?:\/|$)/, server.fetch]]),
      snapshot: snapshot(SETTLE_GRANTS),
    });
    await waitFor(() => expect(tableReadsOf(server).length).toBeGreaterThan(0));
    await settled(server);
    const reads = tableReadsOf(server);
    expect(reads[0]!.query[AWAITING], 'the first list read').toBe('true');
    expect(awaitingSent(reads), 'every list read so far').toEqual(reads.map(() => 'true'));
    await listed(BILL.issued);
    expect(isOn(awaitingToggle()), '「待确认」 on from the address').toBe(true);
    for (const month of [BILL.generating, BILL.settling, BILL.settled, ISSUED_NOT_WAITING])
      expect(billRows(month), month).toEqual([]);
    expect(menuLink('月结账单').getAttribute('aria-current')).toBe('page');
  },
);

it(
  '[AC-F1-08dc-ENTRY#2] 点工作台卡「待确认月结账单」（route /settle-bills?awaiting_confirm=true）：落在月结账单列表，「待确认」已勾上，进入后的第一次列表请求就带 awaiting_confirm=true，侧栏高亮月结账单',
  { timeout: 60_000 },
  async () => {
    const server = createAwaitingServer();
    const workbench = createDashboardServer();
    const index = CARDS.findIndex(([name]) => name === 'settle_bill_pending');
    expect(index, 'the settle_bill_pending card sample').toBeGreaterThanOrEqual(0);
    const { todo: cards } = workbench.state;
    const pending = cards[index]!;
    pending.route = '/settle-bills?awaiting_confirm=true';
    pending.count = WAITING_TOTAL;
    await mountShell({
      route: '/dashboard',
      fetch: routes([
        [/^\/admin\/v1\/dashboard$/, workbench.fetch],
        [/^\/admin\/v1\/settle-(?:bills|batches)(?:\/|$)/, server.fetch],
      ]),
      snapshot: snapshot(['dashboard.view', 'settle.bill']),
    });
    await loaded();
    const link = card('待确认月结账单');
    expect(link.getAttribute('href')).toBe('/settle-bills?awaiting_confirm=true');
    expect(server.reads(), 'no bill read on the workbench').toEqual([]);
    await click(link);
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        '/settle-bills?awaiting_confirm=true',
      ),
    );
    await waitFor(() => expect(tableReadsOf(server).length).toBeGreaterThan(0));
    await settled(server);
    const reads = tableReadsOf(server);
    expect(reads[0]!.query[AWAITING], 'the first list read after the card').toBe('true');
    expect(awaitingSent(reads), 'every list read so far').toEqual(reads.map(() => 'true'));
    await listed(BILL.issued);
    expect(isOn(awaitingToggle()), '「待确认」 on from the card').toBe(true);
    expect(billRows(BILL.settling)).toEqual([]);
    expect(menuLink('月结账单').getAttribute('aria-current')).toBe('page');
  },
);

it(
  '[AC-F1-08dc-ENTRY#3] 从 /settle-bills?awaiting_confirm=true 进入后取消「待确认」并【查询】：之后的列表请求不带 awaiting_confirm（不发 false），全部账单重新列出，地址不再是 awaiting_confirm=true',
  { timeout: 60_000 },
  async () => {
    const server = createAwaitingServer();
    await mountShell({
      route: '/settle-bills?awaiting_confirm=true',
      fetch: routes([[/^\/admin\/v1\/settle-(?:bills|batches)(?:\/|$)/, server.fetch]]),
      snapshot: snapshot(SETTLE_GRANTS),
    });
    await waitFor(() => expect(tableReadsOf(server).length).toBeGreaterThan(0));
    await settled(server);
    expect(tableReadsOf(server)[0]!.query[AWAITING], 'the first list read').toBe('true');
    await listed(BILL.issued);
    const before = server.reads().length;
    await setAwaiting(false);
    await query();
    await settled(server);
    for (const month of [BILL.generating, BILL.settling, BILL.settled, ISSUED_NOT_WAITING])
      await waitFor(() => expect(billRows(month), month).toHaveLength(1));
    const after = server.reads().slice(before);
    expect(after.length, 'a list read after 【查询】').toBeGreaterThan(0);
    expect(awaitingSent(after), 'awaiting_confirm left out once off').toEqual(
      after.map(() => undefined),
    );
    expect(isOn(awaitingToggle()), '「待确认」 off').toBe(false);
    expect(new URLSearchParams(window.location.search).get(AWAITING)).not.toBe('true');
    expect(menuLink('月结账单').getAttribute('aria-current')).toBe('page');
  },
);
