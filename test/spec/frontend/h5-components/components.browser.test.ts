/// <reference types="@vitest/browser-playwright" />
import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import {
  Dialog,
  EmptyState,
  ErrorState,
  Sheet,
  Skeleton,
  Toast,
} from '../../../../apps/h5/src/components/base/index.ts';
import '../../../../apps/h5/src/shared/styles/index.css';

let root: Root | undefined;
let originalViewport: { width: number; height: number };

/**
 * Wait (at most 2s, well under the test timeout) for the finite CSS transitions / animations of
 * the document to finish, so geometry and screenshots are read from the settled frame rather
 * than an enter motion in progress. Infinite ones (skeleton shimmer) never finish and are skipped.
 */
async function motionSettled(): Promise<void> {
  const running = document
    .getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
    .map((animation) =>
      animation.finished.then(
        () => undefined,
        () => undefined,
      ),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(running),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000);
    }),
  ]);
  clearTimeout(timer);
}

beforeEach(async () => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(375, 812);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  await page.viewport(originalViewport.width, originalViewport.height);
});

function mount(component: ReactNode): void {
  const container = document.createElement('div');
  container.style.fontFamily = 'var(--font-family-system)';
  document.body.append(container);
  let failure: unknown;
  // Rethrow the original render error in the test, including NotImplemented in the red phase.
  // This also prevents a separate unhandled React error from obscuring the red-check result.
  root = createRoot(container, {
    onUncaughtError: (error) => {
      failure = error;
    },
  });
  flushSync(() => root?.render(component));
  if (failure !== undefined) throw failure;
}

function required(selector: string, parent: ParentNode = document): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function expectTitle(element: Element, fontSize = '17px'): void {
  const style = getComputedStyle(element);
  expect(style.fontSize).toBe(fontSize);
  expect(style.fontWeight).toBe('600');
}

function expectPrimary(element: Element): void {
  const style = getComputedStyle(element);
  expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
  expect(style.borderRadius).toBe('12px');
  expect(style.backgroundColor).toBe(tokenColor('--color-brand-primary'));
  expect(style.color).toBe(tokenColor('--color-text-inverse'));
  expectTitle(element);
}

function expectFloatingPanel(element: Element): void {
  const style = getComputedStyle(element);
  expect(style.backgroundColor).toBe(tokenColor('--color-background-surface'));
  const probe = document.createElement('div');
  probe.style.boxShadow = 'var(--shadow-floating)';
  document.body.append(probe);
  expect(style.boxShadow).toBe(getComputedStyle(probe).boxShadow);
  probe.remove();
}

const stateCases = [
  {
    Component: ErrorState,
    slug: 'error-state',
    title: '加载失败',
    description: '请检查网络后重试',
    action: '重新加载',
  },
  {
    Component: EmptyState,
    slug: 'empty-state',
    title: '暂无内容',
    description: '换个条件再试试',
    action: '重新选择',
  },
] as const;

for (const { Component, slug, title, description, action } of stateCases) {
  // A fixed test title gives page.screenshot() a stable filename in the configured export dir.
  it(`[AC-F1-01f-VISUAL#1] h5-components-${slug}`, async () => {
    mount(
      createElement(
        'main',
        { style: { padding: 16, minHeight: '100dvh', display: 'grid', placeItems: 'center' } },
        createElement(Component, {
          title,
          description,
          icon: createElement(
            'svg',
            { viewBox: '0 0 32 32', 'data-testid': 'state-icon', 'aria-hidden': true },
            createElement('circle', {
              cx: 16,
              cy: 16,
              r: 12,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
            }),
            createElement('path', {
              d: 'M16 8v10m0 4v2',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
            }),
          ),
          action: { label: action, onClick: () => {} },
        }),
      ),
    );
    await expect.element(page.getByRole('heading', { name: title })).toBeVisible();
    await expect.element(page.getByRole('button', { name: action })).toBeVisible();
    await document.fonts.ready;
    const screenshot = await page.screenshot();
    expect(screenshot).toContain(`h5-components-${slug}`);
    const heading = page.getByRole('heading', { name: title }).element();
    const button = page.getByRole('button', { name: action }).element();
    expectTitle(heading);
    expectPrimary(button);
    const illustration = required('[data-slot="state-illustration"]');
    const rect = illustration.getBoundingClientRect();
    expect(rect.width).toBe(96);
    expect(rect.height).toBe(96);
    expect(getComputedStyle(illustration).borderRadius).toBe('16px');
    expect(getComputedStyle(illustration).backgroundColor).toBe(
      tokenColor('--color-background-muted'),
    );
    const icon = page.getByTestId('state-icon').element();
    expect(icon.getBoundingClientRect().width).toBe(32);
    expect(icon.getBoundingClientRect().height).toBe(32);
    expect(getComputedStyle(icon).color).toBe(tokenColor('--color-text-secondary'));
    const helper = page.getByText(description, { exact: true }).element();
    expect(getComputedStyle(helper).fontSize).toBe('14px');
    expect(getComputedStyle(helper).color).toBe(tokenColor('--color-text-secondary'));
    const parent = illustration.parentElement!;
    expect(getComputedStyle(parent).display).toBe('flex');
    expect(getComputedStyle(parent).flexDirection).toBe('column');
    expect(getComputedStyle(parent).alignItems).toBe('center');
    expect(rect.bottom).toBeLessThanOrEqual(heading.getBoundingClientRect().top);
    expect(heading.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      helper.getBoundingClientRect().top,
    );
    expect(helper.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      button.getBoundingClientRect().top,
    );
  });
}

const modalCases = [
  { Component: Dialog, slug: 'dialog', title: '确认操作' },
  { Component: Sheet, slug: 'sheet', title: '选择方式' },
] as const;

for (const { Component, slug, title } of modalCases) {
  it(`[AC-F1-01f-VISUAL#2] h5-components-${slug}`, async () => {
    mount(
      createElement(
        Component,
        {
          open: true,
          title,
          description: '请确认以下内容后继续',
          closeLabel: '关闭面板',
          onClose: () => {},
          primaryAction: { label: '确认', onClick: () => {} },
          secondaryAction: { label: '取消', onClick: () => {} },
        },
        createElement('p', null, '这里是调用方传入的正文。'),
      ),
    );
    await expect.element(page.getByRole('dialog', { name: title })).toBeVisible();
    await expect.element(page.getByRole('button', { name: '确认', exact: true })).toBeVisible();
    await document.fonts.ready;
    await motionSettled();
    const screenshot = await page.screenshot();
    expect(screenshot).toContain(`h5-components-${slug}`);
    const modal = page.getByRole('dialog', { name: title }).element();
    const style = getComputedStyle(modal);
    const box = modal.getBoundingClientRect();
    expectFloatingPanel(modal);
    expectTitle(
      page.getByRole('heading', { name: title }).element(),
      Component === Sheet ? '22px' : '17px',
    );
    expectPrimary(page.getByRole('button', { name: '确认', exact: true }).element());
    const secondary = page.getByRole('button', { name: '取消', exact: true }).element();
    const secondaryStyle = getComputedStyle(secondary);
    expect(secondary.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    expect(secondaryStyle.borderRadius).toBe('12px');
    expect(secondaryStyle.backgroundColor).toBe(tokenColor('--color-background-surface'));
    expect(parseFloat(secondaryStyle.borderTopWidth)).toBeGreaterThan(0);
    const close = page.getByRole('button', { name: '关闭面板' });
    const closeBox = close.element().getBoundingClientRect();
    expect(closeBox.width).toBeGreaterThanOrEqual(44);
    expect(closeBox.height).toBeGreaterThanOrEqual(44);
    const body = required('[data-slot="modal-body"]', modal);
    expect(getComputedStyle(body).fontSize).toBe('14px');
    expect(['auto', 'scroll']).toContain(getComputedStyle(body).overflowY);
    const actions = required('[data-slot="modal-actions"]', modal);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(375);
    if (Component === Dialog) {
      expect(style.borderRadius).toBe('16px');
      expect(style.paddingTop).toBe('20px');
      expect(style.paddingRight).toBe('20px');
      expect(style.paddingBottom).toBe('20px');
      expect(style.paddingLeft).toBe('20px');
      expect(box.x + box.width / 2).toBeCloseTo(375 / 2, 0);
      expect(box.y + box.height / 2).toBeCloseTo(812 / 2, 0);
      expect(box.height).toBeLessThanOrEqual(764);
      const rowStyle = getComputedStyle(actions);
      expect(rowStyle.display).toBe('flex');
      expect(rowStyle.flexWrap).toBe('wrap-reverse');
      expect(rowStyle.gap).toBe('12px');
      for (const button of actions.querySelectorAll('button')) {
        const buttonStyle = getComputedStyle(button);
        expect(buttonStyle.flexGrow).toBe('1');
        expect(buttonStyle.flexShrink).toBe('1');
        expect(['0px', '0%']).toContain(buttonStyle.flexBasis);
        expect(buttonStyle.minWidth).toBe('max-content');
      }
    } else {
      expect(style.borderTopLeftRadius).toBe('24px');
      expect(style.borderTopRightRadius).toBe('24px');
      expect(style.borderBottomLeftRadius).toBe('0px');
      expect(style.borderBottomRightRadius).toBe('0px');
      expect(style.paddingTop).toBe('20px');
      expect(style.paddingRight).toBe('16px');
      expect(style.paddingBottom).toBe('34px');
      expect(style.paddingLeft).toBe('16px');
      expect(style.rowGap).toBe('16px');
      expect(box.bottom).toBeCloseTo(812, 0);
      expect(box.height).toBeLessThanOrEqual(788);
      const handle = required('[data-slot="sheet-handle"]', modal).getBoundingClientRect();
      expect(handle.width).toBe(36);
      expect(handle.height).toBe(4);
    }
    await userEvent.keyboard('{Tab}');
    await expect.element(close).toHaveFocus();
    const focus = getComputedStyle(close.element());
    const focusColor = tokenColor('--color-focus-ring');
    const outline =
      focus.outlineStyle === 'solid' &&
      focus.outlineWidth === '2px' &&
      focus.outlineOffset === '2px' &&
      focus.outlineColor === focusColor;
    const ring =
      focus.boxShadow.includes(focusColor) &&
      focus.boxShadow.includes('0px 0px 0px 4px') &&
      focus.boxShadow.includes('0px 0px 0px 2px');
    expect(outline || ring, 'focus-visible: token color, 2px width and 2px offset').toBe(true);
  });

  it(`[AC-F1-01f-LAYOUT#1] ${slug} 长内容仅中段滚动，标题关闭与操作保持可见`, async () => {
    mount(
      createElement(
        Component,
        {
          open: true,
          title,
          closeLabel: '关闭面板',
          onClose: () => {},
          primaryAction: { label: '确认', onClick: () => {} },
        },
        Array.from({ length: 60 }, (_, i) =>
          createElement('p', { key: i }, `第 ${i + 1} 行长内容，用于验证正文滚动。`),
        ),
      ),
    );
    await expect.element(page.getByRole('dialog', { name: title })).toBeVisible();
    await expect.element(page.getByRole('button', { name: '确认', exact: true })).toBeVisible();
    await motionSettled();
    const modal = page.getByRole('dialog', { name: title }).element();
    const body = required('[data-slot="modal-body"]', modal);
    const titleElement = page.getByRole('heading', { name: title }).element();
    const close = page.getByRole('button', { name: '关闭面板' }).element();
    const actions = required('[data-slot="modal-actions"]', modal);
    const initial = [titleElement, close, actions].map(
      (element) => element.getBoundingClientRect().top,
    );
    expect(['auto', 'scroll']).toContain(getComputedStyle(body).overflowY);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(body.clientHeight).toBeGreaterThan(0);
    expect(modal.getBoundingClientRect().top).toBeGreaterThanOrEqual(24);
    expect(modal.getBoundingClientRect().height).toBeLessThanOrEqual(
      Component === Dialog ? 764 : 788,
    );
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);
    for (const [i, element] of [titleElement, close, actions].entries()) {
      const rect = element.getBoundingClientRect();
      expect(rect.top).toBe(initial[i]);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(812);
      expect(body.contains(element)).toBe(false);
    }
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(812);
  });
}

it('[AC-F1-01f-LAYOUT#2] Skeleton 使用 placeholder 令牌和 8px 圆角', async () => {
  mount(createElement(Skeleton, { width: 160, height: 32 }));
  await expect.element(page.elementLocator(required('[data-slot="skeleton-block"]'))).toBeVisible();
  const block = required('[data-slot="skeleton-block"]');
  expect(getComputedStyle(block).backgroundColor).toBe(
    tokenColor('--color-background-placeholder'),
  );
  expect(getComputedStyle(block).borderRadius).toBe('8px');
  expect(block.getBoundingClientRect().width).toBe(160);
  expect(block.getBoundingClientRect().height).toBe(32);
});

it('[AC-F1-01f-LAYOUT#3] Toast 固定于底部中央且在视口内', async () => {
  mount(createElement(Toast, { message: '操作已完成', durationMs: 60_000 }));
  await expect.element(page.getByRole('status')).toBeVisible();
  const status = page.getByRole('status').element();
  const box = status.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(375);
  expect(box.x + box.width / 2).toBeCloseTo(375 / 2, 0);
  expect(box.top).toBeGreaterThan(812 / 2);
  expect(box.bottom).toBeLessThanOrEqual(812);
  let positioned: Element | null = status;
  while (positioned !== null && getComputedStyle(positioned).position !== 'fixed') {
    positioned = positioned.parentElement;
  }
  expect(positioned).not.toBeNull();
});
