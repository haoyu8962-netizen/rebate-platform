/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  BASE_URL,
  DETAIL_NUMBER,
  DETAIL_PLATFORM,
  DETAIL_ROUTE,
  NUMBER,
  RECORD,
  createServer,
  statusName,
  type Server,
} from './fixtures.ts';

// The real /orders and /orders/<order_id> routes of the admin app in Chromium (super admin):
// 【手动同步】 opens the dialog and reads the limits only then, 【同步记录】 lists the records, and
// the detail's 【同步此单】 sends { platform, order_nos: [number] } without step-up or
// Idempotency-Key. Only the order reads and the order-syncs operations go out. Waits use
// expect.element and expect.poll only.
const FIRST = { timeout: 10_000 };
const TEST_TIMEOUT = 60_000;
const SUBMITTED = /已提交|已发起|已创建|已加入|排队/g;
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
let shown: Server | undefined;
afterEach(() => {
  const checked = shown;
  shown = undefined;
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  if (checked !== undefined) expect(checked.unexpected()).toEqual([]);
});

async function show(server: Server, route: string): Promise<HTMLElement> {
  shown = server;
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

function count(pattern: RegExp): number {
  return Array.from((document.body.textContent ?? '').matchAll(pattern)).length;
}

it(
  '[AC-F1-07eb-BROWSER#1] 1440 订单列表【手动同步】打开后才读 limits，对话框的两种方式、平台、提交可见，截图 admin-order-sync',
  async () => {
    await page.viewport(1440, 1080);
    const server = createServer();
    const marker = await show(server, '/orders');
    const main = page.getByRole('main');
    await expect.element(main.getByText(NUMBER, { exact: true }), FIRST).toBeVisible();
    await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
    const requests = server.syncRequests().map(({ method, path, query }) => ({
      method,
      path,
      query,
    }));
    expect(requests).toEqual([
      { method: 'GET', path: '/admin/v1/order-syncs', query: { page: '1', page_size: '1' } },
    ]);
    const entry = main.getByRole('button', { name: /^手动同步$/ });
    await expect.element(entry, FIRST).toBeVisible();
    await entry.click();
    const dialog = page.getByRole('dialog', { name: /手动同步/ });
    await expect.element(dialog, FIRST).toBeVisible();
    await expect.poll(() => server.limitReads().length, FIRST).toBeGreaterThan(0);
    await expect.element(dialog.getByText(/^按时间窗/).first()).toBeVisible();
    await expect.element(dialog.getByText(/^按订单号/).first()).toBeVisible();
    await expect.element(dialog.getByRole('combobox', { name: /^平台$/ })).toBeVisible();
    await expect
      .element(dialog.getByRole('button', { name: /^(?:提交同步|提\s*交|确\s*定|确\s*认)$/ }))
      .toBeVisible();
    expect(server.posts()).toEqual([]);
    await screenshot('admin-order-sync', marker);
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-07eb-BROWSER#2] 1440【同步记录】列出状态中文名、平台与北京时间，截图 admin-order-sync-records',
  async () => {
    await page.viewport(1440, 1080);
    const server = createServer();
    const marker = await show(server, '/orders');
    const main = page.getByRole('main');
    await expect.element(main.getByText(NUMBER, { exact: true }), FIRST).toBeVisible();
    const initialQueries = () => server.recordReads().map(({ query }) => query);
    await expect.poll(initialQueries, FIRST).toEqual([{ page: '1', page_size: '1' }]);
    // A button or a link named 同步记录 (its text node is the click target either way).
    const entry = main.getByText(/^同步记录$/).first();
    await expect.element(entry, FIRST).toBeVisible();
    await entry.click();
    await expect.poll(() => server.recordReads().length - 1, FIRST).toBe(1);
    // Date and time may sit in separate nodes: whitespace between them is optional.
    const loose = (text: string): RegExp => new RegExp(text.replace(' ', '\\s*'));
    for (const sample of Object.values(RECORD)) {
      const row = page.getByRole('row').filter({ hasText: loose(sample.marker) });
      await expect.element(row, FIRST).toBeVisible();
      await expect.element(row).toMatchTextContent(statusName(sample.status));
      await expect.element(row).toMatchTextContent(loose(sample.created));
    }
    await screenshot('admin-order-sync-records', marker);
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-07eb-BROWSER#3] 详情【同步此单】POST { platform, order_nos: [子单号] }（无动态码、无 Idempotency-Key）并提示已提交',
  async () => {
    await page.viewport(1440, 1080);
    const server = createServer();
    await show(server, DETAIL_ROUTE);
    const main = page.getByRole('main');
    await expect.element(main.getByText(DETAIL_NUMBER).first(), FIRST).toBeVisible();
    expect(server.syncRequests()).toEqual([]);
    const entry = main.getByRole('button', { name: /^同步此单/ });
    await expect.element(entry, FIRST).toBeVisible();
    const before = count(SUBMITTED);
    await entry.click();
    const confirm = page.getByRole('button', {
      name: /^(?:确\s*定|确\s*认|提\s*交|同\s*步|继\s*续|确认同步|提交同步|开始同步)$/,
    });
    // A confirmation, or the manual sync dialog filled with this order, is accepted: confirm it.
    await expect
      .poll(() => server.posts().length + confirm.elements().length, FIRST)
      .toBeGreaterThan(0);
    if (server.posts().length === 0) await confirm.first().click();
    await expect.poll(() => server.posts().length, FIRST).toBe(1);
    const sent = server.posts()[0]!;
    expect(sent.body).toEqual({ platform: DETAIL_PLATFORM, order_nos: [DETAIL_NUMBER] });
    expect(sent.headers.has('X-Step-Up-Token')).toBe(false);
    expect(sent.headers.has('Idempotency-Key')).toBe(false);
    await expect.poll(() => count(SUBMITTED), FIRST).toBeGreaterThan(before);
    expect(server.created()).toHaveLength(1);
  },
  TEST_TIMEOUT,
);
