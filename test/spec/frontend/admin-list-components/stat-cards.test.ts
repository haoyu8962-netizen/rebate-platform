// @vitest-environment jsdom
import { formatYuanAdmin } from '@couli/money';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { StatCards } from '../../../../apps/admin/src/components/stat-cards/index.ts';
import { paidAmountFen, paidFilter, statCards } from './kit.ts';

it('[AC-F1-07ec-STAT-CARDS#1] 超过首行张数可展开，收起后恢复初始卡片', () => {
  const cards = statCards.slice(0, 4);
  render(createElement(StatCards, { cards, initialVisibleCount: 2 }));
  expect(screen.getByText('订单总数')).toBeTruthy();
  expect(screen.getByText('付款金额')).toBeTruthy();
  expect(screen.queryByText('预估佣金合计')).toBeNull();
  expect(screen.queryByText('下单人数')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /展\s*开/ }));
  for (const card of cards) expect(screen.getByText(card.label)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /收\s*起/ }));
  expect(screen.getByText('付款金额')).toBeTruthy();
  expect(screen.queryByText('预估佣金合计')).toBeNull();
  expect(screen.queryByText('下单人数')).toBeNull();
});

it('[AC-F1-07ec-STAT-CARDS#2] 使用默认卡片上限，数量未超过上限时没有展开操作', () => {
  const view = render(createElement(StatCards, { cards: statCards.slice(0, 1) }));
  expect(screen.getByText('订单总数')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /展\s*开/ })).toBeNull();

  view.rerender(createElement(StatCards, { cards: statCards }));
  const visibleCount = statCards.filter((card) => screen.queryByText(card.label) !== null).length;
  expect(visibleCount).toBeGreaterThan(0);
  expect(visibleCount).toBeLessThan(statCards.length);
  fireEvent.click(screen.getByRole('button', { name: /展\s*开/ }));
  for (const card of statCards) expect(screen.getByText(card.label)).toBeTruthy();
});

it('[AC-F1-07ec-STAT-CARDS#3] 金额显示遵循 MoneyText，卡片点击交回配置的筛选值', () => {
  const onSelect = vi.fn();
  render(
    createElement(StatCards, {
      cards: statCards.slice(0, 3),
      initialVisibleCount: 3,
      onSelect,
    }),
  );
  expect(screen.getByText('13')).toBeTruthy();
  expect(screen.getByText(formatYuanAdmin(paidAmountFen, { signed: true }))).toBeTruthy();
  expect(screen.getByText('—')).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /付款金额/ }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(paidFilter);
});
