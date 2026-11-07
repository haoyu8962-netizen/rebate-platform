/// <reference types="@vitest/browser-playwright" />
// DSX-51 round 2 (review r1 S2): the filters of a list page reflow at narrow viewports. The orders
// filter card already sits on two rows at 1440, so "at least two rows" proves nothing; these cases
// compare. The same page is opened at 1440 and at a narrow viewport (960, 800, and 1280 at 200%
// zoom); at the narrow viewport the filter controls take strictly more rows than at 1440, stay
// inside the viewport and the main area, and nothing outside a data table scrolls sideways. That
// holds with the sidebar as it opens at that width and after the one sidebar toggle is pressed
// (and pressed back), so the reflow does not depend on which state the sidebar is in.
//
// 200% zoom: Chromium's page zoom at 200% halves the CSS viewport, so a 1280 × 900 window shows
// 640 × 450 CSS pixels and every media query and layout sees 640. Vitest browser mode cannot change
// the page zoom or deviceScaleFactor of a running page, and CSS `zoom` on <html> leaves media
// queries at the unzoomed width, so the zoom case uses the equivalent CSS viewport 640 × 450.
//
// Each width gets a fresh mount (no resize of a mounted shell), so the result does not depend on
// whether the shell reacts to resizes or reads its tier once.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/shell.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { SUPER } from '../admin-dashboard/dashboard-fixtures.ts';
import { BASE_URL, NUMBER, createServer } from '../admin-orders/orders-fixtures.ts';

type Locator = ReturnType<typeof page.getByRole>;

/** Element waits stay well below the case timeout, so a red run ends in an assertion. */
const WAIT = { timeout: 8_000 };
const CASE_TIMEOUT = 40_000;
const WIDE = { width: 1440, height: 900 } as const;
/** The one sidebar toggle (collapse / expand); its name says what it acts on. */
const SIDEBAR_TOGGLE = /侧栏/;
const TABLES = 'table, [role="table"], [role="grid"]';
const SCANNED =
  'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="combobox"], [role="tab"], [role="heading"], h1, h2, h3, h4, h5, h6';
const NOT_IN_TABLE_SCROLLER =
  'h1, h2, h3, h4, h5, h6, [role="heading"], input, select, textarea, [role="combobox"]';
/** Every control of the orders filter card, by role and accessible name. */
const FILTERS = [
  ['combobox', /^平台$/],
  ['combobox', /^平台状态/],
  ['combobox', /^返利状态/],
  ['textbox', /^订单号/],
  ['textbox', /^用户/],
  ['textbox', /付款时间.*开始/],
  ['textbox', /付款时间.*结束/],
  ['combobox', /^订单标记/],
  ['button', /^查询$/],
  ['button', /^重置$/],
] as const;

interface Box {
  readonly name: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

let root: Root | undefined;

function close(): void {
  try {
    root?.unmount();
  } finally {
    root = undefined;
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  }
}

afterEach(close);

/** Mounts the shell for a super admin on the orders list, against the orders fake. */
function show(): HTMLElement {
  const server = createServer();
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    pending += 1;
    marker.dataset['pending'] = String(pending);
    try {
      return await server.fetch(input, init);
    } finally {
      pending -= 1;
      marker.dataset['pending'] = String(pending);
    }
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'orders' },
      permissionsProvider: async () => SUPER,
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return marker;
}

function frame(): Promise<void> {
  return new Promise((done) => requestAnimationFrame(() => done()));
}

/** Fonts loaded, layout flushed and finite transitions (sidebar, drawer) finished. */
async function settle(): Promise<void> {
  await document.fonts.ready;
  await frame();
  await frame();
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  await frame();
}

function viewportWidth(): number {
  return document.documentElement.clientWidth;
}

function label(element: Element): string {
  const name = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
  const classes =
    typeof element.className === 'string' && element.className.trim() !== ''
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
  return `${element.tagName.toLowerCase()}${classes}「${name.slice(0, 40)}」`;
}

function shown(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 1 &&
    rect.height > 1 &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  );
}

function scrollContainerX(element: Element): boolean {
  const { overflowX } = getComputedStyle(element);
  return overflowX === 'auto' || overflowX === 'scroll';
}

/** A data table's own scroll container: holds a table, and no heading or form field outside it. */
function tableScroller(element: Element): boolean {
  if (element.matches('main, [role="main"], body, html')) return false;
  if (element.querySelector(TABLES) === null) return false;
  return Array.from(element.querySelectorAll(NOT_IN_TABLE_SCROLLER)).every(
    (node) => node.closest(TABLES) !== null,
  );
}

function insideTableScroller(element: Element): boolean {
  for (let node = element.parentElement; node !== null; node = node.parentElement)
    if (scrollContainerX(node) && tableScroller(node)) return true;
  return false;
}

/** Everything that makes the page scroll or clip sideways; data tables' own scrolling excepted. */
function layoutProblems(): string[] {
  const problems: string[] = [];
  const width = viewportWidth();
  const { scrollWidth } = document.documentElement;
  if (scrollWidth > width + 1)
    problems.push(`document scrolls sideways: ${scrollWidth} > ${width}`);
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (!scrollContainerX(element) || element.getBoundingClientRect().width < 1) continue;
    if (element.scrollWidth <= element.clientWidth + 1 || tableScroller(element)) continue;
    problems.push(
      `scrolls sideways outside a data table: ${label(element)} ${element.scrollWidth} > ${element.clientWidth}`,
    );
  }
  for (const element of Array.from(document.body.querySelectorAll(SCANNED))) {
    if (!shown(element) || insideTableScroller(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.left < -1 || rect.right > width + 1)
      problems.push(
        `outside the viewport: ${label(element)} ${Math.round(rect.left)}–${Math.round(rect.right)} of ${width}`,
      );
  }
  return problems;
}

/** Opens the orders list at the given viewport and waits for its rows and requests to settle. */
async function openOrders(width: number, height: number): Promise<Locator> {
  close();
  await page.viewport(width, height);
  const marker = show();
  expect(window.innerWidth).toBe(width);
  const main = page.getByRole('main');
  await expect.element(main.getByRole('table'), WAIT).toBeVisible();
  await expect.element(main.getByText(NUMBER, { exact: true }), WAIT).toBeVisible();
  await expect.element(page.elementLocator(marker), WAIT).toHaveAttribute('data-pending', '0');
  await settle();
  return main;
}

/** The boxes of all filter controls, each one visible. */
async function filterBoxes(main: Locator): Promise<Box[]> {
  const boxes: Box[] = [];
  for (const [role, name] of FILTERS) {
    const control = main.getByRole(role, { name });
    await expect.element(control, WAIT).toBeVisible();
    const rect = control.element().getBoundingClientRect();
    boxes.push({
      name: String(name),
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    });
  }
  return boxes;
}

/**
 * Rows the controls sit on: walking down by top edge, a control starts a new row when it begins
 * below the vertical middle of the row it would join (controls on one row overlap vertically).
 */
function rowsOf(boxes: readonly Box[]): number {
  const sorted = [...boxes].sort((a, b) => a.top - b.top);
  let rows = 0;
  let middle = Number.NEGATIVE_INFINITY;
  for (const box of sorted) {
    if (box.top > middle) {
      rows += 1;
      middle = (box.top + box.bottom) / 2;
    }
  }
  return rows;
}

/** Every filter control lies inside the viewport and inside the main area. */
function checkInside(boxes: readonly Box[], where: string): void {
  const width = viewportWidth();
  const area = page.getByRole('main').element().getBoundingClientRect();
  for (const box of boxes) {
    expect(
      box.left,
      `${where}: filter ${box.name} starts inside the viewport`,
    ).toBeGreaterThanOrEqual(-1);
    expect(box.right, `${where}: filter ${box.name} ends inside the viewport`).toBeLessThanOrEqual(
      width + 1,
    );
    expect(box.left, `${where}: filter ${box.name} starts inside main`).toBeGreaterThanOrEqual(
      area.left - 1,
    );
    expect(box.right, `${where}: filter ${box.name} ends inside main`).toBeLessThanOrEqual(
      area.right + 1,
    );
  }
}

/** At the narrow viewport the filters take strictly more rows than at 1440 and stay inside. */
async function checkNarrow(main: Locator, wideRows: number, where: string): Promise<void> {
  const boxes = await filterBoxes(main);
  checkInside(boxes, where);
  expect(
    rowsOf(boxes),
    `${where}: the filters wrap onto more rows than the ${wideRows} they take at 1440`,
  ).toBeGreaterThan(wideRows);
  expect(layoutProblems(), where).toEqual([]);
}

async function pressSidebarToggle(): Promise<void> {
  const toggle = page.getByRole('button', { name: SIDEBAR_TOGGLE });
  await expect.element(toggle, WAIT).toBeVisible();
  await toggle.click();
  await settle();
}

async function filtersCase(width: number, height: number): Promise<void> {
  const wide = await openOrders(WIDE.width, WIDE.height);
  const wideBoxes = await filterBoxes(wide);
  checkInside(wideBoxes, '1440');
  const wideRows = rowsOf(wideBoxes);
  expect(wideRows, '1440: the filters are laid out on rows').toBeGreaterThanOrEqual(1);
  expect(
    wideRows,
    '1440: some filter controls share a row (otherwise there is nothing to wrap)',
  ).toBeLessThan(FILTERS.length);

  const main = await openOrders(width, height);
  const at = `${width}×${height}`;
  await checkNarrow(main, wideRows, `${at} as opened`);
  await pressSidebarToggle();
  await checkNarrow(main, wideRows, `${at} after toggling the sidebar`);
  await pressSidebarToggle();
  await checkNarrow(main, wideRows, `${at} after toggling the sidebar back`);
}

it(
  '[AC-DSX-51-FILTERS#1] 960 订单查询：筛选控件占的行数严格多于 1440 宽时，且不出视口与主区、表格外无横向滚动；侧栏收起与展开两种状态下都如此',
  async () => {
    await filtersCase(960, 900);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-FILTERS#2] 800 订单查询：筛选控件占的行数严格多于 1440 宽时，且不出视口与主区、表格外无横向滚动；侧栏收起与展开两种状态下都如此',
  async () => {
    await filtersCase(800, 900);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-FILTERS#3] 1280 宽 200% 缩放（640 CSS 像素）订单查询：筛选控件占的行数严格多于 1440 宽时，且不出视口与主区、表格外无横向滚动；侧栏收起与展开两种状态下都如此',
  async () => {
    await filtersCase(640, 450);
  },
  CASE_TIMEOUT,
);
