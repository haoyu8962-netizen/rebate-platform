/// <reference types="@vitest/browser-playwright" />
// F1-01x (F1-01-nav ③) in a real Chromium: the help home draws no title row of its own (native
// shows the title through ui.setNavBar); the page title stays as a screen-reader-only h1.
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { HelpPage } from '../../../../apps/h5/src/entries/app/pages/help/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import { articles, fakeBridge, helpServer } from '../h5-help/fixtures.ts';

/** Page title of the help home (same text the frozen h5-help tests read as a heading). */
const HELP_TITLE = '帮助中心';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };

beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(390, 980);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  client?.clear();
  client = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
  await page.viewport(viewport.width, viewport.height);
});

function mountHome(): HTMLElement {
  const container = document.createElement('main');
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
          { api: helpServer().api },
          createElement(
            MemoryRouter,
            { initialEntries: ['/help'] },
            createElement(HelpPage, { bridge: fakeBridge().bridge }),
          ),
        ),
        client!,
      ),
    ),
  );
  if (failure !== undefined) throw failure;
  return container;
}

/** Clipped to at most 1×1 px (the sr-only pattern): in the accessibility tree, not on screen. */
function visuallyHidden(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const clipped =
    style.overflow === 'hidden' ||
    (style.clipPath !== '' && style.clipPath !== 'none') ||
    (style.clip !== '' && style.clip !== 'auto');
  return rect.width <= 1 && rect.height <= 1 && clipped;
}

/** Elements outside `heading` whose own text is exactly `text` and that take up visible space. */
function visibleTextRows(container: HTMLElement, heading: Element, text: string): string[] {
  const rows: string[] = [];
  for (const element of container.querySelectorAll('*')) {
    if (heading.contains(element)) continue;
    const own = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (own !== text) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden')
      rows.push(element.tagName.toLowerCase());
  }
  return rows;
}

it('[AC-F1-01x-HELP#1] help-home 无自绘标题行：「帮助中心」只作 sr-only 的 h1，读屏可读、可见区域无同名标题', async () => {
  const container = mountHome();
  await expect.element(page.getByRole('heading', { name: '常见问题' })).toBeVisible();
  await expect.element(page.getByText(articles[0]!.title, { exact: true })).toBeVisible();
  const title = page.getByRole('heading', { name: HELP_TITLE, level: 1, exact: true });
  await expect.element(title).toBeInTheDocument();
  const heading = title.element();
  const probe = document.createElement('span');
  probe.dataset.srOnly = String(visuallyHidden(heading));
  probe.dataset.visibleTitleRows = visibleTextRows(container, heading, HELP_TITLE).join(',');
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-sr-only', 'true');
  await expect.element(probe).toHaveAttribute('data-visible-title-rows', '');
  probe.remove();
});
