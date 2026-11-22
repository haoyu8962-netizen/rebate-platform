// @vitest-environment jsdom
// F1-08ap（D10-2454 机械搬家）：[AC-F1-08ap-TABS-FROZEN#1] 原在 admin-payouts-readonly/tabs.test.ts 末尾，
// 整块原样搬到本文件；只改 import 路径，REVIEW_ROWS 与 PAGE_TABS 两个常量从该文件原样复制，断言与标题一字未动。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  QNO,
  VIEW_EXECUTE,
  createPayoutServer,
  type Grants,
} from '../admin-payouts-readonly/fixtures.ts';
import {
  MULTI_TIMEOUT,
  TAB,
  everyGrant,
  listed,
  main,
  mount,
  pageTabNames,
  panelOf,
  settled,
  tabsIn,
} from '../admin-payouts-readonly/helpers.ts';

/** The review list's rows of the queue samples (every status, newest applied first). */
const REVIEW_ROWS = [
  QNO.approvedA,
  QNO.paying,
  QNO.pending,
  QNO.approvedB,
  QNO.stuck,
  QNO.paid,
  QNO.untried,
];
const PAGE_TABS = [TAB.review, TAB.queue, TAB.unknown];

it(
  '[AC-F1-08ap-TABS-FROZEN#1] 持 fund.view + payout.execute + config.business 进 /withdrawals：页签恰为「审核列表」「打款队列」「结果待确认」「自动到账设置」四个、默认选中审核列表；只持 fund.view + payout.execute：仍恰三个、不见「自动到账设置」；未进页签时都不请求 payout-overview 与 unknown-payouts',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const settingsTab = '自动到账设置';
    const withConfig: Grants = ['fund.view', 'payout.execute', 'config.business'];
    const server = createPayoutServer({ permissions: withConfig });
    await mount(server, everyGrant(withConfig));
    await waitFor(() =>
      expect(pageTabNames(), 'config.business').toEqual([
        TAB.review,
        TAB.queue,
        TAB.unknown,
        settingsTab,
      ]),
    );
    const review = tabsIn(main(), TAB.review)[0]!;
    expect(review.getAttribute('aria-selected'), 'the review list is selected').toBe('true');
    await listed(await panelOf(review), REVIEW_ROWS);
    await settled(server);
    expect(server.overviewReads(), 'no overview read').toEqual([]);
    expect(server.unknownReads(), 'no unknown read').toEqual([]);
    cleanup();

    const plain = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(plain, everyGrant(VIEW_EXECUTE));
    await waitFor(() => expect(pageTabNames(), 'without config.business').toEqual(PAGE_TABS));
    await settled(plain);
    expect(tabsIn(main(), settingsTab), 'no settings tab').toEqual([]);
    expect(plain.overviewReads(), 'no overview read').toEqual([]);
    expect(plain.unknownReads(), 'no unknown read').toEqual([]);
  },
);
