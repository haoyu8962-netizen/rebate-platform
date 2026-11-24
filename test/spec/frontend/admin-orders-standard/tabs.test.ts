// @vitest-environment jsdom
import { within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { createServer, manyRows } from '../admin-orders/orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  loaded,
  mainElement,
  mount,
  nextPage,
  settled,
} from '../admin-orders/orders-helpers.ts';
import {
  ALL,
  PLATFORM_NAMES,
  REBATE_STATUSES,
  clickTab,
  expectActiveTab,
  listRequestAfter,
  rebateLabel,
  selectControl,
  selectedLabel,
  tablistWith,
} from './kit.ts';

function tabLabels(list: HTMLElement): string[] {
  return within(list)
    .queryAllByRole('tab')
    .map((tab) => tab.textContent?.trim() ?? '');
}

it(
  '[AC-F1-07ed-TABS#1] 列表上方两组页签没有数量角标，干净地址默认选中全部，同步接口只有状态条的一次请求',
  async () => {
    const { server } = await mount();
    await loaded();
    await settled(server);
    expect(
      server.log
        .filter(({ path }) => /^\/admin\/v1\/order-syncs(?:\/|$)/.test(path))
        .map(({ method, path, query }) => ({ method, path, query })),
    ).toEqual([
      { method: 'GET', path: '/admin/v1/order-syncs', query: { page: '1', page_size: '1' } },
    ]);
    const platform = tablistWith('拼多多');
    const rebate = tablistWith(rebateLabel('CREDITED'));
    expect(platform).not.toBe(rebate);
    const table = within(mainElement()).getByRole('table');
    for (const list of [platform, rebate]) {
      expect(list.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expectActiveTab(list, ALL);
    }
    expect(tabLabels(platform).sort()).toEqual([ALL, ...PLATFORM_NAMES].sort());
    expect(tabLabels(rebate).sort()).toEqual([ALL, ...REBATE_STATUSES.map(rebateLabel)].sort());
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-TABS#2] 在第二页点拼多多只提交一次回到第一页并更新平台下拉，点全部去掉平台参数',
  async () => {
    const { server } = await mount(createServer(manyRows()));
    await loaded();
    await settled(server);
    await nextPage();
    expect(await listRequestAfter(server, 1)).toMatchObject({ page: '2' });

    await clickTab(tablistWith('拼多多'), '拼多多');
    expect(await listRequestAfter(server, 2)).toMatchObject({ page: '1', platform: 'pdd' });
    expectActiveTab(tablistWith('拼多多'), '拼多多');
    expect(selectedLabel(selectControl(/^平台$/))).toBe('拼多多');
    expect(new URLSearchParams(window.location.search).get('platform')).toBe('pdd');

    await clickTab(tablistWith('拼多多'), ALL);
    expect(await listRequestAfter(server, 3)).not.toHaveProperty('platform');
    expectActiveTab(tablistWith('拼多多'), ALL);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-TABS#3] 点返利状态页签只提交一次并更新返利下拉，点全部去掉返利状态参数',
  async () => {
    const { server } = await mount(createServer(manyRows()));
    await loaded();
    await settled(server);
    const credited = rebateLabel('CREDITED');
    await nextPage();
    expect(await listRequestAfter(server, 1)).toMatchObject({ page: '2' });

    await clickTab(tablistWith(credited), credited);
    expect(await listRequestAfter(server, 2)).toMatchObject({
      page: '1',
      rebate_status: 'CREDITED',
    });
    expectActiveTab(tablistWith(credited), credited);
    expect(selectedLabel(selectControl(/^返利状态/))).toBe(credited);
    expect(new URLSearchParams(window.location.search).get('rebate_status')).toBe('CREDITED');

    await clickTab(tablistWith(credited), ALL);
    expect(await listRequestAfter(server, 3)).not.toHaveProperty('rebate_status');
    expectActiveTab(tablistWith(credited), ALL);
  },
  FLOW_TIMEOUT,
);
