// @vitest-environment jsdom
// F1-08an：审核列表各状态页签（全部 / 待审 / 驳回 / 手动 / 自动）的计数取 listAdminWithdrawals 的 total：每个
// 页签一次 page_size=1 的读取（只带该页签的快捷筛选），不在前端自行累加或按当前页推算（D10-2017）；计数读取失败时
// 不显示计数、也不报错、不阻塞列表。假服务端给计数读取的 total 与真实行数都不同。约定见 ./helpers.ts 开头。
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  TAB_NAMES,
  TOTALS,
  VIEWER,
  click,
  compact,
  isCountRead,
  isTableRead,
  listOf,
  main,
  mixedRows,
  mount,
  rowsOf,
  serverFor,
  settled,
  tabOfCount,
  type CountTab,
  type Server,
} from './helpers.ts';

const TABS = Object.keys(TAB_NAMES) as CountTab[];
const CJK = /[㐀-鿿]/;

/** The one status tab named `name` (a count may follow; 「自动到账设置」 and the like are other tabs). */
function statusTab(name: string): HTMLElement {
  const found = within(main())
    .queryAllByRole('tab', { hidden: true })
    .filter((tab) => {
      const text = compact(tab.textContent);
      return text.startsWith(name) && !CJK.test(text.slice(name.length));
    });
  expect(found, `one status tab ${name}`).toHaveLength(1);
  return found[0]!;
}
/** The numbers the tab shows after its name (text, or a Badge's title). */
function numbersOf(tab: HTMLElement, name: string): string[] {
  const text = compact(tab.textContent).slice(name.length);
  const titles = Array.from(tab.querySelectorAll('[title]'))
    .map((node) => node.getAttribute('title') ?? '')
    .filter((title) => /^\d+$/.test(title));
  return [...(text.match(/\d+/g) ?? []), ...titles];
}
function showsCount(tab: CountTab): boolean {
  const name = TAB_NAMES[tab];
  const node = statusTab(name);
  const total = String(TOTALS[tab]);
  const text = compact(node.textContent).slice(name.length);
  const asText = new RegExp(`(?<!\\d)${total}(?!\\d)`).test(text);
  return asText || node.querySelector(`[title="${total}"]`) !== null;
}
/** The tabs a count read has been sent for (page_size=1 with only the tab's quick filter). */
function countedTabs(server: Server, since = 0): CountTab[] {
  return server.log
    .slice(since)
    .filter(isCountRead)
    .map((read) => tabOfCount(read.query))
    .filter((tab): tab is CountTab => tab !== undefined);
}

it(
  '[AC-F1-08an-COUNT#1] 只持 fund.view 进审核列表：每个状态页签都发 page_size=1 的读取（只带该页签的快捷筛选、不带其他条件），页签显示返回的 total（全部 128、待审 37、驳回 9、手动 15、自动 52），不是当前页的行数；切到「待审」后各页签计数不变',
  { timeout: 90_000 },
  async () => {
    const rows = mixedRows();
    const server = serverFor(listOf(rows));
    await mount(server, VIEWER);
    await waitFor(() => expect([...new Set(countedTabs(server))].sort()).toEqual([...TABS].sort()));
    await settled(server);
    for (const read of server.log.filter(isCountRead))
      expect(tabOfCount(read.query), `count read ${JSON.stringify(read.query)}`).toBeDefined();
    for (const tab of TABS)
      await waitFor(() => expect(showsCount(tab), `${TAB_NAMES[tab]} ${TOTALS[tab]}`).toBe(true));

    const at = server.log.length;
    await click(statusTab(TAB_NAMES.pendingReview));
    await waitFor(() =>
      expect(
        server.log
          .slice(at)
          .some((read) => isTableRead(read) && read.query['display_status'] === 'pending_review'),
        'the table read of 待审',
      ).toBe(true),
    );
    await settled(server);
    await waitFor(() => expect(rowsOf(main(), rows.p.out_biz_no)).toHaveLength(1));
    for (const tab of TABS)
      expect(showsCount(tab), `${TAB_NAMES[tab]} still ${TOTALS[tab]}`).toBe(true);
  },
);

it(
  '[AC-F1-08an-COUNT#2] 计数读取都失败（50001）：五个页签各发过一次 page_size=1 的读取，页签只显示名字、不显示任何数字，页面不出现错误提示（无 role=alert、无「加载失败」、无错误消息），列表照常列出全部提现单，切到「待审」照常列出',
  { timeout: 90_000 },
  async () => {
    const rows = mixedRows();
    const server = serverFor(listOf(rows), { counts: 'fail' });
    await mount(server, VIEWER);
    await waitFor(() => expect([...new Set(countedTabs(server))].sort()).toEqual([...TABS].sort()));
    await settled(server);
    for (const tab of TABS) {
      const name = TAB_NAMES[tab];
      expect(numbersOf(statusTab(name), name), `${name}: no count`).toEqual([]);
    }
    for (const one of listOf(rows))
      expect(rowsOf(main(), one.out_biz_no), `${one.out_biz_no} listed`).toHaveLength(1);
    expect(within(main()).queryAllByRole('alert'), 'no error notice').toEqual([]);
    expect(main().textContent ?? '').not.toMatch(/加载失败|读取失败/);
    expect(document.querySelectorAll('.ant-message-error, .ant-notification-notice')).toHaveLength(
      0,
    );

    await click(statusTab(TAB_NAMES.pendingReview));
    await settled(server);
    await waitFor(() => expect(rowsOf(main(), rows.p.out_biz_no)).toHaveLength(1));
    expect(rowsOf(main(), rows.y.out_biz_no), 'PAYING is not 待审').toEqual([]);
    expect(within(main()).queryAllByRole('alert')).toEqual([]);
  },
);
