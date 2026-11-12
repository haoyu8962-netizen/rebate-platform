/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  createServer as createConfigServer,
  item as configItem,
} from '../admin-config-center/fixtures.ts';
import {
  BASE_URL,
  DISABLE,
  ENABLE,
  LIST,
  TARGET,
  THRESHOLDS,
  VERIFY,
  createServer,
} from './fixtures.ts';

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
let session: AdminAuthProvider | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  session?.dispose();
  session = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

async function show() {
  const server = createServer();
  const config = createConfigServer(
    THRESHOLDS.map((name, index) =>
      configItem(name, { permission: 'config.risk', value: 13 + index }),
    ),
  );
  session = harness().create();
  await signIn(session);
  window.history.replaceState(null, '', '/risk');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: session,
      permissionsProvider: async () => ({
        isSuper: false,
        permissions: ['risk.freeze', 'config.risk'],
      }),
      account: { username: 'ops-yi', displayName: '风控运营' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          return url.pathname.startsWith('/admin/v1/config-items')
            ? config.fetch(input, init)
            : server.fetch(input, init);
        },
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return { server, config };
}

function currentRow() {
  return page
    .getByRole('main')
    .getByRole('row')
    .filter({ has: page.getByText(TARGET, { exact: true }) });
}

it.each(THRESHOLDS)(
  '[AC-F1-10fa-BROWSER#3] 阈值 %s 进入配置中心并携带配置项键，全程不发写请求',
  async (threshold) => {
    const { server, config } = await show();
    await expect
      .element(page.getByRole('main').getByText(TARGET, { exact: true }), FIRST)
      .toBeVisible();
    await expect.element(page.getByRole('main').getByRole('textbox')).not.toBeInTheDocument();
    await expect.element(page.getByRole('main').getByRole('spinbutton')).not.toBeInTheDocument();
    await currentRow()
      .getByRole('link', { name: threshold, exact: true })
      .or(currentRow().getByRole('button', { name: threshold, exact: true }))
      .click();
    await expect
      .element(page.getByRole('link', { name: '配置中心', exact: true }), FIRST)
      .toHaveAttribute('aria-current', 'page');
    expect(window.location.pathname.replace(/\/$/, '')).toBe('/config');
    expect(
      decodeURIComponent(
        JSON.stringify({
          pathname: window.location.pathname,
          search: window.location.search,
          state: window.history.state as unknown,
        }),
      ),
    ).toContain(threshold);
    await expect
      .poll(() => config.log.some((request) => request.method === 'GET'), FIRST)
      .toBe(true);
    await expect.poll(() => config.pending + server.pending, FIRST).toBe(0);
    expect(config.log.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
  },
);

it('[AC-F1-10fa-BROWSER#1] 真实路由可见规则清单与全部字段，开放场景原样；阈值是入口且只读查看不验证', async () => {
  await page.viewport(1440, 1000);
  const { server } = await show();
  const main = page.getByRole('main');
  await expect
    .element(main.getByRole('tab', { name: '规则清单', exact: true }), FIRST)
    .toBeVisible();
  await expect.element(main.getByText(TARGET, { exact: true }), FIRST).toBeVisible();
  await expect.element(currentRow()).toMatchTextContent('同设备注册上限');
  await expect.element(currentRow()).toMatchTextContent('register');
  await expect.element(currentRow()).toMatchTextContent(/2026[-/]10[-/]23/);
  await expect.element(currentRow()).toMatchTextContent('03:04');
  await expect.element(main).toMatchTextContent('future_scene_v2');
  for (const threshold of THRESHOLDS) {
    const link = currentRow().getByRole('link', { name: threshold, exact: true });
    const button = currentRow().getByRole('button', { name: threshold, exact: true });
    await expect.element(link.or(button)).toBeVisible();
  }
  await expect.element(main.getByRole('textbox')).not.toBeInTheDocument();
  await expect.element(main.getByRole('spinbutton')).not.toBeInTheDocument();
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-10fa-BROWSER#2] 浏览器连续停用和启用都弹动态码，确认后才带各自凭据写入', async () => {
  await page.viewport(1440, 1000);
  const { server } = await show();
  await expect
    .element(page.getByRole('main').getByText(TARGET, { exact: true }), FIRST)
    .toBeVisible();
  for (const [index, operation] of (['disable', 'enable'] as const).entries()) {
    const named = currentRow().getByRole('button', {
      name: operation === 'disable' ? /停用/ : /启用/,
    });
    const toggle = currentRow().getByRole('switch');
    // Both a labelled button and an accessible switch are valid controls. Wait until the row
    // shows one of them (it can be re-rendering after the previous write), then click through
    // one combined locator so a re-render after the wait cannot pick a control that is absent.
    await expect
      .poll(() => named.elements().length + toggle.elements().length, FIRST)
      .toBeGreaterThan(0);
    await named.or(toggle).click();
    let modal = page.getByRole('dialog');
    await expect.element(modal, FIRST).toBeVisible();
    // Let the dialog's opening animation finish before clicking inside it: a click while the
    // box is still zooming in can land beside the moved button and be lost.
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
    await expect
      .element(page.elementLocator(modal.element().closest('.ant-modal') ?? modal.element()), FIRST)
      .not.toHaveClass(
        /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/,
      );
    if (modal.getByLabelText('动态码', { exact: true }).elements().length === 0) {
      await modal.getByRole('button', { name: /确认|验证并|继续/ }).click();
    }
    modal = page.getByRole('dialog', { name: '二次验证 · 动态码', exact: true });
    await expect.element(modal, FIRST).toBeVisible();
    expect(server.writes()).toHaveLength(index);
    expect(server.requests('POST', VERIFY)).toHaveLength(index);
    await modal.getByLabelText('动态码', { exact: true }).fill('123456');
    await modal.getByRole('button', { name: '验证并继续', exact: true }).click();
    await expect.poll(() => server.writes().length, FIRST).toBe(index + 1);
    await expect.element(modal, FIRST).not.toBeInTheDocument();
    await expect.poll(() => server.pending, FIRST).toBe(0);
    expect(server.writes()[index]!.body).toEqual({ expected_version: 7 + index });
  }
  expect(server.writes().map((request) => request.path)).toEqual([DISABLE, ENABLE]);
  expect(server.writes().map((request) => request.headers.get('X-Step-Up-Token'))).toEqual([
    'test-totp-1',
    'test-totp-2',
  ]);
  expect(server.writes().every((request) => !request.headers.has('Idempotency-Key'))).toBe(true);
}, 40_000);
