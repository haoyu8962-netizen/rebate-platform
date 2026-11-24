// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { manyRows } from '../admin-orders/orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  click,
  loaded,
  mainElement,
  mount,
  query,
} from '../admin-orders/orders-helpers.ts';
import { listRequestAfter } from '../admin-orders-standard/kit.ts';
import { addressQuery, createPageServer } from './kit.ts';

it(
  '[AC-F1-07edb-FIXES#1] 第三页越界但仍有十八条匹配订单时，点第 1 页重新查询并更新地址',
  async () => {
    const { server } = await mount(createPageServer(manyRows().slice(0, 18)), '/orders?page=3');
    expect(await listRequestAfter(server, 0)).toEqual({ page: '3', page_size: '20' });
    await waitFor(() => expect(mainElement().textContent).toContain('没有符合条件的订单'));
    const firstPage = within(mainElement()).queryAllByTitle('1');
    expect(firstPage, '越界页仍显示第 1 页入口').toHaveLength(1);
    await click(firstPage[0]!);

    expect(await listRequestAfter(server, 1)).toEqual({ page: '1', page_size: '20' });
    expect(addressQuery()['page']).toBe('1');
    await loaded();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-FIXES#2] 提交 URL 中公元 99 年的起始日和结束日时使用正确的北京时间边界',
  async () => {
    const boundaries = {
      paid_from: '0099-12-31T00:00:00+08:00',
      paid_to: '0100-01-01T00:00:00+08:00',
    };
    for (const [param, expected] of Object.entries(boundaries)) {
      const view = await mount(createPageServer(), `/orders?${param}=0099-12-31`);
      await listRequestAfter(view.server, 0);
      await query();
      const sent = (await listRequestAfter(view.server, 1))[param];
      expect(sent, param).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
      expect(Date.parse(sent!), param).toBe(Date.parse(expected));
      view.unmount();
    }
  },
  FLOW_TIMEOUT,
);
