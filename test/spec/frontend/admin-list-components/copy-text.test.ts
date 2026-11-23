// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { CopyText } from '../../../../apps/admin/src/components/copy-text/index.ts';
import { clipboardUser, longText, shortText } from './kit.ts';

it('[AC-F1-07ec-COPY-TEXT#1] 原样展示短文本，复制成功时给出已复制提示', async () => {
  const { user, writeText } = clipboardUser();
  writeText.mockResolvedValue(undefined);
  render(createElement(CopyText, { text: shortText, maxLength: shortText.length }));

  expect(screen.getByText(shortText)).toBeTruthy();
  expect(writeText).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '复制' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(shortText);
  expect(await screen.findByText('已复制')).toBeTruthy();
});

it('[AC-F1-07ec-COPY-TEXT#2] 长文本只省略中间，悬停查看和复制均使用全文', async () => {
  const { user, writeText } = clipboardUser();
  writeText.mockResolvedValue(undefined);
  const maxLength = 13;
  render(createElement(CopyText, { text: longText, maxLength }));

  const visible = screen.getByText(/^AB.*(?:…|\.{3}).*YZ$/);
  expect(visible.textContent?.replace('...', '…').length).toBeLessThanOrEqual(maxLength);
  if (visible.closest('[title]')?.getAttribute('title') !== longText) {
    await user.hover(visible);
    expect(await screen.findByText(longText)).toBeTruthy();
  }

  await user.click(screen.getByRole('button', { name: '复制' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(longText);
});

it('[AC-F1-07ec-COPY-TEXT#3] 剪贴板拒绝写入时提示复制失败', async () => {
  const { user, writeText } = clipboardUser();
  writeText.mockRejectedValue(new DOMException('Clipboard is blocked', 'NotAllowedError'));
  render(createElement(CopyText, { text: shortText }));

  await user.click(screen.getByRole('button', { name: '复制' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(shortText);
  expect(await screen.findByText('复制失败')).toBeTruthy();
  expect(screen.queryByText('已复制')).toBeNull();
});
