// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { DataTable } from '../../../../apps/admin/src/components/data-table/index.ts';
import {
  activePage,
  chooseOption,
  openOptions,
  selectedOptionText,
  tableHeadings,
  tableProps,
  type OrderRow,
} from './kit.ts';

it('[AC-F1-07ec-DATA-TABLE#1] 分页由 total 和 page 驱动，点击只发出换页请求', () => {
  const onPageChange = vi.fn();
  const props = { ...tableProps, onPageChange };
  const view = render(createElement(DataTable<OrderRow>, props));

  expect(activePage()).toBe('2');
  expect(screen.getByText('13')).toBeTruthy();
  expect(screen.getByRole('cell', { name: 'ORD-205' })).toBeTruthy();

  fireEvent.click(screen.getByText('3'));
  expect(onPageChange).toHaveBeenCalledExactlyOnceWith(3, 20);
  expect(activePage()).toBe('2');

  view.rerender(createElement(DataTable<OrderRow>, { ...props, page: 3 }));
  expect(activePage()).toBe('3');
});

it('[AC-F1-07ec-DATA-TABLE#2] 每页仅有 20、50、100 三种选择并发出换页大小请求', () => {
  const onPageChange = vi.fn();
  const props = { ...tableProps, onPageChange };
  const view = render(createElement(DataTable<OrderRow>, props));
  const control = screen.getByRole('combobox');
  expect(selectedOptionText(control)).toMatch(/^20\b/);

  const options = openOptions(control);
  const sizes = options.map((option) => option.textContent?.trim().match(/^\d+/)?.[0]);
  expect(sizes).toEqual(['20', '50', '100']);
  const fifty = options.find((option) => /^50\b/.test(option.textContent?.trim() ?? ''));
  expect(fifty).toBeDefined();
  if (fifty) chooseOption(control, fifty);
  expect(onPageChange).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 50);
  expect(selectedOptionText(control)).toMatch(/^20\b/);

  view.rerender(createElement(DataTable<OrderRow>, { ...props, pageSize: 50 }));
  expect(selectedOptionText(screen.getByRole('combobox'))).toMatch(/^50\b/);
});

it('[AC-F1-07ec-DATA-TABLE#3] 加载、出错和空态各自可辨，重试交给调用方', async () => {
  const onRetry = vi.fn();
  const props = { ...tableProps, rows: [], total: 0, page: 1, onRetry };
  const view = render(createElement(DataTable<OrderRow>, { ...props, loading: true }));

  await waitFor(() => {
    expect(
      view.container.querySelector('[aria-busy="true"]') ?? screen.queryByRole('progressbar'),
    ).not.toBeNull();
  });
  expect(screen.queryByText('加载失败')).toBeNull();

  view.rerender(createElement(DataTable<OrderRow>, { ...props, error: true }));
  expect(screen.getByText('加载失败')).toBeTruthy();
  expect(screen.queryByText('暂无数据')).toBeNull();
  expect(onRetry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
  expect(onRetry).toHaveBeenCalledTimes(1);

  view.rerender(createElement(DataTable<OrderRow>, props));
  expect(screen.getByText('暂无数据')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /重\s*试/ })).toBeNull();
});

it('[AC-F1-07ec-DATA-TABLE#4] 按 storageKey 分别保存列的显示开关与顺序', async () => {
  const view = render(createElement(DataTable<OrderRow>, tableProps));
  expect(tableHeadings()).toEqual(['订单号', '买家', '金额']);

  fireEvent.click(screen.getByRole('button', { name: '列设置' }));
  fireEvent.click(await screen.findByRole('button', { name: /上移.*金额|金额.*上移/ }));
  expect(tableHeadings()).toEqual(['订单号', '金额', '买家']);
  fireEvent.click(screen.getByRole('checkbox', { name: '订单号' }));
  expect(tableHeadings()).toEqual(['金额', '买家']);
  fireEvent.click(screen.getByRole('checkbox', { name: '备注' }));
  expect(tableHeadings()).toEqual(['金额', '买家', '备注']);
  await waitFor(() => expect(window.localStorage.getItem(tableProps.storageKey)).not.toBeNull());
  view.unmount();

  const differentKey = render(
    createElement(DataTable<OrderRow>, { ...tableProps, storageKey: 'admin-list-fixture:other' }),
  );
  expect(tableHeadings()).toEqual(['订单号', '买家', '金额']);
  differentKey.unmount();

  render(createElement(DataTable<OrderRow>, tableProps));
  expect(tableHeadings()).toEqual(['金额', '买家', '备注']);
});

it('[AC-F1-07ec-DATA-TABLE#5] 本地列设置不是合法 JSON 或形状不正确时回到默认列', () => {
  for (const invalid of ['{invalid-json', 'null']) {
    window.localStorage.setItem(tableProps.storageKey, invalid);
    const view = render(createElement(DataTable<OrderRow>, tableProps));
    expect(tableHeadings()).toEqual(['订单号', '买家', '金额']);
    view.unmount();
  }
});

it('[AC-F1-07ec-DATA-TABLE#6] localStorage 读取抛错仍可显示默认表格', () => {
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Storage is blocked', 'SecurityError');
  });

  render(createElement(DataTable<OrderRow>, tableProps));
  expect(read).toHaveBeenCalledWith(tableProps.storageKey);
  expect(tableHeadings()).toEqual(['订单号', '买家', '金额']);
  expect(screen.getByRole('cell', { name: 'ORD-205' })).toBeTruthy();
});

it('[AC-F1-07ec-DATA-TABLE#7] localStorage 写入抛错时保留默认列', async () => {
  render(createElement(DataTable<OrderRow>, tableProps));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage is full', 'QuotaExceededError');
  });

  fireEvent.click(screen.getByRole('button', { name: '列设置' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '订单号' }));
  await waitFor(() => {
    expect(write).toHaveBeenCalledWith(tableProps.storageKey, expect.any(String));
  });
  expect(tableHeadings()).toEqual(['订单号', '买家', '金额']);
});

it('[AC-F1-07ec-DATA-TABLE#8] 行勾选可选，回调返回完整选中行 key', () => {
  const view = render(createElement(DataTable<OrderRow>, tableProps));
  expect(screen.queryByRole('checkbox')).toBeNull();

  const onChange = vi.fn();
  view.rerender(
    createElement(DataTable<OrderRow>, {
      ...tableProps,
      selection: { selectedKeys: ['ORD-206'], onChange },
    }),
  );
  const first = within(screen.getByRole('row', { name: /ORD-205/ })).getByRole('checkbox');
  const second = within(screen.getByRole('row', { name: /ORD-206/ })).getByRole('checkbox');
  expect(first).toHaveProperty('checked', false);
  expect(second).toHaveProperty('checked', true);

  fireEvent.click(first);
  expect(onChange).toHaveBeenCalledTimes(1);
  const [selected] = onChange.mock.calls[0] ?? [];
  expect(selected).toHaveLength(2);
  expect(selected).toEqual(expect.arrayContaining(['ORD-205', 'ORD-206']));
});
