// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL, NUMBER, OID, ROUTE, rows } from '../admin-orders/orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  loaded,
  mainElement,
  mount,
  openDetail,
  queries,
  settled,
} from '../admin-orders/orders-helpers.ts';
import { expectActiveTab, rebateLabel, tablistWith } from '../admin-orders-standard/kit.ts';
import {
  DRAWER_ORDERS,
  SECOND_PAGE_QUERY,
  SECOND_PAGE_ROUTE,
  addressQuery,
  createPageServer,
  detailReads,
  loadedDrawer,
  orderDialogs,
  viewButton,
} from './kit.ts';

it(
  '[AC-F1-07edb-DRAWER#1] 行内查看只读一次详情，关闭恢复焦点和位置并保留筛选、页码与列表',
  async () => {
    const { server } = await mount(createPageServer(DRAWER_ORDERS), SECOND_PAGE_ROUTE);
    await loaded();
    await settled(server);
    expect(queries(server)).toEqual([SECOND_PAGE_QUERY]);
    expect(addressQuery()).toEqual(SECOND_PAGE_QUERY);
    expect(detailReads(server)).toEqual([]);
    for (const item of DRAWER_ORDERS.slice(50)) viewButton(item.sub_order_id);

    const listText = within(mainElement()).getByRole('table').textContent;
    const trigger = viewButton(NUMBER);
    trigger.focus();
    mainElement().scrollTop = 320;
    await click(trigger);

    const drawer = await loadedDrawer(NUMBER);
    await settled(server);
    expect(detailReads(server)).toEqual([DETAIL]);
    expect(window.location.pathname).toBe('/orders');
    expect(addressQuery()).toEqual({ ...SECOND_PAGE_QUERY, detail: OID });
    expect(queries(server)).toEqual([SECOND_PAGE_QUERY]);

    const close = button(drawer, /^(?:close|关\s*闭)$/i);
    close.focus();
    expect(document.activeElement).toBe(close);
    await click(close);
    await waitFor(() => {
      expect(orderDialogs()).toEqual([]);
      expect(document.activeElement).toBe(trigger);
    });
    await settled(server);
    expect(window.location.pathname).toBe('/orders');
    expect(addressQuery()).toEqual(SECOND_PAGE_QUERY);
    expect(queries(server)).toEqual([SECOND_PAGE_QUERY]);
    expect(detailReads(server)).toEqual([DETAIL]);
    expect(mainElement().scrollTop).toBe(320);
    expect(within(mainElement()).getByRole('table').textContent).toBe(listText);
    expectActiveTab(tablistWith('拼多多'), '拼多多');
    const credited = rebateLabel('CREDITED');
    expectActiveTab(tablistWith(credited), credited);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-DRAWER#2] 带筛选的深链直接打开详情，即使该订单不在筛选结果内',
  async () => {
    const list = { platform: 'taobao', rebate_status: 'UNATTRIBUTED' };
    const route = `/orders?${new URLSearchParams({ ...list, detail: OID })}`;
    const { server } = await mount(createPageServer(), route);
    await loadedDrawer(NUMBER);
    const taobao = rows()[1]!;
    await waitFor(() => expect(mainElement().textContent).toContain(taobao.sub_order_id));
    await settled(server);
    const table = within(mainElement()).getByRole('table', { hidden: true });
    expect(table.textContent).toContain(taobao.sub_order_id);
    expect(table.textContent).not.toContain(NUMBER);
    expect(queries(server)).toEqual([{ ...list, page: '1', page_size: '20' }]);
    expect(detailReads(server)).toEqual([DETAIL]);
    expect(window.location.pathname).toBe('/orders');
    expect(addressQuery()).toMatchObject({ ...list, detail: OID });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-DRAWER#3] 非法深链不读详情也不开抽屉，行内详情仍进入整页',
  async () => {
    const { server } = await mount(
      createPageServer(),
      '/orders?platform=pdd&detail=not-an-order-id',
    );
    await loaded();
    await settled(server);
    expect(queries(server)).toEqual([{ page: '1', page_size: '20', platform: 'pdd' }]);
    expect(orderDialogs()).toEqual([]);
    expect(detailReads(server)).toEqual([]);
    viewButton(NUMBER);

    await openDetail();
    await waitFor(() => expect(window.location.pathname).toBe(ROUTE));
    await waitFor(() => expect(mainElement().textContent).toContain('分佣快照'));
    expect(detailReads(server)).toEqual([DETAIL]);
    expect(orderDialogs()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
