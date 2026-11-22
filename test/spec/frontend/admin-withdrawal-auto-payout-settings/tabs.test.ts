// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BUSINESS_GRANTS,
  GENERAL_GRANTS,
  RISK_GRANTS,
  SUPER,
  TAB,
  VIEW_GRANTS,
  accountOf,
  serverFor,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  itemReads,
  main,
  mount,
  openSettings,
  pageTabNames,
  settingsTraffic,
  settled,
  switchReads,
  tabsIn,
} from './helpers.ts';

// F1-08ap: the fourth page tab 「自动到账设置」 of /withdrawals. It shows only for an account holding
// config.business (a super admin holds every point), after the three tabs of F1-08ba. Nothing of it
// is read or rendered before it is entered: no config-items and no kill-switches request until then.
// An account without config.business sees the tab bar exactly as before.

const FOUR = [TAB.review, TAB.queue, TAB.unknown, TAB.auto];
const THREE = [TAB.review, TAB.queue, TAB.unknown];

it(
  '[AC-F1-08ap-TAB#1] 超管进 /withdrawals：页签依次为「审核列表」「打款队列」「结果待确认」「自动到账设置」，默认审核列表；未进「自动到账设置」前不请求 config-items 与 kill-switches；进入后读 config-items（page_size ≤ 200，只带 page / page_size）与 kill-switches',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    await mount(server, SUPER);
    await waitFor(() => expect(pageTabNames()).toEqual(FOUR));
    const review = tabsIn(main(), TAB.review)[0]!;
    expect(review.getAttribute('aria-selected'), 'the review list is selected').toBe('true');
    await settled(server);
    expect(settingsTraffic(server), 'nothing of the tab before it is entered').toEqual([]);
    cleanup();

    const again = serverFor();
    await openSettings(again, SUPER);
    const reads = itemReads(again);
    expect(reads.length, 'the config items are read').toBeGreaterThan(0);
    for (const read of reads) {
      const names = Object.keys(read.query).sort();
      expect(
        names.every((name) => ['page', 'page_size'].includes(name)),
        'page params only',
      ).toBe(true);
      const size = read.query['page_size'];
      if (size !== undefined) expect(Number(size)).toBeLessThanOrEqual(200);
    }
    await waitFor(() =>
      expect(switchReads(again).length, 'the switch list is read').toBeGreaterThan(0),
    );
  },
);

it(
  '[AC-F1-08ap-TAB#2] 持 withdraw.review + fund.view + config.business：见四个页签、进入后可读设置；只持 withdraw.review + fund.view：页签栏照旧为三个、无「自动到账设置」，全程不请求 config-items 与 kill-switches',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const business = serverFor({ permissions: BUSINESS_GRANTS });
    await mount(business, accountOf(BUSINESS_GRANTS));
    await waitFor(() => expect(pageTabNames(), 'config.business').toEqual(FOUR));
    await settled(business);
    expect(settingsTraffic(business), 'nothing before the tab is entered').toEqual([]);
    cleanup();

    const opened = serverFor({ permissions: BUSINESS_GRANTS });
    await openSettings(opened, accountOf(BUSINESS_GRANTS));
    expect(itemReads(opened).length).toBeGreaterThan(0);
    cleanup();

    const viewer = serverFor({ permissions: VIEW_GRANTS });
    await mount(viewer, accountOf(VIEW_GRANTS));
    await waitFor(() => expect(pageTabNames(), 'without config.business').toEqual(THREE));
    await settled(viewer);
    expect(tabsIn(main(), TAB.auto), 'no 自动到账设置 tab').toEqual([]);
    expect(settingsTraffic(viewer), 'no config or switch read').toEqual([]);
  },
);

it(
  '[AC-F1-08ap-TAB#3] 对照：持 config.general + config.business 见四个页签；只持 config.general 或只持 config.risk（另持 withdraw.review + fund.view，不持 config.business）的审核员：页签栏照旧为三个、无「自动到账设置」，全程不请求 config-items 与 kill-switches',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const both: typeof GENERAL_GRANTS = [...GENERAL_GRANTS, 'config.business'];
    const control = serverFor({ permissions: both });
    await mount(control, accountOf(both));
    await waitFor(() =>
      expect(pageTabNames(), 'config.business with config.general').toEqual(FOUR),
    );
    await settled(control);
    expect(settingsTraffic(control), 'nothing before the tab is entered').toEqual([]);
    cleanup();

    for (const [name, grants] of [
      ['config.general', GENERAL_GRANTS],
      ['config.risk', RISK_GRANTS],
    ] as const) {
      expect(grants.includes('config.business'), `${name} holds no config.business`).toBe(false);
      const server = serverFor({ permissions: grants });
      await mount(server, accountOf(grants));
      await waitFor(() => expect(pageTabNames(), `only ${name}`).toEqual(THREE));
      await settled(server);
      expect(tabsIn(main(), TAB.auto), `no 自动到账设置 tab with ${name}`).toEqual([]);
      expect(settingsTraffic(server), `no config or switch read with ${name}`).toEqual([]);
      cleanup();
    }
  },
);
