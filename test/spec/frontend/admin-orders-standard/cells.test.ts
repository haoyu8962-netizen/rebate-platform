// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { UID, createServer } from '../admin-orders/orders-fixtures.ts';
import { FLOW_TIMEOUT, click, mainElement, mount, row } from '../admin-orders/orders-helpers.ts';
import { LONG_NUMBER, PRODUCT_IMAGE, cellRows } from './kit.ts';

const [attributed, unattributed] = cellRows();

async function mountRows(): Promise<void> {
  await mount(createServer(cellRows()));
  await waitFor(() => {
    expect(detailActions()).toHaveLength(1);
    expect(mainElement().textContent).toContain(unattributed!.sub_order_id);
  });
}

function detailActions(): HTMLElement[] {
  const scope = within(mainElement());
  const name = `详情 ${LONG_NUMBER}`;
  return [...scope.queryAllByRole('button', { name }), ...scope.queryAllByRole('link', { name })];
}

function attributedRow(): HTMLElement {
  const target = detailActions()[0]?.closest<HTMLElement>('tr, [role="row"]');
  expect(target, '已归因订单行').toBeTruthy();
  return target!;
}

function cell(order: HTMLElement, column: string): HTMLElement {
  const headings = within(mainElement()).queryAllByRole('columnheader');
  const index = headings.findIndex((heading) => heading.textContent?.trim() === column);
  expect(index, `列头「${column}」`).toBeGreaterThanOrEqual(0);
  const target = within(order).queryAllByRole('cell')[index];
  expect(target, `单元格「${column}」`).toBeDefined();
  return target!;
}

async function copyFrom(scope: HTMLElement): Promise<void> {
  const buttons = within(scope).queryAllByRole('button', { name: '复制' });
  expect(buttons).toHaveLength(1);
  await click(buttons[0]!);
}

function clipboardWrite() {
  userEvent.setup();
  return vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
}

it(
  '[AC-F1-07ed-CELLS#1] 每笔订单的复制按钮写入自己的子订单号全文',
  async () => {
    await mountRows();
    const writeText = clipboardWrite();
    await copyFrom(cell(attributedRow(), '订单号'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(LONG_NUMBER);
    await copyFrom(cell(row(unattributed!.sub_order_id), '订单号'));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(unattributed!.sub_order_id);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-CELLS#2] 已归因用户可复制完整 UID 并显示脱敏手机号，未归因用户没有复制按钮',
  async () => {
    await mountRows();
    const writeText = clipboardWrite();
    const user = cell(attributedRow(), '用户');
    expect(user.textContent).toContain('138****5678');
    await copyFrom(user);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(UID);

    const emptyUser = cell(row(unattributed!.sub_order_id), '用户');
    expect(emptyUser.textContent).toContain('未归因');
    expect(within(emptyUser).queryAllByRole('button', { name: '复制' })).toHaveLength(0);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07ed-CELLS#3] 商品列的 title 属性提供全名，只渲染已有的商品图',
  async () => {
    await mountRows();
    const product = cell(attributedRow(), '商品');
    const titles = within(product).queryAllByTitle(attributed!.title!);
    expect(titles).toHaveLength(1);
    expect(Array.from(product.querySelectorAll('img'), (img) => img.getAttribute('src'))).toEqual([
      PRODUCT_IMAGE,
    ]);

    const emptyProduct = cell(row(unattributed!.sub_order_id), '商品');
    expect(emptyProduct.textContent).not.toMatch(/null|undefined/);
    expect(emptyProduct.querySelector('img')).toBeNull();
  },
  FLOW_TIMEOUT,
);
