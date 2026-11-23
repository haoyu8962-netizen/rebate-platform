// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { FilterBar } from '../../../../apps/admin/src/components/filter-bar/index.ts';
import {
  chooseOption,
  enterValue,
  expectFilterValue,
  filterFields,
  filters,
  openOptions,
  readQuery,
  selectedOptionText,
  setQuery,
} from './kit.ts';

it('[AC-F1-07ec-FILTER-BAR#1] 五类筛选提交后进 URL，同一 URL 重新挂载时回填', async () => {
  setQuery({ view: 'compact' });
  const onSubmit = vi.fn();
  const props = { fields: filterFields, onSubmit };
  const first = render(createElement(FilterBar, props));

  enterValue('订单号', filters.order);
  enterValue('店铺关键词', filters.shop);
  const status = screen.getByRole('combobox', { name: '订单状态' });
  const settled = openOptions(status).find((option) => option.textContent?.trim() === '已结算');
  expect(settled).toBeDefined();
  if (settled) chooseOption(status, settled);
  enterValue('付款开始日期', filters.paid_from, true);
  enterValue('付款结束日期', filters.paid_to, true);
  fireEvent.click(screen.getByRole('button', { name: '更多条件' }));
  enterValue('最低佣金', filters.min_commission);
  enterValue('最高佣金', filters.max_commission);
  expect(Object.fromEntries(readQuery())).toEqual({ view: 'compact' });

  fireEvent.click(screen.getByRole('button', { name: /查\s*询|筛\s*选|提\s*交|应\s*用/ }));
  await waitFor(() => {
    expect(Object.fromEntries(readQuery())).toEqual({ view: 'compact', ...filters });
  });
  expect(onSubmit).toHaveBeenLastCalledWith(filters);
  first.unmount();

  render(createElement(FilterBar, props));
  expectFilterValue('订单号', filters.order);
  expectFilterValue('店铺关键词', filters.shop);
  expect(selectedOptionText(screen.getByRole('combobox', { name: '订单状态' }))).toBe('已结算');
  expectFilterValue('付款开始日期', filters.paid_from);
  expectFilterValue('付款结束日期', filters.paid_to);
  const more = screen.queryByRole('button', { name: '更多条件' });
  if (more) fireEvent.click(more);
  expectFilterValue('最低佣金', filters.min_commission);
  expectFilterValue('最高佣金', filters.max_commission);
});

it('[AC-F1-07ec-FILTER-BAR#2] URL 中忽略未知选项、非法日期和倒置区间，保留合法条件', () => {
  setQuery({
    ...filters,
    status: 'not-in-options',
    paid_from: '2026-02-30',
    paid_to: 'not-a-date',
    min_commission: '20',
    max_commission: '1',
  });
  render(createElement(FilterBar, { fields: filterFields }));

  expectFilterValue('订单号', filters.order);
  expectFilterValue('店铺关键词', filters.shop);
  expect(selectedOptionText(screen.getByRole('combobox', { name: '订单状态' }))).toBe('');
  expectFilterValue('付款开始日期', '');
  expectFilterValue('付款结束日期', '');
  fireEvent.click(screen.getByRole('button', { name: '更多条件' }));
  expectFilterValue('最低佣金', '');
  expectFilterValue('最高佣金', '');
});

it('[AC-F1-07ec-FILTER-BAR#3] 可展开和收起更多条件，普通条件一直可操作', () => {
  render(createElement(FilterBar, { fields: filterFields }));
  const minNumber = () =>
    screen.queryByRole('spinbutton', { name: '最低佣金' }) ??
    screen.queryByRole('textbox', { name: '最低佣金' });
  expect(minNumber()).toBeNull();
  expect(screen.getByRole('textbox', { name: '订单号' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '更多条件' }));
  expect(minNumber()).not.toBeNull();
  expect(screen.getByRole('textbox', { name: '订单号' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /收\s*起/ }));
  expect(minNumber()).toBeNull();
  expect(screen.getByRole('button', { name: '更多条件' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: '订单号' })).toBeTruthy();
});

it('[AC-F1-07ec-FILTER-BAR#4] 重置清空所有筛选和自有 URL 参数，保留其他参数', async () => {
  setQuery({ ...filters, view: 'compact', tab: 'paid' });
  const query = readQuery();
  query.append('view', 'wide');
  window.history.replaceState(null, '', `?${query}`);
  render(createElement(FilterBar, { fields: filterFields }));
  expectFilterValue('订单号', filters.order);

  fireEvent.click(screen.getByRole('button', { name: /重\s*置/ }));
  await waitFor(() => {
    const afterReset = readQuery();
    expect(Array.from(afterReset.keys()).sort()).toEqual(['tab', 'view', 'view']);
    expect(afterReset.getAll('view')).toEqual(['compact', 'wide']);
    expect(afterReset.get('tab')).toBe('paid');
  });
  expectFilterValue('订单号', '');
  expectFilterValue('店铺关键词', '');
  expect(selectedOptionText(screen.getByRole('combobox', { name: '订单状态' }))).toBe('');
  expectFilterValue('付款开始日期', '');
  expectFilterValue('付款结束日期', '');
  const more = screen.queryByRole('button', { name: '更多条件' });
  if (more) fireEvent.click(more);
  expectFilterValue('最低佣金', '');
  expectFilterValue('最高佣金', '');
});
