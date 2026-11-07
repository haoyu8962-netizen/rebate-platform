/// <reference types="@vitest/browser-playwright" />
// DSX-50: screenshot baseline comparison of the admin key pages (登录、工作台、订单列表、提现审核),
// light theme, at 1440×900. The pages are mounted as in their own browser rule tests (LoginPage
// with the fake auth harness; createAdminShell with the fake data servers; example data only).
// Report only: see compare.ts. Also the two-screenshot stability check and the report check.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { LoginPage } from '../../../../apps/admin/src/pages/login/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { NOW as ADMIN_NOW, TITLES, harness, signIn } from '../admin-auth/fixtures.ts';
import {
  BASE_URL as DASHBOARD_BASE_URL,
  SUPER,
  createServer as createDashboardServer,
} from '../admin-dashboard/dashboard-fixtures.ts';
import {
  BASE_URL as ORDERS_BASE_URL,
  NUMBER,
  createServer as createOrdersServer,
} from '../admin-orders/orders-fixtures.ts';
import {
  ALL_GRANTS,
  BASE_URL as WITHDRAWALS_BASE_URL,
  NO,
  createServer as createWithdrawalsServer,
  snapshot,
} from '../admin-withdrawals/fixtures.ts';
import {
  CASE_TIMEOUT,
  WAIT,
  capture,
  checkPage,
  compareCaptures,
  enterStableEnvironment,
  expectBaseline,
  leaveStableEnvironment,
  readEntry,
  record,
  settle,
  writeSummary,
} from './compare.ts';
import {
  ADMIN_DASHBOARD,
  ADMIN_LOGIN,
  ADMIN_ORDERS,
  ADMIN_PAGES,
  ADMIN_WITHDRAWALS,
  STABLE_PERCENT,
  type VisualPage,
} from './pages.ts';

/**
 * antd / rc-motion classes present only while a motion runs: the motion name itself
 * (ant-zoom-*, ant-fade-*, ant-move-*, ant-slide-*, *-motion-*) and the phase classes
 * (-appear / -enter / -leave followed by -prepare / -start / -active). A class that only
 * ends in -appear / -enter / -leave (e.g. the dashboard's static `dashboard-enter`) is not motion.
 */
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-motion-|-(?:appear|enter|leave)-(?:prepare|start|active)(?=\s|$)/;

let root: Root | undefined;
let auth: AdminAuthProvider | undefined;

afterEach(async () => {
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  await leaveStableEnvironment();
});

afterAll(async () => {
  await writeSummary('admin');
});

/** A fetch that counts its open requests on a hidden marker (data-pending). */
function counted(fetcher: typeof globalThis.fetch): {
  fetch: typeof globalThis.fetch;
  marker: HTMLElement;
} {
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    pending += 1;
    marker.dataset['pending'] = String(pending);
    try {
      return await fetcher(input, init);
    } finally {
      pending -= 1;
      marker.dataset['pending'] = String(pending);
    }
  };
  return { fetch, marker };
}

function container(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

/** No request open, fonts / images / animations settled, no antd motion class left. */
async function quiet(marker: HTMLElement): Promise<void> {
  await expect.element(marker, WAIT).toHaveAttribute('data-pending', '0');
  await settle();
  const moving = Array.from(document.querySelectorAll('[class]')).filter(
    (node): node is HTMLElement | SVGElement =>
      (node instanceof HTMLElement || node instanceof SVGElement) &&
      MOTION.test(node.getAttribute('class') ?? ''),
  );
  for (const node of moving) await expect.element(node, WAIT).not.toHaveClass(MOTION);
  await expect.element(marker, WAIT).toHaveAttribute('data-pending', '0');
  await settle();
}

async function openLogin(): Promise<HTMLElement> {
  const { marker } = counted(globalThis.fetch);
  auth = harness('totp').create();
  const element = container();
  element.id = 'root';
  root = createRoot(element);
  root.render(
    createElement(LoginPage, {
      authProvider: auth,
      environment: 'test',
      onComplete: () => undefined,
    }),
  );
  await expect.element(page.getByRole('heading', { name: TITLES.credentials }), WAIT).toBeVisible();
  await expect
    .element(page.getByRole('button', { name: '下一步', exact: true }), WAIT)
    .toBeVisible();
  await expect
    .element(page.getByText('凑狸内部系统 · 所有操作都会记入操作日志'), WAIT)
    .toBeVisible();
  return marker;
}

async function openDashboard(): Promise<HTMLElement> {
  const server = createDashboardServer();
  const { fetch, marker } = counted((input, init) => server.fetch(input, init));
  root = createRoot(container());
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'dashboard' },
      permissionsProvider: async () => SUPER,
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: DASHBOARD_BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  const main = page.getByRole('main');
  await expect.element(main.getByRole('heading', { name: /昨日概览/ }), WAIT).toBeVisible();
  await expect.element(main.getByRole('button', { name: '刷新', exact: true }), WAIT).toBeVisible();
  return marker;
}

async function openOrders(): Promise<HTMLElement> {
  const server = createOrdersServer();
  const { fetch, marker } = counted((input, init) => server.fetch(input, init));
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/orders');
  root = createRoot(container());
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: ORDERS_BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  const main = page.getByRole('main');
  await expect.element(main.getByRole('table'), WAIT).toBeVisible();
  await expect
    .element(main.getByRole('heading', { name: '订单查询', exact: true }), WAIT)
    .toBeVisible();
  await expect.element(main.getByText(NUMBER, { exact: true }), WAIT).toBeVisible();
  return marker;
}

async function openWithdrawals(): Promise<HTMLElement> {
  const server = createWithdrawalsServer(undefined, { permissions: ALL_GRANTS });
  const { fetch, marker } = counted((input, init) => server.fetch(input, init));
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/withdrawals');
  root = createRoot(container());
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => snapshot(server.permissions),
      account: { username: 'fin-yi', displayName: '财务' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: WITHDRAWALS_BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  const row = page.getByRole('main').getByRole('row').filter({ hasText: NO.pending });
  await expect.element(row, WAIT).toBeVisible();
  return marker;
}

async function compare(target: VisualPage, open: () => Promise<HTMLElement>): Promise<void> {
  await enterStableEnvironment({ theme: 'light', now: ADMIN_NOW, viewport: target.viewport });
  await quiet(await open());
  await checkPage(target, 'light');
}

it(
  '[AC-DSX-50-ADMIN#1] 后台登录页（浅色）与基准比对，差异百分比写入报告',
  () => compare(ADMIN_LOGIN, openLogin),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-ADMIN#2] 后台工作台（浅色）与基准比对，差异百分比写入报告',
  () => compare(ADMIN_DASHBOARD, openDashboard),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-ADMIN#3] 后台订单列表（浅色）与基准比对，差异百分比写入报告',
  () => compare(ADMIN_ORDERS, openOrders),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-ADMIN#4] 后台提现审核列表（浅色）与基准比对，差异百分比写入报告',
  () => compare(ADMIN_WITHDRAWALS, openWithdrawals),
  CASE_TIMEOUT,
);

it(
  '[AC-DSX-50-STABLE#2] 后台登录页（浅色）同一次运行连截两次差异小于 0.1%，并与基准比对',
  async () => {
    await enterStableEnvironment({
      theme: 'light',
      now: ADMIN_NOW,
      viewport: ADMIN_LOGIN.viewport,
    });
    await quiet(await openLogin());
    const first = await capture();
    await settle();
    const second = await capture();
    const repeat = await compareCaptures(second, first);
    const entry = await record(ADMIN_LOGIN, 'light', 'stability', second, repeat.diffPercent);
    expectBaseline(entry);
    expect(repeat.diffPercent, '同一页连截两次的差异百分比').toBeLessThan(STABLE_PERCENT);
    expect(entry.diffPercent, '第二张截图与基准的差异百分比').toEqual(expect.any(Number));
  },
  CASE_TIMEOUT,
);

// Runs last in this file: reads back the entries the comparison cases above wrote in this run.
it(
  '[AC-DSX-50-REPORT#2] 报告 test/.tmp/visual-baseline/ 含后台四页浅色共 4 项的差异百分比',
  async () => {
    const problems: string[] = [];
    for (const target of ADMIN_PAGES) {
      for (const theme of target.themes) {
        const entry = await readEntry('page', target, theme);
        if (entry === null) problems.push(`${target.id}-${theme}：报告里没有这一页`);
        else if (typeof entry.diffPercent !== 'number')
          problems.push(`${target.id}-${theme}：没有差异百分比（基准缺失）`);
      }
    }
    expect(problems).toEqual([]);
  },
  CASE_TIMEOUT,
);
