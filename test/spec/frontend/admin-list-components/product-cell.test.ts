// @vitest-environment jsdom
import { formatYuanAdmin } from '@couli/money';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { ProductCell } from '../../../../apps/admin/src/components/product-cell/index.ts';
import { hasSingleLineEllipsis, product } from './kit.ts';

it('[AC-F1-07ec-PRODUCT-CELL#1] 完整商品显示两张传入的图与各字段，标题单行省略并可看全名', async () => {
  const user = userEvent.setup();
  const { container } = render(createElement(ProductCell, product));

  const sources = Array.from(container.querySelectorAll('img'), (img) => img.getAttribute('src'));
  expect(sources).toHaveLength(2);
  expect(sources).toEqual(expect.arrayContaining([product.imageUrl, product.platformIconUrl]));
  for (const tag of product.tags) expect(screen.getByText(tag)).toBeTruthy();
  const text = container.textContent ?? '';
  expect(text).toContain(formatYuanAdmin(product.amountFen));
  expect(text).toContain('12.34%');
  expect(text).toContain(formatYuanAdmin(product.estimatedCommissionFen));
  expect(text).toContain(product.shopName);
  expect(text).toContain(product.paidAtText);

  const title = screen.getByText(product.title);
  expect(hasSingleLineEllipsis(title, container)).toBe(true);
  if (title.closest('[title]')?.getAttribute('title') !== product.title) {
    await user.hover(title);
    expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', product.title);
  }
});

it('[AC-F1-07ec-PRODUCT-CELL#2] null 和 undefined 的字段整行隐藏，不留标签或占位符', () => {
  const { container, rerender } = render(
    createElement(ProductCell, {
      title: product.title,
      imageUrl: null,
      platformIconUrl: undefined,
      tags: null,
      amountFen: undefined,
      commissionRateBp: null,
      estimatedCommissionFen: undefined,
      shopName: null,
      paidAtText: undefined,
    }),
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent?.trim()).toBe(product.title);

  rerender(createElement(ProductCell, { title: null }));
  expect(container.textContent?.trim()).toBe('');
});

it('[AC-F1-07ec-PRODUCT-CELL#3] 缺少店铺和时间时仍显示其他行，零金额和零比例是有效值', () => {
  const { container } = render(
    createElement(ProductCell, {
      ...product,
      amountFen: 0n,
      commissionRateBp: 0,
      estimatedCommissionFen: 0n,
      shopName: null,
      paidAtText: undefined,
    }),
  );
  const text = container.textContent ?? '';
  expect(screen.getByText(product.title)).toBeTruthy();
  expect(screen.getByText(product.tags[0])).toBeTruthy();
  expect(text.split(formatYuanAdmin(0n))).toHaveLength(3);
  expect(text).toMatch(/(?:^|[^\d.])0(?:\.0{1,2})?%/);
  expect(text).not.toMatch(/null|undefined|NaN|店铺|付款时间/);
});
