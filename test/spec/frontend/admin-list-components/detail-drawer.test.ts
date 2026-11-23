// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { DetailDrawer } from '../../../../apps/admin/src/components/detail-drawer/index.ts';
import { detailGroups, drawerTitle } from './kit.ts';

it('[AC-F1-07ec-DETAIL-DRAWER#1] 从右侧显示详情，按组显示字段和值，null 用破折号', async () => {
  render(
    createElement(DetailDrawer, {
      open: true,
      title: drawerTitle,
      groups: detailGroups,
      onClose: vi.fn(),
    }),
  );

  const drawer = await screen.findByRole('dialog', { name: drawerTitle });
  expect(drawer.closest('.ant-drawer-right')).not.toBeNull();
  const text = (drawer.textContent ?? '').replace(/\s+/g, '');
  expect(text).toMatch(/订单信息.*订单编号[:：]?ORD-205.*付款金额[:：]?¥20\.50.*会员信息/);
  expect(text).toMatch(/会员信息.*会员UID[:：]?—.*积分[:：]?0/);
  expect(text).not.toMatch(/null|undefined/);
});

it('[AC-F1-07ec-DETAIL-DRAWER#2] open 受控，点击关闭只通知调用方', async () => {
  const onClose = vi.fn();
  const props = { title: drawerTitle, groups: detailGroups, onClose };
  const view = render(createElement(DetailDrawer, { ...props, open: false }));
  expect(screen.queryByRole('dialog')).toBeNull();

  view.rerender(createElement(DetailDrawer, { ...props, open: true }));
  const drawer = await screen.findByRole('dialog', { name: drawerTitle });
  fireEvent.click(within(drawer).getByRole('button', { name: /关\s*闭|close/i }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog', { name: drawerTitle })).toBe(drawer);

  view.rerender(createElement(DetailDrawer, { ...props, open: false }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onClose).toHaveBeenCalledTimes(1);
});
