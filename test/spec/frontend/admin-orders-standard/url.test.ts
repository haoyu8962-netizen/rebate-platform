// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NUMBER, PARENT, ROUTE, UID, createServer } from '../admin-orders/orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  fill,
  loaded,
  mainElement,
  mount,
  openDetail,
  queries,
  query,
  select,
  settled,
  textbox,
  time,
} from '../admin-orders/orders-helpers.ts';
import {
  currentUrl,
  detailOnSecondPage,
  expectActiveTab,
  listRequestAfter,
  rebateLabel,
  selectControl,
  selectedLabel,
  tablistWith,
} from './kit.ts';

const credited = rebateLabel('CREDITED');
const paidFrom = /^付款时间开始日期$/;
const paidTo = /^付款时间结束日期$/;
const applied = {
  platform: 'pdd',
  platform_status: 'SETTLED',
  rebate_status: 'CREDITED',
  flag: 'locked',
  q: PARENT,
  user_id: UID,
};

it(
  '[AC-F1-07ed-URL#1] 已提交的筛选写入地址，重开完整地址的第一笔请求及控件都还原',
  async () => {
    const first = await mount();
    await loaded();
    await select(/^平台$/, '拼多多');
    await select(/^平台状态/, 'SETTLED');
    await select(/^返利状态/, 'CREDITED');
    await select(/^订单标记$/, '归属已锁定');
    await fill(textbox(/^订单号/), PARENT);
    await fill(textbox(/^用户/), UID);
    await time(paidFrom, '2026-10-01');
    await time(paidTo, '2026-10-07');
    await query();

    const before = await listRequestAfter(first.server, 1);
    expect(before).toMatchObject({
      ...applied,
      paid_from: expect.any(String),
      paid_to: expect.any(String),
    });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toMatchObject(applied);
    expectActiveTab(tablistWith('拼多多'), '拼多多');
    expectActiveTab(tablistWith(credited), credited);
    const route = currentUrl();
    first.unmount();

    const { server } = await mount(undefined, route);
    await loaded();
    expect(await listRequestAfter(server, 0)).toEqual(before);
    expect(textbox(/^订单号/)).toHaveProperty('value', PARENT);
    expect(textbox(/^用户/)).toHaveProperty('value', UID);
    expect(textbox(paidFrom)).toHaveProperty('value', '2026-10-01');
    expect(textbox(paidTo)).toHaveProperty('value', '2026-10-07');
    expect(selectedLabel(selectControl(/^平台$/))).toBe('拼多多');
    expect(selectedLabel(selectControl(/^平台状态/))).toContain('SETTLED');
    expect(selectedLabel(selectControl(/^返利状态/))).toBe(credited);
    expect(selectedLabel(selectControl(/^订单标记$/))).toBe('归属已锁定');
    expectActiveTab(tablistWith('拼多多'), '拼多多');
    expectActiveTab(tablistWith(credited), credited);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-URL#2] 非法平台、返利状态和页大小被忽略，同地址的合法订单号仍用于首笔请求',
  async () => {
    const route = `/orders?platform=foo&page_size=7&rebate_status=bar&q=${NUMBER}`;
    const { server } = await mount(undefined, route);
    await loaded();
    expect(await listRequestAfter(server, 0)).toEqual({ page: '1', page_size: '20', q: NUMBER });
    expect(textbox(/^订单号/)).toHaveProperty('value', NUMBER);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-URL#3] 从带筛选的第 2 页进入整页详情再返回，地址与列表请求均保留筛选、页码和页大小',
  async () => {
    const server = createServer(detailOnSecondPage());
    const route = '/orders?platform=pdd&rebate_status=CREDITED&page=2&page_size=50';
    await mount(server, route);
    const before = await listRequestAfter(server, 0);
    expect(before).toEqual({
      platform: 'pdd',
      rebate_status: 'CREDITED',
      page: '2',
      page_size: '50',
    });

    await openDetail();
    await waitFor(() => expect(window.location.pathname).toBe(ROUTE));
    await waitFor(() => expect(mainElement().textContent).toContain('分佣快照'));
    expect(queries(server)).toHaveLength(1);
    await click(button(mainElement(), /返回/));

    await waitFor(() => expect(window.location.pathname).toBe('/orders'));
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toMatchObject(before);
    await loaded();
    await settled(server);
    for (const restored of queries(server).slice(1)) expect(restored).toEqual(before);
  },
  FLOW_TIMEOUT,
);
