// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { MemberCell } from '../../../../apps/admin/src/components/member-cell/index.ts';
import { clipboardUser, member } from './kit.ts';

it('[AC-F1-07ec-MEMBER-CELL#1] 点击昵称打开该 UID 对应的会员详情', async () => {
  const { user } = clipboardUser();
  const onOpenDetail = vi.fn();
  render(createElement(MemberCell, { member, onOpenDetail }));
  expect(screen.getByText(member.uid)).toBeTruthy();
  expect(onOpenDetail).not.toHaveBeenCalled();

  await user.click(screen.getByText(member.nickname));
  expect(onOpenDetail).toHaveBeenCalledExactlyOnceWith(member.uid);
});

it('[AC-F1-07ec-MEMBER-CELL#2] UID 原样复制到剪贴板，复制操作不会打开详情', async () => {
  const { user, writeText } = clipboardUser();
  writeText.mockResolvedValue(undefined);
  const onOpenDetail = vi.fn();
  render(createElement(MemberCell, { member, onOpenDetail }));

  await user.click(screen.getByRole('button', { name: '复制' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(member.uid);
  expect(await screen.findByText('已复制')).toBeTruthy();
  expect(onOpenDetail).not.toHaveBeenCalled();
});

it('[AC-F1-07ec-MEMBER-CELL#3] 未归因会员只显示占位文案', () => {
  const onOpenDetail = vi.fn();
  const view = render(createElement(MemberCell, { member: null, onOpenDetail }));

  expect(view.container.textContent?.trim()).toBe('未归因');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(onOpenDetail).not.toHaveBeenCalled();
});
