/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { BASE_URL, NUMBER, ROUTE, createServer } from './orders-fixtures.ts';

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});
async function show(route: string) {
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
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', route);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
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
async function screenshot(name: string, marker: HTMLElement): Promise<void> {
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  marker.dataset['overflow'] = String(document.documentElement.scrollWidth > window.innerWidth);
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-overflow', 'false');
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

it('[AC-F1-07e-BROWSER#1] 1440 订单列表筛选、表格及只读入口可见且等宽订单号，截图 admin-orders', async () => {
  await page.viewport(1440, 1080);
  const marker = await show('/orders');
  const main = page.getByRole('main');
  await expect.element(main.getByRole('table'), FIRST).toBeVisible();
  await expect.element(main.getByRole('heading', { name: '订单查询', exact: true })).toBeVisible();
  await expect.element(main.getByRole('combobox', { name: /^平台$/ })).toBeVisible();
  await expect.element(main.getByRole('combobox', { name: /^平台状态/ })).toBeVisible();
  await expect.element(main.getByRole('combobox', { name: /^返利状态/ })).toBeVisible();
  await expect.element(main.getByRole('combobox', { name: /^订单标记/ })).toBeVisible();
  await expect.element(main.getByRole('textbox', { name: /^订单号/ })).toBeVisible();
  await expect.element(main.getByRole('textbox', { name: /^用户/ })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^查询$/ })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^重置$/ })).toBeVisible();
  await expect.element(main.getByRole('table')).toMatchTextContent(NUMBER);
  await expect.element(main.getByRole('table')).toMatchTextContent('12,345.67');
  await expect.element(main.getByRole('table')).toMatchTextContent('138****5678');
  await expect.element(main.getByRole('table')).toMatchTextContent('UNATTRIBUTED');
  await expect.element(main.getByRole('button', { name: /导入|导出/ })).not.toBeInTheDocument();
  await expect.element(main.getByRole('link', { name: /导出/ })).not.toBeInTheDocument();
  await expect.element(document.querySelector<HTMLElement>('.ant-pagination')).toBeVisible();
  const number = main.getByText(NUMBER, { exact: true });
  await expect.element(number).toBeVisible();
  marker.dataset['monospace'] = String(
    /mono|consolas|courier/i.test(getComputedStyle(number.element()).fontFamily),
  );
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-monospace', 'true');
  await screenshot('admin-orders', marker);
});

it('[AC-F1-07e-BROWSER#2] 1440 详情各区块和两个锁定标记可见，截图 admin-order-detail', async () => {
  await page.viewport(1440, 1360);
  const { expectWriteEntries } = await import('../admin-orders-writes/kit.ts');
  const { detail } = await import('./orders-fixtures.ts');
  const server = createServer(undefined, detail({ reason: 'REFUND' }));
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = server.fetch(input, init);
    marker.dataset['pending'] = String(server.pending);
    try {
      return await response;
    } finally {
      marker.dataset['pending'] = String(server.pending);
    }
  };
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', ROUTE);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
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
  const main = page.getByRole('main');
  await expect.element(main.getByText('分佣快照', { exact: true }), FIRST).toBeVisible();
  await expect.element(main).toMatchTextContent(NUMBER);
  await expect.element(main.getByText('基本信息', { exact: true })).toBeVisible();
  await expect.element(main.getByText('归属信息', { exact: true })).toBeVisible();
  await expect.element(main.getByText('状态历史', { exact: true })).toBeVisible();
  await expect.element(main.getByText('转链记录', { exact: true })).toBeVisible();
  await expect.element(main.getByText('已锁定', { exact: true })).toBeVisible();
  await expect.element(main.getByText('归属已锁定', { exact: true })).toBeVisible();
  await expect.element(main).toMatchTextContent('12.34%');
  await expect.element(main).toMatchTextContent('60.00%');
  await expect.element(main.getByRole('button', { name: /返回/ })).toBeVisible();
  await expect.element(main).not.toMatchTextContent('原始报文');
  expectWriteEntries(server, ['原因细分']);
  await screenshot('admin-order-detail', marker);
});

it('[AC-F1-07e-BROWSER#3] 1280 窄窗订单详情完整可读且页面不横向溢出，截图 admin-order-detail-1280', async () => {
  await page.viewport(1280, 1360);
  const marker = await show(ROUTE);
  const main = page.getByRole('main');
  await expect.element(main.getByText('分佣快照', { exact: true }), FIRST).toBeVisible();
  await expect.element(main.getByText('基本信息', { exact: true })).toBeVisible();
  await expect.element(main.getByText('归属信息', { exact: true })).toBeVisible();
  await expect.element(main.getByText('状态历史', { exact: true })).toBeVisible();
  await expect.element(main.getByText('转链记录', { exact: true })).toBeVisible();
  await expect.element(main.getByText('已锁定', { exact: true })).toBeVisible();
  await expect.element(main.getByText('归属已锁定', { exact: true })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /返回/ })).toBeVisible();
  await expect.element(main).toMatchTextContent('1,234.56');
  await expect.element(main).toMatchTextContent('open');
  await screenshot('admin-order-detail-1280', marker);
});
