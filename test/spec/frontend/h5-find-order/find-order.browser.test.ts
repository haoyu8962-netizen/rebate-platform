/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { FindOrderPage } from '../../../../apps/h5/src/entries/app/pages/find-order/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import {
  claims,
  config,
  fixture,
  noEvidenceText,
  NOW,
  ORDER_NO,
  PAID_DATE,
  result,
  texts,
} from './find-order-fixtures.ts';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };
let originalTheme: string | null;

/**
 * Wait (at most 2s, well under the test timeout) for the finite CSS transitions / animations of
 * the document to finish, so visibility and geometry are read from the settled frame rather than
 * an enter motion in progress. Infinite ones (skeleton shimmer) never finish and are skipped.
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  viewport = { width: innerWidth, height: innerHeight };
  originalTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme');
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await page.viewport(375, 844);
});
afterEach(async () => {
  root?.unmount();
  root = undefined;
  client?.clear();
  client = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  if (originalTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', originalTheme);
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
  await page.viewport(viewport.width, viewport.height);
});

function mount(f = fixture()): HTMLElement {
  const container = document.createElement('main');
  container.style.fontFamily = 'var(--font-family-system)';
  document.body.append(container);
  let failure: unknown;
  root = createRoot(container, {
    onUncaughtError: (error) => {
      failure = error;
    },
  });
  client = createQueryClient();
  flushSync(() =>
    root?.render(
      createQueryProvider(
        createElement(
          ApiProvider,
          { api: f.api },
          createElement(
            MemoryRouter,
            { initialEntries: ['/find-order'] },
            createElement(FindOrderPage, { bridge: f.bridge }),
          ),
        ),
        client!,
      ),
    ),
  );
  if (failure !== undefined) throw failure;
  return container;
}

async function form(): Promise<void> {
  await expect
    .element(page.getByText(texts['claim.guide.paid_date'], { exact: false }))
    .toBeVisible();
  await expect.element(page.getByLabelText(/^订单号/)).toBeVisible();
  await expect.element(page.getByLabelText(/^付款日期/)).toBeVisible();
  await expect.element(page.getByRole('button', { name: /提交找回|^提交$/ })).toBeVisible();
  await page.getByLabelText(/^订单号/).fill(ORDER_NO);
  await page.getByLabelText(/^付款日期/).fill(PAID_DATE);
}

async function screenshot(container: HTMLElement, name: string): Promise<void> {
  await document.fonts.ready;
  const probe = document.createElement('output');
  probe.dataset.fitsWidth = String(
    container.scrollWidth <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
  );
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-fits-width', 'true');
  const file = await page.screenshot({ fullPage: true });
  probe.dataset.namedScreenshot = String(file.split(/[\\/]/).at(-1)?.includes(name));
  await expect.element(probe).toHaveAttribute('data-named-screenshot', 'true');
  probe.remove();
}

it('[AC-F1-04b-BROWSER#1] h5-find-order', async () => {
  const container = mount(
    fixture({
      config: {
        ...config,
        claim: { window_days: 30 },
        help_links: {
          'claim_guide.taobao': { route: 'Help', params: { article_id: 'guide-taobao' } },
        },
      },
    }),
  );
  await form();
  await expect.element(page.getByText('申请找回', { exact: true })).toBeVisible();
  await expect.element(page.getByText('找回记录', { exact: true })).toBeVisible();
  await expect.element(page.getByText(texts['claim.guide.entry'], { exact: true })).toBeVisible();
  for (const name of ['淘宝', '京东', '拼多多']) {
    const text = page.getByText(name, { exact: true });
    await expect.element(text).toBeVisible();
    const element = text.element();
    const label = element.closest('label');
    const hit =
      element.closest(
        'button, [role="button"], input[type="radio"], [role="radio"], [role="tab"]',
      ) ?? label?.control;
    const labels = hit instanceof HTMLInputElement ? [...(hit.labels ?? [])] : [];
    const hitAreas = [hit, label, ...labels].filter((node) => node != null);
    const probe = document.createElement('output');
    probe.dataset.hitSize = String(
      hitAreas.some(
        (node) =>
          node.getBoundingClientRect().width >= 44 && node.getBoundingClientRect().height >= 44,
      ),
    );
    document.body.append(probe);
    await expect.element(probe).toHaveAttribute('data-hit-size', 'true');
    const icon = hitAreas.map((node) => node.querySelector('img')).find((node) => node !== null);
    probe.dataset.iconSize = String(
      icon?.getBoundingClientRect().width === 16 && icon.getBoundingClientRect().height === 16,
    );
    await expect.element(probe).toHaveAttribute('data-icon-size', 'true');
    if (icon) await expect.element(icon).toHaveAttribute('alt', '');
    probe.remove();
  }
  await screenshot(container, 'h5-find-order');
});

it('[AC-F1-04b-BROWSER#2] h5-find-order-not-found', async () => {
  const container = mount(fixture({ signed: () => result(30201, null) }));
  await form();
  await page.getByRole('button', { name: /提交找回|^提交$/ }).click();
  await expect.element(page.getByText(texts['error.30201'], { exact: false })).toBeVisible();
  await expect.element(page.getByLabelText(/^订单号/)).toHaveValue(ORDER_NO);
  await expect.element(page.getByLabelText(/^付款日期/)).toHaveValue(PAID_DATE);
  await screenshot(container, 'h5-find-order-not-found');
});

it('[AC-F1-04b-BROWSER#3] h5-find-order-records', async () => {
  const container = mount();
  await form();
  await page.getByText('找回记录', { exact: true }).click();
  for (const claim of claims)
    await expect.element(page.getByText(new RegExp(claim.order_no))).toBeVisible();
  for (const label of ['审核中', '已自动跟单', '已找回', '未通过'])
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  await expect.element(page.getByText(noEvidenceText, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent('只显示你本人提交的找回申请');
  await motionSettled();
  const probe = document.createElement('output');
  const orderElements = claims.map((claim) => page.getByText(new RegExp(claim.order_no)).element());
  // Scope to the records' common container without requiring a particular list/tab markup.
  let recordsRegion = orderElements[0]!.parentElement!;
  while (!orderElements.every((element) => recordsRegion.contains(element)))
    recordsRegion = recordsRegion.parentElement!;
  const badges = [...recordsRegion.querySelectorAll('img')].filter(
    (icon) =>
      !icon.closest('[hidden]') &&
      icon.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  );
  probe.dataset.badgesCorrect = String(
    badges.length >= claims.length &&
      badges.every(
        (icon) =>
          icon.getBoundingClientRect().width === 12 &&
          icon.getBoundingClientRect().height === 12 &&
          icon.alt === '',
      ),
  );
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-badges-correct', 'true');
  probe.remove();
  await screenshot(container, 'h5-find-order-records');
});

it('[AC-F1-04b-BROWSER#4] h5-find-order-dark', async () => {
  const container = mount();
  await form();
  const lightBackground = getComputedStyle(document.body).backgroundColor;
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  const probe = document.createElement('output');
  document.body.append(probe);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  probe.dataset.systemDark = String(
    matchMedia('(prefers-color-scheme: dark)').matches &&
      !document.documentElement.hasAttribute('data-theme'),
  );
  probe.dataset.themeChanged = String(
    getComputedStyle(document.body).backgroundColor !== lightBackground,
  );
  await expect.element(probe).toHaveAttribute('data-system-dark', 'true');
  await expect.element(probe).toHaveAttribute('data-theme-changed', 'true');
  await expect.element(page.getByLabelText(/^订单号/)).toBeVisible();
  await expect.element(page.getByRole('button', { name: /提交找回|^提交$/ })).toBeVisible();
  probe.remove();
  await screenshot(container, 'h5-find-order-dark');
});

it('[AC-F1-04b-BROWSER#5] 窄屏与键盘压缩可视高度时输入和提交仍可操作且不横向溢出', async () => {
  const container = mount();
  await form();
  await page.viewport(320, 480);
  await page.getByLabelText(/^订单号/).click();
  await page
    .getByLabelText(/^订单号/)
    .fill('1234567890123456789012345678901234567890123456789012345678901234');
  const button = page.getByRole('button', { name: /提交找回|^提交$/ });
  await expect.element(button).toBeVisible();
  const bounds = button.element().getBoundingClientRect();
  const probe = document.createElement('output');
  probe.dataset.inViewport = String(bounds.top >= 0 && bounds.bottom <= innerHeight);
  probe.dataset.fitsWidth = String(
    container.scrollWidth <= 320 && document.documentElement.scrollWidth <= 320,
  );
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-in-viewport', 'true');
  await expect.element(probe).toHaveAttribute('data-fits-width', 'true');
  probe.remove();
});
