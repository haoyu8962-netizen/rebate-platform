// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL_NUMBER, DETAIL_ROUTE, NUMBER, createServer } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MANUAL_ENTRY,
  OUTSIDER,
  RECORDS_ENTRY,
  SUPER,
  THIS_ORDER_ENTRY,
  actions,
  main,
  mount,
  mountDetail,
  mountList,
  settled,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-07eb-ENTRY#1] 持 order.view 的订单列表标题行有可用的【手动同步】【同步记录】，列表初次加载只为同步状态条请求一次 order-syncs（page=1、page_size=1），不请求 limits',
  async () => {
    const { server } = await mountList();
    const syncRequests = () =>
      server.syncRequests().map(({ method, path, query }) => ({ method, path, query }));
    const expected = [
      { method: 'GET', path: '/admin/v1/order-syncs', query: { page: '1', page_size: '1' } },
    ];
    expect(syncRequests(), 'one order-syncs request for the status bar on the first load').toEqual(
      expected,
    );
    expect(usable(main(), MANUAL_ENTRY).length, '【手动同步】 in the title row').toBeGreaterThan(0);
    expect(usable(main(), RECORDS_ENTRY).length, '【同步记录】 in the title row').toBeGreaterThan(
      0,
    );
    await settled(server);
    expect(syncRequests()).toEqual(expected);
    expect(server.posts()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-ENTRY#2] 持 order.view 的订单详情有可用的【同步此单】，详情初次加载不请求 order-syncs 与 limits、不读列表',
  async () => {
    const server = createServer();
    await mountDetail(server, DETAIL_ROUTE, DETAIL_NUMBER);
    expect(server.syncRequests(), 'no order-syncs request on the first load').toEqual([]);
    expect(usable(main(), THIS_ORDER_ENTRY).length, '【同步此单】 on the detail').toBeGreaterThan(
      0,
    );
    await settled(server);
    expect(server.syncRequests()).toEqual([]);
    expect(server.requests('GET', '/admin/v1/orders')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-ENTRY#3] 超管也有【手动同步】【同步记录】；进不了订单页的账号没有这些入口、也不发 order-syncs 请求',
  async () => {
    const first = createServer();
    await mountList(first, SUPER);
    expect(usable(main(), MANUAL_ENTRY).length, 'super admin 【手动同步】').toBeGreaterThan(0);
    expect(usable(main(), RECORDS_ENTRY).length, 'super admin 【同步记录】').toBeGreaterThan(0);
    const requests = first.syncRequests().map(({ method, path, query }) => ({
      method,
      path,
      query,
    }));
    expect(requests).toEqual([
      { method: 'GET', path: '/admin/v1/order-syncs', query: { page: '1', page_size: '1' } },
    ]);

    cleanup();
    const second = createServer();
    await mount(second, '/orders', OUTSIDER);
    await settled(second);
    expect(document.body.textContent).not.toContain(NUMBER);
    expect(actions(document.body, MANUAL_ENTRY)).toEqual([]);
    expect(actions(document.body, RECORDS_ENTRY)).toEqual([]);
    expect(actions(document.body, THIS_ORDER_ENTRY)).toEqual([]);
    expect(second.syncRequests()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
