import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../App.tsx';
import { readUnknown } from '../../components/unknown-marker/marker.ts';
import type { PermissionSnapshot } from '../../providers/access-control/index.ts';
import { createDataProvider } from '../../providers/data/index.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import { AUTO_KEY, CONFIG_BATCH_URL, CONFIG_ITEMS_URL } from './auto-payout.ts';
import { MARKER_PAGE } from './ManualPaid.tsx';
import { STEP_UP_URL } from './model.ts';
import { WithdrawalsPage } from './WithdrawalsPage.tsx';

// F1-08ap (D10-2470): the result-unknown marker of 「自动到账设置」 is written the same way for every
// account — no branch on the role, a permission point or isSuper. The page is reached through the
// real shell (menu withdrawals); the login guard's identity (GET /admin/v1/me/permissions as the
// guard keeps it) is the only thing the marker reads of the account, so it is stubbed here.

vi.setConfig({ testTimeout: 60_000 });

let identity: unknown = null;
const getIdentity = () => Promise.resolve(identity);
vi.mock('@refinedev/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@refinedev/core')>()),
  useActiveAuthProvider: () => ({ getIdentity }),
}));

const t = withdrawalsTexts.autoPayout;
/** Far from the real time: a moment read from Date.now() would not match. */
const AT = Date.parse('2001-02-03T04:05:06.000Z');
const clock = { now: () => AT };

interface Account {
  readonly adminId: string;
  readonly snapshot: PermissionSnapshot;
}
const SUPER: Account = {
  adminId: 'admin-super',
  snapshot: { isSuper: true, permissions: [] },
};
const BUSINESS: Account = {
  adminId: 'admin-business',
  snapshot: { isSuper: false, permissions: ['withdraw.review', 'fund.view', 'config.business'] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: 't' });
}

const MAX_AMOUNT = {
  key: AUTO_KEY.maxAmount,
  value: 50_000,
  value_type: 'number',
  options: null,
  admin_editable: true,
  version: 3,
} as const;

/** A save of 「自动到账设置」 by `account` whose batch POST gets no answer (the connection drops). */
async function saveDropped(account: Account): Promise<{ method: string; path: string }[]> {
  identity = {
    admin_id: account.adminId,
    username: account.adminId,
    is_super: account.snapshot.isSuper,
    permissions: account.snapshot.permissions,
  };
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
  const calls: { method: string; path: string }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname });
    if (method === 'GET' && url.pathname === CONFIG_ITEMS_URL)
      return Promise.resolve(ok({ items: [MAX_AMOUNT], page: 1, page_size: 200, total: 1 }));
    if (method === 'GET')
      return Promise.resolve(ok({ items: [], page: 1, page_size: 200, total: 0 }));
    if (method === 'POST' && url.pathname === STEP_UP_URL)
      return Promise.resolve(
        ok({ step_up_token: 'token-1', tier: 'totp', expire_at: '2099-01-01T00:00:00Z' }),
      );
    return Promise.reject(new TypeError('connection reset'));
  };
  const dataProvider = createDataProvider({
    baseUrl: 'https://admin.example.test',
    fetch,
    getToken: () => 'admin-token',
    onError: () => {},
  });
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        permissionsProvider: async () => account.snapshot,
        account: { username: account.adminId, displayName: account.adminId },
        environment: 'test',
        onLogout: () => {},
        initialRoute: { menuId: 'withdrawals' },
        dataProvider,
        renderPage: (_menu, access) => createElement(WithdrawalsPage, { access, clock }),
      }),
    );
  });

  const tab = await screen.findByRole('tab', { name: withdrawalsTexts.pageTabs.auto });
  await act(async () => {
    fireEvent.click(tab);
  });
  const amount = await screen.findByLabelText(t.labels.maxAmount, { exact: true });
  await waitFor(() => expect((amount as HTMLInputElement).value).toBe('500.00'));
  const panel = amount.closest<HTMLElement>('[role="tabpanel"]');
  expect(panel, 'the tab panel of 「自动到账设置」').not.toBeNull();
  await act(async () => {
    fireEvent.change(amount, { target: { value: '300' } });
  });
  await act(async () => {
    fireEvent.click(within(panel!).getByRole('button', { name: t.save }));
  });

  const verification = await screen.findByRole('dialog', { name: stepUpTexts.totp.title });
  await act(async () => {
    fireEvent.change(within(verification).getByLabelText(stepUpTexts.totp.label, { exact: true }), {
      target: { value: '123456' },
    });
  });
  await act(async () => {
    fireEvent.click(within(verification).getByRole('button', { name: stepUpTexts.submit }));
  });

  await waitFor(() => expect(within(panel!).getAllByText(t.unknownTitle).length).toBe(1));
  expect(
    calls.filter((call) => call.method === 'POST' && call.path === CONFIG_BATCH_URL),
  ).toHaveLength(1);
  return calls;
}

/** The stored marker items (key → parsed value) of this tab's sessionStorage. */
function storedMarkers(): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (key === null || !key.startsWith('couli.admin.unknown-marker')) continue;
    found.set(key, JSON.parse(window.sessionStorage.getItem(key) ?? 'null'));
  }
  return found;
}

it('[F1-08ap-UNIT-MARKER#1] a dropped save writes the same result-unknown marker for a super account and a config.business account', async () => {
  const expected = { page: 'withdrawals', unknown: true, at: '2001-02-03T04:05:06.000Z' };
  expect(MARKER_PAGE).toBe('withdrawals');

  // The super account (isSuper: true, no listed permission point).
  await saveDropped(SUPER);
  await waitFor(() =>
    expect(readUnknown({ page: MARKER_PAGE, account: SUPER.adminId })).toEqual(expected),
  );
  const afterSuper = storedMarkers();
  expect([...afterSuper.values()]).toEqual([expected]);
  cleanup();
  vi.unstubAllGlobals();

  // An ordinary account holding config.business: the same path, the same marker.
  await saveDropped(BUSINESS);
  await waitFor(() =>
    expect(readUnknown({ page: MARKER_PAGE, account: BUSINESS.adminId })).toEqual(expected),
  );
  const markers = storedMarkers();
  expect(markers.size, 'one marker per account').toBe(2);
  const keyOf = (account: Account) => `couli.admin.unknown-marker:withdrawals:${account.adminId}`;
  const superMarker = markers.get(keyOf(SUPER));
  const businessMarker = markers.get(keyOf(BUSINESS));
  // The super account's marker is kept as it was, and both have exactly the same shape and value.
  expect(readUnknown({ page: MARKER_PAGE, account: SUPER.adminId })).toEqual(expected);
  expect(superMarker).toEqual(expected);
  expect(businessMarker).toEqual(expected);
  expect(superMarker).toEqual(businessMarker);
  expect(Object.keys(businessMarker as object).sort()).toEqual(['at', 'page', 'unknown']);
});
