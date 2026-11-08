/// <reference types="@vitest/browser-playwright" />
// DSX-51a (手感方案 ⑥, D10-1037): a workbench to-do card (a link around an antd Card) shows a
// visible change when the pointer is over it (Card hoverable or an equivalent style), and the
// keyboard focus ring (:focus-visible) still shows on the link.
import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { FIRST, SHORT, ready, sample, showDashboard, unmount } from './motion-browser.ts';

afterEach(() => {
  unmount();
});

/** Computed properties a visible hover change can show up in. */
const VISIBLE = [
  'box-shadow',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-style',
  'outline-color',
  'transform',
  'translate',
  'scale',
  'filter',
  'opacity',
  'color',
] as const;
function look(nodes: readonly Element[]): string {
  return nodes
    .map((node) => {
      const style = getComputedStyle(node);
      return VISIBLE.map((name) => style.getPropertyValue(name)).join('|');
    })
    .join('||');
}

it('[AC-DSX-51a-HOVER#1] 工作台待办整卡悬停有可见反馈，键盘聚焦仍显示焦点环', async () => {
  await page.viewport(1440, 1360);
  const marker = showDashboard();
  await ready(marker);
  const link = page.getByRole('main').getByRole('link', { name: /^待审提现 / });
  await expect.element(link, FIRST).toBeVisible();
  const anchor = link.element() as HTMLElement;
  const card = anchor.querySelector('.ant-card');
  expect(card, 'the antd Card inside the to-do link').not.toBeNull();
  const nodes = [anchor, card!];
  const rest = look(nodes);
  const state = page.elementLocator(marker);
  sample(marker, 'hover', () => (look(nodes) === rest ? 'same' : 'changed'));
  await expect.element(state, SHORT).toHaveAttribute('data-hover', 'same');

  await userEvent.hover(link);
  await expect.element(state, SHORT).toHaveAttribute('data-hover', 'changed');

  await userEvent.unhover(link);
  anchor.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  await userEvent.keyboard('{Tab}');
  await expect.element(link, SHORT).toHaveFocus();
  sample(marker, 'focus', () =>
    anchor.matches(':focus-visible') && getComputedStyle(anchor).outlineStyle !== 'none'
      ? 'ring'
      : 'none',
  );
  await expect.element(state, SHORT).toHaveAttribute('data-focus', 'ring');
});
