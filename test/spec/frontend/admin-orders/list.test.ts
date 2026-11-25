// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DETAIL,
  LIST,
  NUMBER,
  PARENT,
  ROUTE,
  UID,
  createServer,
  manyRows,
  rows,
} from './orders-fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  fill,
  loaded,
  mainElement,
  mount,
  nextPage,
  openDetail,
  queries,
  query,
  readOnly,
  row,
  select,
  settled,
  textbox,
  time,
} from './orders-helpers.ts';

it(
  '[AC-F1-07e-LIST#1] 默认列表只请求一页，列、北京时间、服务端付款顺序及后台金额格式正确',
  async () => {
    const { server, directFetch } = await mount();
    await loaded();
    await settled(server);
    expect(queries(server)).toHaveLength(1);
    expect(Object.keys(queries(server)[0]!).sort()).toEqual(['page', 'page_size']);
    expect(queries(server)[0]!['page']).toBe('1');
    const size = Number(queries(server)[0]!['page_size']);
    expect(Number.isInteger(size) && size >= 3 && size <= 200).toBe(true);
    expect(server.requests('GET', LIST)[0]!.headers.get('Authorization')).toBe(
      'Bearer example-admin-token',
    );
    for (const name of [
      '订单号',
      '平台',
      '商品',
      '用户',
      '付款时间',
      '付款金额',
      '联盟佣金',
      '返利状态',
      '操作',
    ])
      expect(
        within(mainElement()).queryAllByRole('columnheader', { name }).length,
        name,
      ).toBeGreaterThan(0);
    for (const name of ['平台状态', '标记'])
      expect(within(mainElement()).queryAllByRole('columnheader', { name }), name).toEqual([]);
    await click(button(mainElement(), /^列设置$/));
    const platformStatus = within(mainElement()).getByRole('checkbox', { name: '平台状态' });
    await click(platformStatus);
    for (const text of [
      '抽纸 3 层 120 抽 24 包',
      '12,345.67',
      'SETTLED',
      'CREDITED',
      '2026-10-07',
      '01:05',
    ])
      expect(row().textContent).toContain(text);
    expect(row(rows()[0]!.sub_order_id).textContent).toContain('拼多多');
    expect(row(rows()[1]!.sub_order_id).textContent).toContain('淘宝');
    expect(row(rows()[2]!.sub_order_id).textContent).toContain('京东');
    for (const item of rows()) {
      expect(row(item.sub_order_id).textContent).toContain(item.platform_status);
      expect(row(item.sub_order_id).textContent).toContain(item.rebate_status);
    }
    await click(platformStatus);
    await click(button(mainElement(), /^列设置$/));
    // The board has one commission column; settled orders may show the settlement or both amounts.
    expect(row().textContent).toMatch(/1,123\.45|1,234\.56/);
    const rendered = within(mainElement())
      .queryAllByRole('row')
      .filter((node) => within(node).queryAllByRole('cell').length > 0);
    expect(
      rendered
        .slice(0, 3)
        .map(
          (node) =>
            rows().find((item) => node.textContent?.includes(item.sub_order_id))?.sub_order_id,
        ),
    ).toEqual(rows().map((item) => item.sub_order_id));
    expect(server.requests('GET', DETAIL)).toHaveLength(0);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-LIST#2] 用户只显示 UID 与脱敏手机号，未归因与零金额区别于未知值，标记独立呈现',
  async () => {
    await mount();
    await loaded();
    expect(row().textContent).toContain(UID);
    expect(row().textContent).toContain('138****5678');
    expect(row().textContent).not.toContain('13812345678');
    await click(button(mainElement(), /^列设置$/));
    await click(within(mainElement()).getByRole('checkbox', { name: '标记' }));
    expect(within(row()).queryAllByText('已锁定', { exact: true })).toHaveLength(1);
    expect(within(row()).queryAllByText('归属已锁定', { exact: true })).toHaveLength(1);
    expect(row(rows()[1]!.sub_order_id).textContent).toContain('未归因');
    expect(row(rows()[1]!.sub_order_id).textContent).toContain('0.00');
    expect(row(rows()[1]!.sub_order_id).textContent).not.toContain(UID);
    for (const item of rows().filter((item) => !item.flags.hold && !item.flags.rights_pending)) {
      expect(row(item.sub_order_id).textContent).not.toContain('暂停');
      expect(row(item.sub_order_id).textContent).not.toContain('维权');
    }
    const unknown = row(rows()[2]!.sub_order_id);
    expect(unknown.textContent).toContain(UID);
    expect(unknown.textContent).toMatch(/暂停/);
    expect(unknown.textContent).toMatch(/维权/);
    expect(unknown.textContent).not.toContain('0.00');
    expect(unknown.textContent).not.toMatch(/undefined|null/);
    expect(within(unknown).queryAllByText('已锁定', { exact: true })).toHaveLength(0);
    expect(within(unknown).queryAllByText('归属已锁定', { exact: true })).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-LIST#3] 七类筛选通过查询一次提交，参数名与北京时间区间按契约，展示已应用条件',
  async () => {
    const { server } = await mount();
    await loaded();
    await select(/^平台$/, /拼多多|pdd/);
    await select(/^平台状态/, 'SETTLED');
    await select(/^返利状态/, 'CREDITED');
    await select(/^订单标记/, '归属已锁定');
    await fill(textbox(/^订单号/), PARENT);
    await fill(textbox(/^用户/), UID);
    await time(/开始日期|起始日期|开始时间|起始时间|付款时间.*开始/, '2026-10-01');
    await time(/结束日期|结束时间|付款时间.*结束/, '2026-10-07');
    expect(queries(server)).toHaveLength(1);
    await query();
    await waitFor(() => expect(queries(server)).toHaveLength(2));
    await settled(server);
    const params = queries(server)[1]!;
    expect(Object.keys(params).sort()).toEqual([
      'flag',
      'page',
      'page_size',
      'paid_from',
      'paid_to',
      'platform',
      'platform_status',
      'q',
      'rebate_status',
      'user_id',
    ]);
    expect(params).toMatchObject({
      platform: 'pdd',
      platform_status: 'SETTLED',
      rebate_status: 'CREDITED',
      flag: 'locked',
      q: PARENT,
      user_id: UID,
      page: '1',
    });
    expect(params['paid_from']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(params['paid_to']).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
    expect(Date.parse(params['paid_from']!)).toBe(Date.parse('2026-10-01T00:00:00+08:00'));
    expect(Date.parse(params['paid_to']!)).toBe(Date.parse('2026-10-08T00:00:00+08:00'));
    expect(mainElement().textContent).toContain('已应用');
    expect(row().textContent).toContain(NUMBER);
    expect(mainElement().textContent).not.toContain(rows()[1]!.sub_order_id);
    await click(button(mainElement(), /^重置$/));
    await waitFor(() => expect(queries(server)).toHaveLength(3));
    await settled(server);
    expect(queries(server)[2]).toEqual({ page: '1', page_size: params['page_size'] });
    expect((textbox(/^订单号/) as HTMLInputElement).value).toBe('');
    expect((textbox(/^用户/) as HTMLInputElement).value).toBe('');
    // Submitting again must not revive hidden date, status or flag values.
    await query();
    await waitFor(() => expect(queries(server)).toHaveLength(4));
    expect(queries(server)[3]).toEqual(queries(server)[2]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-LIST#4] 页码分页保留筛选，改条件回第一页，重置移除所有空参数',
  async () => {
    const { server } = await mount(createServer(manyRows()));
    await loaded();
    await select(/^平台$/, /拼多多|pdd/);
    await query();
    await waitFor(() => expect(queries(server)).toHaveLength(2));
    await settled(server);
    await nextPage();
    await waitFor(() => expect(queries(server)).toHaveLength(3));
    await settled(server);
    const size = queries(server)[0]!['page_size'];
    expect(queries(server)[2]).toEqual({ page: '2', page_size: size, platform: 'pdd' });
    expect(mainElement().textContent).not.toContain(NUMBER);
    expect(mainElement().textContent).toContain(manyRows()[Number(size)]!.sub_order_id);
    await fill(textbox(/^订单号/), NUMBER);
    await query();
    await waitFor(() => expect(queries(server)).toHaveLength(4));
    await loaded();
    expect(queries(server)[3]).toEqual({ page: '1', page_size: size, platform: 'pdd', q: NUMBER });
    await click(button(mainElement(), /^重置$/));
    await waitFor(() => expect(queries(server)).toHaveLength(5));
    await settled(server);
    expect(queries(server)[4]).toEqual({ page: '1', page_size: size });
    expect((textbox(/^订单号/) as HTMLInputElement).value).toBe('');
    expect((textbox(/^用户/) as HTMLInputElement).value).toBe('');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-LIST#5] 订单号精确查询由服务端判定，不对本页缓存做模糊过滤',
  async () => {
    const { server } = await mount(createServer(manyRows()));
    await loaded();
    const target = manyRows()[204]!.sub_order_id;
    await fill(textbox(/^订单号/), target);
    await query();
    await waitFor(() => expect(mainElement().textContent).toContain(target));
    expect(queries(server)[1]!['q']).toBe(target);
    expect(mainElement().textContent).not.toContain(NUMBER);
    await fill(textbox(/^订单号/), target.slice(0, -1));
    await query();
    await waitFor(() => expect(mainElement().textContent).toContain('没有符合条件的订单'));
    expect(queries(server)).toHaveLength(3);
    expect(mainElement().textContent).not.toContain(target);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07e-LIST#6] 行操作名含订单号，使用 order_id 进入详情，超管也无未接入写操作',
  async () => {
    const { server } = await mount(createServer(), '/orders', { isSuper: true, permissions: [] });
    await loaded();
    readOnly(server);
    await openDetail();
    await waitFor(() => expect(window.location.pathname).toBe(ROUTE));
    await waitFor(() => expect(mainElement().textContent).toContain('分佣快照'));
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    readOnly(server);
  },
  FLOW_TIMEOUT,
);
