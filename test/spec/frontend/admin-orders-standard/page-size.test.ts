// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { openSelect } from '../admin-claims/claims-helpers.ts';
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
  PAGE_SIZE_CONTROL,
  choosePageSize,
  listRequestAfter,
  selectControl,
  selectedLabel,
} from './kit.ts';

it(
  '[AC-F1-07ed-PAGE-SIZE#1] 分页器默认每页二十条且只提供 20、50、100 三种选择',
  async () => {
    const { server } = await mount(createServer(manyRows()));
    await loaded();
    expect(await listRequestAfter(server, 0)).toEqual({ page: '1', page_size: '20' });
    expect(selectedLabel(selectControl(PAGE_SIZE_CONTROL))).toMatch(/^20\b/);
    const options = await openSelect(PAGE_SIZE_CONTROL);
    expect(options.map((option) => option.textContent?.trim().match(/^\d+/)?.[0])).toEqual([
      '20',
      '50',
      '100',
    ]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-PAGE-SIZE#2] 第二页改为每页五十条后回到第一页，再翻页仍按五十条查询',
  async () => {
    const orders = manyRows();
    const { server } = await mount(createServer(orders));
    await loaded();
    await settled(server);
    await nextPage();
    expect(await listRequestAfter(server, 1)).toEqual({ page: '2', page_size: '20' });

    await choosePageSize(50);
    expect(await listRequestAfter(server, 2)).toEqual({ page: '1', page_size: '50' });
    await loaded();
    expect(selectedLabel(selectControl(PAGE_SIZE_CONTROL))).toMatch(/^50\b/);

    await nextPage();
    expect(await listRequestAfter(server, 3)).toEqual({ page: '2', page_size: '50' });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toMatchObject({
      page: '2',
      page_size: '50',
    });
    await waitFor(() => expect(mainElement().textContent).toContain(orders[50]!.sub_order_id));
    expect(selectedLabel(selectControl(PAGE_SIZE_CONTROL))).toMatch(/^50\b/);
  },
  FLOW_TIMEOUT,
);
