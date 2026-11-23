// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { StatusTag } from '../../../../apps/admin/src/components/status-tag/index.ts';
import { statusMapping } from './kit.ts';

it('[AC-F1-07ec-STATUS-TAG#1] 调用方映射决定文案和 Ant Design 标签颜色', () => {
  const view = render(createElement(StatusTag, { value: 'paid', mapping: statusMapping }));
  expect(screen.getByText('已付款').closest('.ant-tag-success')).not.toBeNull();

  view.rerender(createElement(StatusTag, { value: 'failed', mapping: statusMapping }));
  expect(screen.getByText('付款失败').closest('.ant-tag-error')).not.toBeNull();
  expect(screen.queryByText('已付款')).toBeNull();
});

it('[AC-F1-07ec-STATUS-TAG#2] 未知值包括继承属性名均用原值与 Ant Design 默认色', () => {
  const view = render(createElement(StatusTag, { value: 'awaiting_sync', mapping: statusMapping }));
  for (const value of ['awaiting_sync', 'toString']) {
    view.rerender(createElement(StatusTag, { value, mapping: statusMapping }));
    const tag = screen.getByText(value).closest<HTMLElement>('.ant-tag');
    expect(tag).not.toBeNull();
    const classes = Array.from(tag?.classList ?? []);
    const modifiers = classes.filter((name) => name.startsWith('ant-tag-'));
    expect(modifiers.every((name) => /^ant-tag-(?:default|rtl|borderless)$/.test(name))).toBe(true);
    expect(tag?.style.color).toBe('');
    expect(tag?.style.backgroundColor).toBe('');
  }
});
