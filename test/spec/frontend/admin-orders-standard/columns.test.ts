// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FLOW_TIMEOUT,
  button,
  click,
  loaded,
  mainElement,
  mount,
} from '../admin-orders/orders-helpers.ts';
import { currentUrl } from './kit.ts';

const headings = [
  '订单号',
  '平台',
  '商品',
  '用户',
  '付款时间',
  '付款金额',
  '联盟佣金',
  '平台状态',
  '返利状态',
  '标记',
  '操作',
].sort();
const withoutCommission = headings.filter((name) => name !== '联盟佣金');

afterEach(() => window.localStorage.clear());

function columnHeadings(): string[] {
  return within(mainElement())
    .queryAllByRole('columnheader')
    .map((heading) => heading.textContent?.trim() ?? '')
    .sort();
}

async function hideCommission(): Promise<void> {
  await click(button(mainElement(), /^列设置$/));
  const matches = within(mainElement()).queryAllByRole('checkbox', { name: '联盟佣金' });
  expect(matches).toHaveLength(1);
  expect(matches[0]).toHaveProperty('checked', true);
  await click(matches[0]!);
  await waitFor(() => expect(columnHeadings()).toEqual(withoutCommission));
}

it(
  '[AC-F1-07ed-COLUMNS#1] 默认展示八列与操作列，隐藏联盟佣金后在同一地址重新打开仍隐藏',
  async () => {
    const first = await mount();
    await loaded();
    const optional = ['平台状态', '标记'];
    expect(columnHeadings()).toEqual(headings.filter((name) => !optional.includes(name)));
    await click(button(mainElement(), /^列设置$/));
    for (const name of optional) await click(within(mainElement()).getByRole('checkbox', { name }));
    await click(button(mainElement(), /^列设置$/));
    await hideCommission();

    const route = currentUrl();
    first.unmount();
    await mount(undefined, route);
    await loaded();
    expect(columnHeadings()).toEqual(withoutCommission);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-COLUMNS#2] 写坏真实的本地列设置后恢复默认八列与操作列，订单正常显示',
  async () => {
    const first = await mount();
    await loaded();
    const optional = ['平台状态', '标记'];
    await click(button(mainElement(), /^列设置$/));
    for (const name of optional) await click(within(mainElement()).getByRole('checkbox', { name }));
    await click(button(mainElement(), /^列设置$/));
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    await hideCommission();
    const keys = writes.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(1);
    const key = keys[0]!;
    expect(window.localStorage.getItem(key)).not.toBeNull();
    writes.mockRestore();

    const route = currentUrl();
    first.unmount();
    window.localStorage.setItem(key, '{broken json');
    await mount(undefined, route);
    await loaded();
    expect(columnHeadings()).toEqual(headings.filter((name) => !optional.includes(name)));
  },
  FLOW_TIMEOUT,
);
