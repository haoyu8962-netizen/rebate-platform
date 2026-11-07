/// <reference types="@vitest/browser-playwright" />
// F1-09-qr in a real Chromium at 1440: after saving a draft, 草稿预览 shows a visible QR code whose
// modules read back as this token's HomePreview deep link; the version history shows the error
// rate column. Waits use expect.element with a 5 s limit, far below the 30 s test timeout.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, HOME, TOKEN, createServer, type Server } from '../admin-home-config/fixtures.ts';
import { readQr } from './qr-reader.ts';

const WAIT = { timeout: 5_000 };
const TEST_TIMEOUT = 30_000;
const MARKER = 'home-config-qr-requests';
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

/** Waits until the editor shows the fixture's sections, i.e. the page has loaded. */
async function loaded(): Promise<void> {
  const block = page.getByRole('main').getByText('member-grid', { exact: false }).first();
  await expect.element(block, WAIT).toBeVisible();
}
function show(server: Server): void {
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.id = MARKER;
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
      initialRoute: { menuId: 'pages' },
      permissionsProvider: async () => ({ isSuper: false, permissions: ['content.page'] }),
      account: { username: 'ops-editor', displayName: '运营' },
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
}
async function idle(): Promise<void> {
  const marker = page.elementLocator(document.getElementById(MARKER)!);
  await expect.element(marker, WAIT).toHaveAttribute('data-pending', '0');
}

it(
  '[AC-F1-09u-BROWSER#1] 1440 保存草稿后草稿预览：预览区出现可见二维码，读出恰为 couli://r/HomePreview?page_key=home&token=<本次 token>',
  async () => {
    await page.viewport(1440, 1060);
    const server = createServer();
    show(server);
    const main = page.getByRole('main');
    await loaded();
    await idle();
    await main.getByRole('textbox', { name: /JSON/i }).fill('[]');
    await main.getByRole('button', { name: /保存草稿/ }).click();
    await expect.element(main.getByText(/草稿\s*v9|v9\s*草稿/).first(), WAIT).toBeVisible();
    await idle();
    await main.getByRole('button', { name: /草稿预览/ }).click();
    await expect.element(main.getByText(TOKEN).first(), WAIT).toBeVisible();
    await idle();
    const roots = [...document.querySelectorAll('main .ant-qrcode')];
    expect(roots, 'exactly one antd QRCode in the main area').toHaveLength(1);
    await expect.element(page.elementLocator(roots[0]!), WAIT).toBeVisible();
    expect(readQr(roots[0]!), 'text encoded in the preview QR code').toEqual({
      ok: true,
      text: `couli://r/HomePreview?page_key=home&token=${TOKEN}`,
    });
    expect(server.requests('POST', `${HOME}/preview-tokens`).map((entry) => entry.body)).toEqual([
      { version: 9 },
    ]);
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-09u-BROWSER#2] 1440 版本历史：错误率列可见，3/200 显示 1.5%、1/3 显示 33.33%',
  async () => {
    await page.viewport(1440, 1060);
    const server = createServer();
    for (const entry of server.history.get('home')!) {
      if (entry.version === 7) Object.assign(entry, { render_count: 200, error_count: 3 });
      if (entry.version === 6) Object.assign(entry, { render_count: 3, error_count: 1 });
    }
    show(server);
    const main = page.getByRole('main');
    await loaded();
    await idle();
    await main.getByRole('button', { name: /版本历史/ }).click();
    await expect.element(main.getByRole('columnheader', { name: /错误率/ }), WAIT).toBeVisible();
    for (const rate of ['1.5%', '33.33%'])
      await expect.element(main.getByRole('cell', { name: rate, exact: true }), WAIT).toBeVisible();
  },
  TEST_TIMEOUT,
);
