// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import {
  getAdminMenuGroups,
  selectAdminMenuGroups,
} from '../../../../apps/admin/src/resources/index.ts';
import { ME, harness } from '../admin-auth/fixtures.ts';
import {
  click as loginClick,
  code,
  credentials,
  installMediaQuery,
  mountShell,
} from '../admin-auth-qr/helpers.ts';
import { ENDPOINT, createServer, failure } from './dashboard-fixtures.ts';
import { FLOW_TIMEOUT, loaded, mainElement, mount, settled } from './dashboard-helpers.ts';

const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const auth of sessions.splice(0)) auth.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-14a-MENU#1] 目录工作台置顶且只由 dashboard.view 或超管授予，侧栏同序', async () => {
  const full = getAdminMenuGroups().flatMap(({ items }) => items);
  expect(full[0]).toMatchObject({
    id: 'dashboard',
    label: '工作台',
    access: { kind: 'any', permissions: ['dashboard.view'] },
  });
  for (const permissions of [
    [],
    ['fund.view'],
    ['dashboard'],
    ['dashboard.*'],
    ['dashboard.view.extra'],
  ]) {
    expect(
      selectAdminMenuGroups({ isSuper: false, permissions })
        .flatMap(({ items }) => items)
        .some(({ id }) => String(id) === 'dashboard'),
    ).toBe(false);
  }
  expect(
    selectAdminMenuGroups({ isSuper: false, permissions: ['dashboard.view'] }).flatMap(
      ({ items }) => items,
    )[0]?.id,
  ).toBe('dashboard');
  await mount();
  await loaded();
  const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
  expect(sidebar.getAllByRole('link')[0]?.textContent).toContain('工作台');
  expect(sidebar.getAllByRole('link')[0]?.getAttribute('aria-current')).toBe('page');
});

it(
  '[AC-F1-14a-MENU#2] 实际完成登录：有工作台权限优先；无则按侧栏顺序；零权限仍暂无权限',
  async () => {
    installMediaQuery();
    // One journey matrix keeps the unchanged zero-permission regression in the new landing test.
    for (const [isSuper, permissions, destination] of [
      [false, ['dashboard.view', 'order.view'], 'dashboard'],
      [true, [], 'dashboard'],
      [false, ['order.view', 'withdraw.review'], 'orders'],
      [false, ['fund.view'], 'ledger'],
      [false, [], null],
    ] as const) {
      const me = {
        ...ME,
        is_super: isSuper,
        permissions: permissions.map((key) => ({
          key,
          step_up_tier: null,
          step_up_operations: [],
        })),
      };
      const h = mountShell(sessions, harness('totp', me));
      await credentials();
      await code();
      await loginClick('登录');
      if (destination === null) {
        await waitFor(() => expect(screen.queryByText('还没有分配权限')).not.toBeNull());
        expect(window.location.pathname).toBe('/');
        expect(screen.queryByText(/^page:/)).toBeNull();
      } else {
        await waitFor(() => expect(screen.queryByText(`page:${destination}`)).not.toBeNull());
        expect(window.location.pathname).toBe(`/${destination}`);
        expect(
          within(screen.getByRole('navigation', { name: '主导航' }))
            .getAllByRole('link')[0]
            ?.getAttribute('href'),
        ).toBe(`/${destination}`);
      }
      h.view.unmount();
      h.auth.dispose();
    }
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-14a-MENU#3] 直接打开工作台但没有权限：落第一个获准业务菜单且不请求 dashboard', async () => {
  const server = createServer();
  await mount(server, {
    permissionsProvider: async () => ({
      isSuper: false,
      permissions: ['config.business', 'content.agreement'],
    }),
  });
  await waitFor(() => expect(window.location.pathname).toBe('/content'));
  expect(mainElement().textContent).toContain('尚未接入');
  expect(
    within(screen.getByRole('navigation', { name: '主导航' })).queryByRole('link', {
      name: '工作台',
    }),
  ).toBeNull();
  expect(server.log).toEqual([]);
});

it('[AC-F1-14a-MENU#4] 服务端 10403 权限已撤回，跳过工作台落首个获准菜单，不重试循环', async () => {
  const server = createServer();
  server.once(() => failure(10403, { reason: 'admin_permission_denied' }));
  await mount(server, {
    permissionsProvider: async () => ({
      isSuper: false,
      permissions: ['dashboard.view', 'content.agreement', 'config.business'],
    }),
  });
  await waitFor(() => expect(window.location.pathname).toBe('/content'));
  expect(mainElement().textContent).toContain('尚未接入');
  await settled(server);
  expect(server.log.map(({ path }) => path)).toEqual([ENDPOINT]);
  expect(within(mainElement()).queryByRole('button', { name: '重试' })).toBeNull();
});
