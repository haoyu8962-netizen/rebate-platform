import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, LIST, type Server } from '../../admin-withdrawals/fixtures.ts';
import {
  APPROVE,
  REVIEW,
  VERIFY,
  buttons,
  disabled,
  main,
  rowsOf,
  settled,
} from '../../admin-withdrawal-batch-approve/helpers.ts';

const mounted: { server: Server; direct: ReturnType<typeof vi.fn<typeof globalThis.fetch>> }[] = [];

afterEach(() => {
  const current = mounted.splice(0);
  try {
    for (const { server, direct } of current) {
      expect(direct).not.toHaveBeenCalled();
      expect(
        server.log.filter(
          (request) =>
            !(
              (request.method === 'GET' &&
                [LIST, '/admin/v1/dict', '/admin/v1/me/permissions'].includes(request.path)) ||
              (request.method === 'POST' && [VERIFY, APPROVE].includes(request.path))
            ),
        ),
        'only list/common reads, dynamic-code verification and batch approval are permitted',
      ).toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

export async function mountLanded(
  server: Server,
  permissions: PermissionSnapshot = REVIEW,
): Promise<void> {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
  const direct = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', direct);
  mounted.push({ server, direct });
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'withdrawals' },
        permissionsProvider: async () => permissions,
        account: { username: 'reviewer', displayName: '审核员' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          ['getToken']: () => 'example-admin-token',
          onError: vi.fn(),
        }),
      }),
    );
  });
  await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
  await waitFor(() => expect(rowsOf(main(), server.state[0]!.out_biz_no)).toHaveLength(1));
  await settled(server);
  assertNoOtherActionsLanded(landedFor(permissions));
}

export function assertNoOtherActionsLanded(landed?: readonly string[]): void {
  for (const name of ['批量手动打款', '批量自动打款', '一键组批', '导出', '保存', '恢复默认值'])
    if (landed?.includes(name) !== true)
      expect(buttons(main(), name), `out-of-scope action: ${name}`).toEqual([]);
  if (landed !== undefined)
    expect(
      landed.map((name) => buttons(main(), name).filter((node) => !disabled(node)).length),
      `landed actions present and usable, exactly once each: ${landed.join(', ')}`,
    ).toEqual(landed.map(() => 1));
}

/** The landed page-level entries for `permissions` (F1-08an: 【一键组批】 with payout.execute). */
export function landedFor(permissions: PermissionSnapshot): readonly string[] | undefined {
  return permissions.isSuper || permissions.permissions.includes('payout.execute')
    ? ['一键组批']
    : undefined;
}
