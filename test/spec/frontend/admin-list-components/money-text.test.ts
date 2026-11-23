// @vitest-environment jsdom
import { formatYuanAdmin } from '@couli/money';
import { render } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { expect, expectTypeOf, it } from 'vitest';
import { MoneyText } from '../../../../apps/admin/src/components/money-text/index.ts';
import { paidAmountFen } from './kit.ts';

it('[AC-F1-07ec-MONEY-TEXT#1] bigint 分与 formatYuanAdmin 一致，大额保留分位精度', () => {
  const view = render(createElement(MoneyText, { fen: paidAmountFen }));
  expectTypeOf<ComponentProps<typeof MoneyText>['fen']>().toEqualTypeOf<bigint | null>();
  expect(view.container.textContent).toBe(formatYuanAdmin(paidAmountFen));
});

it('[AC-F1-07ec-MONEY-TEXT#2] signed 依照格式化函数处理正数、负数和零', () => {
  const view = render(createElement(MoneyText, { fen: 123_405n, signed: true }));
  expect(view.container.textContent).toBe(formatYuanAdmin(123_405n, { signed: true }));

  for (const fen of [-123_405n, 0n]) {
    view.rerender(createElement(MoneyText, { fen, signed: true }));
    expect(view.container.textContent).toBe(formatYuanAdmin(fen, { signed: true }));
  }
});

it('[AC-F1-07ec-MONEY-TEXT#3] null 即使开启 signed 仍只显示占位符', () => {
  const view = render(createElement(MoneyText, { fen: null, signed: true }));
  expect(view.container.textContent).toBe('—');
});
