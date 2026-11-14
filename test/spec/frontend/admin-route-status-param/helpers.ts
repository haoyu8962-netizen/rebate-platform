import { act, cleanup, render, within } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';

// F1-14c (FU-ADMIN-ROUTE-STATUS-PARAM): a workbench card opens its page at an address with a query
// string (/withdrawals?status=PENDING_REVIEW, /recon?status=open). The real shell is mounted with
// the browser router at that address (as admin-claims does for /claims?status=…), over the fake
// server of the page's frozen tests; no page module is imported.

/** Per-test timeout of a flow with one mount (antd's first render of a file is slow in jsdom). */
export const FLOW_TIMEOUT = 60_000;
/** Per-test timeout of a flow that mounts the page several times. */
export const MULTI_TIMEOUT = 180_000;

const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

/** The fake server of a page's frozen tests (only its fetch is used here). */
export interface Backend {
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Mounts the real admin shell at `address` (path and query string, as a workbench card opens it)
 * over `backend`, for an account with `permissions`.
 */
export async function mountAt(
  address: string,
  backend: Backend,
  permissions: PermissionSnapshot,
  baseUrl: string,
): Promise<void> {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const session = harness().create();
  sessions.push(session);
  await signIn(session);
  window.history.replaceState(null, '', address);
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: session,
        permissionsProvider: async () => permissions,
        account: { username: 'fin-yi', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl,
          fetch: backend.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
      }),
    );
  });
}

/** Unmounts the page (the next mountAt starts afresh at its own address). */
export function unmountPage(): void {
  cleanup();
}

function mainArea(): HTMLElement {
  const found = document.querySelector<HTMLElement>('main');
  expect(found, 'the shell renders its main landmark').not.toBeNull();
  return found!;
}

/**
 * What the antd Select labelled `label` shows as its value (its selection items, spaces removed);
 * '' when it shows none (only its placeholder).
 */
export function shownValue(label: RegExp): string {
  const combos = within(mainArea()).queryAllByRole('combobox', { name: label });
  expect(combos, `one select labelled ${String(label)}`).toHaveLength(1);
  const select = combos[0]!.closest('.ant-select');
  expect(select, `the antd Select of ${String(label)}`).not.toBeNull();
  const items = Array.from(select!.querySelectorAll('.ant-select-selection-item'));
  return items.map((node) => (node.textContent ?? '').replace(/\s+/g, '')).join(' | ');
}

/** The page_size of the first list read (a positive integer up to 200, as the contract takes). */
export function pageSizeOf(
  reads: readonly { readonly query: Readonly<Record<string, string>> }[],
): string {
  const size = reads[0]?.query['page_size'];
  expect(typeof size, 'the first list read sends page_size').toBe('string');
  expect(size, 'page_size is a positive integer').toMatch(/^[1-9][0-9]*$/);
  expect(Number(size), 'page_size up to 200').toBeLessThanOrEqual(200);
  return size!;
}
