// @vitest-environment jsdom
// F1-08dc (D10-1402, CT-24zzj): the 「待确认」 filter of the bill list sends awaiting_confirm=true
// to listAdminSettleBills when on, together with the months and the status, keeps it on every page
// and drops it on 【重置】; off, the parameter is left out (never awaiting_confirm=false). Which
// bills wait for confirmation is the server's call: the page shows the rows it answers.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BILL, namePattern } from '../admin-settle-bills/fixtures.ts';
import {
  LABEL,
  RESET,
  action,
  billRow,
  billRows,
  choose,
  click,
  extraParams,
  fillMonth,
  listed,
  main,
  monthField,
  mount,
  nextPageNear,
  query,
  settle,
  settled,
} from '../admin-settle-bills/helpers.ts';
import {
  AWAITING,
  AWAITING_PARAMS,
  ISSUED_NOT_WAITING,
  WAITING_SECOND_PAGE,
  createAwaitingServer,
} from './fixtures.ts';
import { awaitingSent, awaitingToggle, isOn, setAwaiting, tableReadsOf } from './helpers.ts';

it(
  '[AC-F1-08dc-FILTER#1] 列表筛选区有可访问名含「待确认」的开关 / 勾选，默认不勾；不勾时首读与按状态查询都不带 awaiting_confirm（不发 awaiting_confirm=false）',
  { timeout: 60_000 },
  async () => {
    const server = createAwaitingServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    expect(isOn(awaitingToggle()), '「待确认」 off by default').toBe(false);
    const first = tableReadsOf(server);
    expect(first.length, 'the list was read').toBeGreaterThan(0);
    expect(awaitingSent(first), 'no awaiting_confirm before the filter is on').toEqual(
      first.map(() => undefined),
    );
    await choose(main(), LABEL.status, namePattern('billStatus', 'settling', true));
    await query();
    await waitFor(() =>
      expect(tableReadsOf(server).some((read) => read.query['status'] === 'settling')).toBe(true),
    );
    await settled(server);
    const all = tableReadsOf(server);
    expect(awaitingSent(all), 'awaiting_confirm left out while off').toEqual(
      all.map(() => undefined),
    );
    expect(all.at(-1)!.query).toMatchObject({ status: 'settling' });
    expect(isOn(awaitingToggle()), '「待确认」 still off').toBe(false);
    await waitFor(() => expect(billRows(BILL.issued)).toEqual([]));
    expect(billRows(BILL.settling)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08dc-FILTER#2] 勾上「待确认」并选账单月区间与状态后【查询】：请求带 awaiting_confirm=true 且保留 bill_from / bill_to / status，从第 1 页起、无契约外参数；只列服务端返回的账单',
  { timeout: 60_000 },
  async () => {
    const server = createAwaitingServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    await fillMonth(monthField('from'), '2026-03');
    await fillMonth(monthField('to'), '2026-08');
    await choose(main(), LABEL.status, namePattern('billStatus', 'issued', true));
    await setAwaiting(true);
    await query();
    await waitFor(() =>
      expect(tableReadsOf(server).some((read) => read.query[AWAITING] === 'true')).toBe(true),
    );
    await settled(server);
    const sent = tableReadsOf(server).at(-1)!;
    expect(sent.query).toMatchObject({
      bill_from: '2026-03',
      bill_to: '2026-08',
      status: 'issued',
      awaiting_confirm: 'true',
    });
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, AWAITING_PARAMS)).toEqual([]);
    // The server's awaiting_confirm set within 2026-03…2026-08: 2026-08, 2026-04, 2026-03. The
    // issued 2026-05 (its only batch CANCELLED) is not in it.
    await waitFor(() => expect(billRows(ISSUED_NOT_WAITING)).toEqual([]));
    for (const month of [BILL.issued, '2026-04', '2026-03'])
      expect(billRows(month), month).toHaveLength(1);
    for (const month of [BILL.generating, BILL.settling, BILL.settled])
      expect(billRows(month), month).toEqual([]);
    expect(isOn(awaitingToggle()), '「待确认」 stays on after 【查询】').toBe(true);
  },
);

it(
  '[AC-F1-08dc-FILTER#3] 勾上「待确认」查询后翻到第 2 页：第 2 页的请求仍带 awaiting_confirm=true，列出该筛选下第 21–24 张账单',
  { timeout: 60_000 },
  async () => {
    const server = createAwaitingServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    await setAwaiting(true);
    await query();
    await waitFor(() =>
      expect(tableReadsOf(server).some((read) => read.query[AWAITING] === 'true')).toBe(true),
    );
    await settled(server);
    await waitFor(() => expect(billRows(BILL.settling)).toEqual([]));
    const queried = tableReadsOf(server).length;
    await nextPageNear(billRow(BILL.issued));
    await waitFor(() =>
      expect(
        tableReadsOf(server)
          .slice(queried)
          .some((read) => read.query['page'] === '2'),
      ).toBe(true),
    );
    await settled(server);
    const paged = tableReadsOf(server).slice(queried);
    expect(paged.length).toBeGreaterThan(0);
    for (const read of paged) {
      expect(read.query[AWAITING], 'awaiting_confirm kept while paging').toBe('true');
      expect(extraParams(read.query, AWAITING_PARAMS)).toEqual([]);
    }
    expect(paged.at(-1)!.query['page']).toBe('2');
    for (const month of WAITING_SECOND_PAGE)
      await waitFor(() => expect(billRows(month), month).toHaveLength(1));
    expect(billRows(BILL.issued)).toEqual([]);
    expect(isOn(awaitingToggle()), '「待确认」 stays on while paging').toBe(true);
  },
);

it(
  '[AC-F1-08dc-FILTER#4] 勾上「待确认」查询后【重置】：开关回到不勾，之后的请求都不带 awaiting_confirm，四张样例账单重新列出',
  { timeout: 60_000 },
  async () => {
    const server = createAwaitingServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    await choose(main(), LABEL.status, namePattern('billStatus', 'issued', true));
    await setAwaiting(true);
    await query();
    await waitFor(() =>
      expect(tableReadsOf(server).some((read) => read.query[AWAITING] === 'true')).toBe(true),
    );
    await settled(server);
    await waitFor(() => expect(billRows(BILL.settling)).toEqual([]));
    const before = server.reads().length;
    const tableBefore = tableReadsOf(server).length;
    await click(action(main(), RESET));
    await settle();
    await settled(server);
    // Some pages list again on 【重置】, others wait for 【查询】.
    if (billRows(BILL.settling).length === 0) {
      await query();
      await settled(server);
    }
    for (const month of [BILL.generating, BILL.issued, BILL.settling, BILL.settled])
      await waitFor(() => expect(billRows(month), month).toHaveLength(1));
    expect(isOn(awaitingToggle()), '「待确认」 off after 【重置】').toBe(false);
    expect(tableReadsOf(server).length, 'a table read after 【重置】').toBeGreaterThan(tableBefore);
    const after = server.reads().slice(before);
    expect(awaitingSent(after), 'awaiting_confirm dropped after 【重置】').toEqual(
      after.map(() => undefined),
    );
    for (const read of after) expect(read.query['status'], 'status cleared').toBeUndefined();
  },
);
