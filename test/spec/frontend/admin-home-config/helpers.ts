import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { HomeConfigPage } from '../../../../apps/admin/src/pages/home-config/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  button,
  click,
  enabled,
  expectText,
  input,
  mainElement,
  versionRow,
} from '../admin-config-center/helpers.ts';
import { BASE_URL, TOKEN, createServer, type Server } from './fixtures.ts';

export { button, click, enabled, expectText, input, mainElement, versionRow };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const PERMITTED: PermissionSnapshot = { isSuper: false, permissions: ['content.page'] };

export async function mount(server = createServer(), snapshot = PERMITTED, defaultRoute = false) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-editor', displayName: '运营' },
        environment: 'test',
        onLogout: vi.fn(),
        // Unauthorized direct-page tests use a permitted shell route to exercise the page guard.
        initialRoute: {
          menuId:
            !defaultRoute && !snapshot.isSuper && !snapshot.permissions.includes('content.page')
              ? 'config'
              : 'pages',
        },
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
        ...(defaultRoute
          ? {}
          : { renderPage: (_menu, access) => createElement(HomeConfigPage, { access }) }),
      }),
    );
  });
  return { server, directFetch };
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
export function editor(): HTMLTextAreaElement {
  const field = within(mainElement()).queryByRole('textbox', { name: /JSON/i });
  expect(field, 'JSON editor with an accessible label').not.toBeNull();
  return field as HTMLTextAreaElement;
}
export async function loaded(): Promise<void> {
  await waitFor(() => expect(editor().value).toContain('member-grid'));
}
export async function history(server: Server): Promise<void> {
  await click(button(mainElement(), /版本历史/));
  await versionRow(mainElement(), 8);
  await settled(server);
}
export async function modal(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(1));
  return screen.getByRole('dialog');
}
export async function publish(): Promise<HTMLElement> {
  await click(button(mainElement(), /^发布$/));
  return modal();
}
export async function confirm(scope: HTMLElement, twice = false): Promise<void> {
  const control = button(scope, /^(确认|确定|发布|保存|调整|转为全量|停止灰度|回滚)/);
  await act(async () => {
    fireEvent.click(control);
    if (twice) fireEvent.click(control);
  });
}
/** Allow immediate action or an ordinary confirmation; never handle a step-up dialog. */
export async function action(control: HTMLElement, twice = false): Promise<void> {
  await act(async () => {
    fireEvent.click(control);
    if (twice) fireEvent.click(control);
  });
  const dialogs = screen.queryAllByRole('dialog');
  if (
    dialogs.length > 0 &&
    within(dialogs[0]!).queryAllByRole('button', {
      name: /^(确认|确定|发布|保存|调整|转为全量|停止灰度|回滚)/,
    }).length > 0
  )
    await confirm(dialogs[0]!, twice);
}
export async function message(pattern: RegExp): Promise<void> {
  await waitFor(() => expect(document.body.textContent).toMatch(pattern));
}
export async function choosePage(key: string): Promise<void> {
  const select = within(mainElement()).getByRole('combobox', { name: /页面/ });
  await act(async () => {
    fireEvent.mouseDown(select);
  });
  await click(await screen.findByRole('option', { name: new RegExp(key) }));
}
export function noStepUp(server: Server): void {
  expect(server.requests('POST').some((entry) => entry.path.includes('/auth/step-up'))).toBe(false);
  for (const request of server.log) expect(request.headers.has('X-Step-Up-Token')).toBe(false);
  expect(screen.queryByRole('textbox', { name: /动态码/ })).toBeNull();
}

// Two-state transition for F1-09u: the dictionary placeholder picks the branch, and the page must agree.
export const QR_PLACEHOLDER = '二维码待深链定稿';
const moduleUrl = import.meta.url;
export const HOME_CONFIG_TEXTS = fileURLToPath(
  new URL('../../../../apps/admin/src/texts/home-config.ts', moduleUrl),
);
/** True while the dictionary still carries the "QR pending deep link" placeholder (old branch). */
export function qrPlaceholderPending(): boolean {
  return readFileSync(HOME_CONFIG_TEXTS, 'utf8').includes(QR_PLACEHOLDER);
}
/** Remove only `couli://r/HomePreview` prefixes followed by a query, a quote or the end of the text. */
export function withoutPreviewLinkPrefix(text: string): string {
  return text.replace(/couli:\/\/r\/HomePreview(?=[?'"`\s]|$)/gm, '');
}
/** The only deep link the preview page text may show: the fixture page key and token. */
export const PREVIEW_LINK = `couli://r/HomePreview?page_key=home&token=${TOKEN}`;
/** QR roots: antd QRCode container, or a bare canvas / svg / QR image outside it; icons excluded. */
export function qrCodes(scope: ParentNode): Element[] {
  return [...scope.querySelectorAll('.ant-qrcode, canvas, svg, img[alt*="二维码"]')].filter(
    (node) => !node.closest('.anticon, .ant-empty') && !node.parentElement?.closest('.ant-qrcode'),
  );
}
/** Expect exactly one QR on the page, rendered in the region that shows the preview token. */
export function expectSinglePreviewQr(): void {
  const roots = [...document.querySelectorAll('.ant-qrcode, canvas, img[alt*="二维码"]')].filter(
    (node) => !node.parentElement?.closest('.ant-qrcode'),
  );
  expect(roots, 'exactly one QR container / canvas on the page').toHaveLength(1);
  const qr = roots[0]!;
  let region = qr.parentElement;
  while (region && !(region.textContent ?? '').includes(TOKEN)) region = region.parentElement;
  expect(region, 'QR shares a region with the preview token').not.toBeNull();
  expect(region!.matches('body, main, [role="dialog"]')).toBe(false);
  expect(region!.closest('main, [role="dialog"]')).not.toBeNull();
  expect(qrCodes(region!), 'exactly one QR in the preview result region').toHaveLength(1);
}
