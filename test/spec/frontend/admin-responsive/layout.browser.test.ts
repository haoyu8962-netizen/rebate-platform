/// <reference types="@vitest/browser-playwright" />
// DSX-51 (规划/05 §3.11.3, 编排 D10-724 ②; 03 §10.4 后台行, WCAG 2.2 1.4.4 / 1.4.10): at 1280, 960,
// 800 wide and at 200% zoom the admin needs no page-level horizontal scrolling (a data table may
// scroll inside its own container), the filters wrap, a wide table keeps its action column in view,
// and one button with an accessible name collapses and expands the sidebar. 1440 keeps the
// sidebar expanded beside the content.
//
// 200% zoom: Chromium's page zoom at 200% halves the CSS viewport, so a 1280 × 900 window shows
// 640 × 450 CSS pixels and every media query and layout sees 640. Vitest browser mode cannot change
// the page zoom or deviceScaleFactor of a running page, and CSS `zoom` on <html> leaves media
// queries at the unzoomed width (not what a zoomed browser does), so these cases use the
// equivalent CSS viewport 640 × 450.
//
// The shell scrolls its content inside <main> (the document itself does not scroll), so "page-level
// horizontal scrolling" covers the document and every horizontal scroll container that is not a
// data table's own container; controls and headings that end up outside the viewport (clipped
// instead of reflowed) count as well.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/shell.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import {
  SUPER,
  createServer as createDashboardServer,
} from '../admin-dashboard/dashboard-fixtures.ts';
import {
  BASE_URL,
  NUMBER,
  OID,
  createServer as createOrdersServer,
} from '../admin-orders/orders-fixtures.ts';

type Locator = ReturnType<typeof page.getByRole>;

/** Element waits stay well below the case timeout, so a red run ends in an assertion. */
const WAIT = { timeout: 8_000 };
const CASE_TIMEOUT = 30_000;
const NAVIGATION = '主导航';
/** The one sidebar toggle (collapse / expand); its name says what it acts on. */
const SIDEBAR_TOGGLE = /侧栏/;
const FIRST_MENU = '工作台';
const TABLES = 'table, [role="table"], [role="grid"]';
const SCANNED =
  'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="combobox"], [role="tab"], [role="heading"], h1, h2, h3, h4, h5, h6';
const NOT_IN_TABLE_SCROLLER =
  'h1, h2, h3, h4, h5, h6, [role="heading"], input, select, textarea, [role="combobox"]';
const FILTERS = [
  ['combobox', /^平台$/],
  ['combobox', /^平台状态/],
  ['combobox', /^返利状态/],
  ['combobox', /^订单标记/],
  ['textbox', /^订单号/],
  ['textbox', /^用户/],
  ['button', /^查询$/],
  ['button', /^重置$/],
] as const;

let root: Root | undefined;
afterEach(() => {
  try {
    root?.unmount();
  } finally {
    root = undefined;
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  }
});

/** Mounts the shell for a super admin on `menuId`, against the dashboard and orders fakes. */
function show(menuId: string): HTMLElement {
  const orders = createOrdersServer();
  const dashboard = createDashboardServer();
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    pending += 1;
    marker.dataset['pending'] = String(pending);
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const server = url.pathname.startsWith('/admin/v1/orders') ? orders : dashboard;
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
      initialRoute: { menuId },
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

async function idle(marker: HTMLElement): Promise<void> {
  await expect.element(page.elementLocator(marker), WAIT).toHaveAttribute('data-pending', '0');
  await settle();
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

/** The element's centre is on screen and a click there lands on it (not covered or clipped). */
function reachable(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x >= viewportWidth() || y >= window.innerHeight) return false;
  const hit = document.elementFromPoint(x, y);
  return hit !== null && (hit === element || element.contains(hit));
}

/** The first menu link of 主导航 can be seen and clicked: the sidebar is expanded. */
function navigationReachable(): boolean {
  return page
    .getByRole('navigation', { name: NAVIGATION })
    .getByRole('link', { name: FIRST_MENU, exact: true })
    .elements()
    .some(reachable);
}

async function pressSidebarToggle(): Promise<void> {
  const toggle = page.getByRole('button', { name: SIDEBAR_TOGGLE });
  await expect.element(toggle, WAIT).toBeVisible();
  expect(reachable(toggle.element()), 'the sidebar toggle is on screen and not covered').toBe(true);
  await toggle.click();
  await settle();
}

/** Collapse (if expanded): content takes the full width. Expand again: the menu is reachable. */
async function checkSidebarToggle(): Promise<void> {
  await expect.element(page.getByRole('button', { name: SIDEBAR_TOGGLE }), WAIT).toBeVisible();
  if (navigationReachable()) await pressSidebarToggle();
  expect(navigationReachable(), 'collapsed: 主导航 links are out of the way').toBe(false);
  const main = page.getByRole('main').element().getBoundingClientRect();
  expect(main.left, 'collapsed: main starts at the left edge').toBeLessThanOrEqual(1);
  expect(main.right, 'collapsed: main reaches the right edge').toBeGreaterThanOrEqual(
    viewportWidth() - 1,
  );
  expect(layoutProblems(), 'collapsed sidebar').toEqual([]);
  await pressSidebarToggle();
  expect(navigationReachable(), 'expanded: 主导航 links are reachable').toBe(true);
  expect(layoutProblems(), 'expanded sidebar').toEqual([]);
}

async function open(width: number, height: number, menuId: string): Promise<HTMLElement> {
  await page.viewport(width, height);
  const marker = show(menuId);
  expect(window.innerWidth).toBe(width);
  return marker;
}

async function dashboardCase(width: number, height: number): Promise<void> {
  const marker = await open(width, height, 'dashboard');
  await expect
    .element(page.getByRole('main').getByRole('heading', { name: /昨日概览/ }), WAIT)
    .toBeVisible();
  await idle(marker);
  expect(layoutProblems(), 'as opened').toEqual([]);
  await checkSidebarToggle();
}

async function detailCase(width: number, height: number): Promise<void> {
  const marker = await open(width, height, `orders/${OID}`);
  const main = page.getByRole('main');
  await expect.element(main.getByText('分佣快照', { exact: true }), WAIT).toBeVisible();
  await expect.element(main.getByText('基本信息', { exact: true })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /返回/ })).toBeVisible();
  await idle(marker);
  expect(layoutProblems(), 'as opened').toEqual([]);
  await checkSidebarToggle();
}

/** Filter controls stay inside the viewport and wrap onto more than one row. */
async function checkFilters(main: Locator): Promise<void> {
  const tops: number[] = [];
  for (const [role, name] of FILTERS) {
    const control = main.getByRole(role, { name });
    await expect.element(control, WAIT).toBeVisible();
    const rect = control.element().getBoundingClientRect();
    expect(rect.left, `filter ${String(name)} starts inside the viewport`).toBeGreaterThanOrEqual(
      -1,
    );
    expect(rect.right, `filter ${String(name)} ends inside the viewport`).toBeLessThanOrEqual(
      viewportWidth() + 1,
    );
    tops.push(rect.top);
  }
  const rows = [...tops]
    .sort((a, b) => a - b)
    .filter((top, index, sorted) => index === 0 || top - sorted[index - 1]! > 4).length;
  expect(rows, 'filters wrap onto more than one row').toBeGreaterThanOrEqual(2);
}

/** The wide table scrolls in its own container; its 详情 column stays in view at both ends. */
async function checkWideTable(main: Locator, mustOverflow: boolean): Promise<void> {
  const table = main.getByRole('table');
  await expect.element(table, WAIT).toBeVisible();
  const action = main.getByRole('button', { name: `详情 ${NUMBER}`, exact: true });
  await expect.element(action).toBeVisible();
  let scroller: Element | null = table.element().parentElement;
  while (scroller !== null && !(scrollContainerX(scroller) && tableScroller(scroller)))
    scroller = scroller.parentElement;
  expect(scroller, 'the table has its own horizontal scroll container').not.toBeNull();
  if (scroller === null) return;
  if (mustOverflow)
    expect(
      scroller.scrollWidth,
      'the wide table is wider than its container (columns kept, not dropped)',
    ).toBeGreaterThan(scroller.clientWidth + 1);
  action.element().scrollIntoView({ block: 'center', inline: 'nearest' });
  for (const left of [0, scroller.scrollWidth]) {
    scroller.scrollLeft = left;
    await settle();
    const box = scroller.getBoundingClientRect();
    const rect = action.element().getBoundingClientRect();
    const where = `table scrolled to ${scroller.scrollLeft}`;
    expect(rect.left, `${where}: 详情 starts inside the table`).toBeGreaterThanOrEqual(
      box.left - 1,
    );
    expect(rect.right, `${where}: 详情 ends inside the table`).toBeLessThanOrEqual(box.right + 1);
    expect(reachable(action.element()), `${where}: 详情 can be clicked`).toBe(true);
  }
  scroller.scrollLeft = 0;
  await settle();
}

async function ordersCase(width: number, height: number, mustOverflow: boolean): Promise<void> {
  const marker = await open(width, height, 'orders');
  const main = page.getByRole('main');
  await expect.element(main.getByRole('table'), WAIT).toBeVisible();
  await expect.element(main.getByText(NUMBER, { exact: true }), WAIT).toBeVisible();
  await idle(marker);
  expect(layoutProblems(), 'as opened').toEqual([]);
  await checkFilters(main);
  await checkWideTable(main, mustOverflow);
  await checkSidebarToggle();
}

it(
  '[AC-DSX-51-BROWSER#1] 1440 侧栏照旧展开在内容旁；1280 工作台无页面级横向滚动，侧栏可经按钮收起（主区占满宽）与展开',
  async () => {
    const marker = await open(1440, 900, 'dashboard');
    await expect
      .element(page.getByRole('main').getByRole('heading', { name: /昨日概览/ }), WAIT)
      .toBeVisible();
    await idle(marker);
    const navigation = page.getByRole('navigation', { name: NAVIGATION });
    await expect.element(navigation, WAIT).toBeVisible();
    expect(navigationReachable(), '1440: 主导航 is expanded').toBe(true);
    expect(
      navigation.element().getBoundingClientRect().right,
      '1440: the sidebar sits beside the content, not over it',
    ).toBeLessThanOrEqual(page.getByRole('main').element().getBoundingClientRect().left + 1);
    expect(layoutProblems(), '1440').toEqual([]);
    await page.viewport(1280, 900);
    await settle();
    expect(window.innerWidth).toBe(1280);
    expect(layoutProblems(), '1280 as resized').toEqual([]);
    await checkSidebarToggle();
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#2] 1280 订单查询：表格外无横向滚动、筛选不出界、宽表详情列固定可见，侧栏可收起与展开',
  async () => {
    await ordersCase(1280, 900, false);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#3] 1280 订单详情：无页面级横向滚动，侧栏可收起与展开',
  async () => {
    await detailCase(1280, 900);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#4] 960 工作台：无页面级横向滚动，侧栏可收起与展开',
  async () => {
    await dashboardCase(960, 900);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#5] 960 订单查询：筛选换行、表格外无横向滚动、宽表详情列固定可见，侧栏可收起与展开',
  async () => {
    await ordersCase(960, 900, false);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#6] 960 订单详情：无页面级横向滚动，侧栏可收起与展开',
  async () => {
    await detailCase(960, 900);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#7] 800 工作台：无页面级横向滚动，侧栏可收起与展开',
  async () => {
    await dashboardCase(800, 900);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#8] 800 订单查询：筛选换行、宽表只在表格内横向滚动且详情列固定可见，侧栏可收起与展开',
  async () => {
    await ordersCase(800, 900, true);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#9] 800 订单详情：无页面级横向滚动，侧栏可收起与展开',
  async () => {
    await detailCase(800, 900);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#10] 1280 宽 200% 缩放（640 CSS 像素）工作台：无页面级横向滚动，侧栏可收起与展开',
  async () => {
    await dashboardCase(640, 450);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#11] 1280 宽 200% 缩放（640 CSS 像素）订单查询：筛选换行、宽表只在表格内横向滚动且详情列固定可见，侧栏可收起与展开',
  async () => {
    await ordersCase(640, 450, true);
  },
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-51-BROWSER#12] 1280 宽 200% 缩放（640 CSS 像素）订单详情：无页面级横向滚动，侧栏可收起与展开',
  async () => {
    await detailCase(640, 450);
  },
  CASE_TIMEOUT,
);
