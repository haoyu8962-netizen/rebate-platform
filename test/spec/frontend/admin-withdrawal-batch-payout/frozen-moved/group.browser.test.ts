import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../../admin-auth/fixtures.ts';
import {
  ALL_GRANTS,
  BASE_URL,
  NO,
  createServer,
  disallowedRequests,
  snapshot,
} from '../../admin-withdrawals/fixtures.ts';

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

async function show(server = createServer(undefined, { permissions: ALL_GRANTS })) {
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/withdrawals');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => snapshot(server.permissions),
      account: { username: 'fin-yi', displayName: '财务' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: server.fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return server;
}

function usable(name: RegExp): HTMLElement[] {
  const main = page.getByRole('main');
  return [
    ...main.getByRole('button', { name }).elements(),
    ...main.getByRole('link', { name }).elements(),
  ].filter(
    (node) =>
      !(node as HTMLButtonElement).disabled && node.getAttribute('aria-disabled') !== 'true',
  ) as HTMLElement[];
}

it('[AC-F1-08an-BROWSER#1] /withdrawals 审核列表（Chromium）：持 payout.execute 时【一键组批】恰 1 个且可用（不点）；不持 payout.execute（其余权限点照持）时没有【一键组批】；全程只发允许的 GET', async () => {
  await page.viewport(1440, 1080);
  const GROUP = /^一键组批$/;
  for (const { permissions, want } of [
    { permissions: ALL_GRANTS, want: 1 },
    { permissions: ALL_GRANTS.filter((point) => point !== 'payout.execute'), want: 0 },
  ]) {
    const server = await show(createServer(undefined, { permissions }));
    const area = page.getByRole('main');
    const tab = area.getByRole('tab', { name: /^审核列表/ });
    const row = area.getByRole('row').filter({ hasText: NO.pending });
    await expect
      .poll(() => tab.elements().length + row.elements().length, FIRST)
      .toBeGreaterThan(0);
    if (tab.elements().length > 0) await tab.first().click();
    await expect.element(row, FIRST).toBeVisible();
    await expect.poll(() => usable(GROUP).length, FIRST).toBe(want);
    expect(
      [
        ...area.getByRole('button', { name: GROUP }).elements(),
        ...area.getByRole('link', { name: GROUP }).elements(),
      ],
      'shown 一键组批 entries (hidden, not greyed out, without payout.execute)',
    ).toHaveLength(want);
    expect(server.writes(), 'only GET requests').toEqual([]);
    expect(disallowedRequests(server.log), 'only the allowed GET reads').toEqual([]);
    root?.unmount();
    root = undefined;
    auth?.dispose();
    auth = undefined;
    document.body.replaceChildren();
  }
});
