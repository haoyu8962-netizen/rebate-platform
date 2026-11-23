// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { StatusTabs } from '../../../../apps/admin/src/components/status-tabs/index.ts';
import { statusItems } from './kit.ts';

it('[AC-F1-07ec-STATUS-TABS#1] 只给正数数量显示角标', () => {
  render(createElement(StatusTabs, { items: statusItems, activeKey: 'all', onChange: vi.fn() }));

  const paid = screen.getByRole('tab', { name: /已付款/ });
  expect(paid.textContent?.replace(/\s+/g, '')).toContain('23');
  expect(screen.getByRole('tab', { name: '全部' }).textContent?.trim()).toBe('全部');
  expect(screen.getByRole('tab', { name: '已退款' }).textContent?.trim()).toBe('已退款');
});

it('[AC-F1-07ec-STATUS-TABS#2] 切换发出标签 key，选中态随传入的 activeKey 更新', () => {
  const onChange = vi.fn();
  const props = { items: statusItems, activeKey: 'all', onChange };
  const view = render(createElement(StatusTabs, props));
  expect(screen.getByRole('tab', { selected: true }).textContent?.trim()).toBe('全部');

  fireEvent.click(screen.getByRole('tab', { name: /已付款/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('paid');
  expect(screen.getByRole('tab', { selected: true }).textContent?.trim()).toBe('全部');

  view.rerender(createElement(StatusTabs, { ...props, activeKey: 'paid' }));
  expect(screen.getByRole('tab', { name: /已付款/, selected: true })).toBeTruthy();
});
