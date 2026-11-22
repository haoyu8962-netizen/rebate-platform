import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../App.tsx';
import { clearUnknown, markUnknown, readUnknown } from '../../components/unknown-marker/marker.ts';
import type { PermissionSnapshot } from '../../providers/access-control/index.ts';
import { AdminApiError, createDataProvider } from '../../providers/data/index.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import { AUTO_KEY, CONFIG_BATCH_URL, CONFIG_ITEMS_URL, isValidStored } from './auto-payout.ts';
import {
  READ_DEADLINE_MS,
  SAVE_DEADLINE_MS,
  SaveDeadline,
  answeredItems,
  outcomeOf,
  versionMoved,
  withDeadline,
  type BatchRequest,
} from './AutoPayoutSettings.tsx';
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

/** ② as adminListConfigItems answers it (every member of AdminConfigItem). */
const MAX_AMOUNT = {
  key: AUTO_KEY.maxAmount,
  value: 50_000,
  value_type: 'number',
  options: null,
  permission: 'config.business',
  admin_editable: true,
  version: 3,
  updated_by: 'ops-yi',
  updated_at: '2001-02-01T10:00:00+08:00',
} as const;

/** A save of 「自动到账设置」 by `account` whose batch POST gets no answer (the connection drops). */
type Call = { readonly method: string; readonly path: string };
/** An answer of the fake server for a request, or undefined for the default answer. */
type Route = (method: string, path: string) => Promise<Response> | undefined;

/** A promise settled by hand (an answer that arrives when the test says so). */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function failed(code: number, httpStatus: number, data: unknown = null): Response {
  return Response.json({ code, msg: '', data, trace_id: 't' }, { status: httpStatus });
}

const batchCalls = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === 'POST' && call.path === CONFIG_BATCH_URL);

/**
 * Opens 「自动到账设置」 as `account` through the real shell. `route` answers a request first;
 * otherwise: the config items are MAX_AMOUNT, other reads empty pages, the step-up passes, and a
 * batch POST loses its connection.
 */
async function openTab(
  account: Account,
  route: Route = () => undefined,
): Promise<{ readonly panel: HTMLElement; readonly calls: Call[] }> {
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
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname });
    const routed = route(method, url.pathname);
    if (routed !== undefined) return routed;
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
  return { panel: panel!, calls };
}

/** The amount input of the tab. */
const amountOf = (panel: HTMLElement) =>
  within(panel).getByLabelText(t.labels.maxAmount, { exact: true }) as HTMLInputElement;

/** Enters a dynamic code in the open step-up dialog and submits it. */
async function enterCode(): Promise<void> {
  const dialogs = await screen.findAllByRole('dialog', { name: stepUpTexts.totp.title });
  const verification = dialogs[dialogs.length - 1]!;
  await act(async () => {
    fireEvent.change(within(verification).getByLabelText(stepUpTexts.totp.label, { exact: true }), {
      target: { value: '123456' },
    });
  });
  await act(async () => {
    fireEvent.click(within(verification).getByRole('button', { name: stepUpTexts.submit }));
  });
}

/** Changes ② to 300 yuan, presses 【保存】 and passes the dynamic code. */
async function saveAmount(panel: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.change(amountOf(panel), { target: { value: '300' } });
  });
  await act(async () => {
    fireEvent.click(within(panel).getByRole('button', { name: t.save }));
  });
  await enterCode();
}

/** A save of 「自动到账设置」 by `account` whose batch POST gets no answer (the connection drops). */
async function saveDropped(account: Account): Promise<Call[]> {
  const { panel, calls } = await openTab(account);
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getAllByText(t.unknownTitle).length).toBe(1));
  expect(batchCalls(calls)).toHaveLength(1);
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

// ---- 资金评审 r1（F1-08ap 实现第 4 轮） ------------------------------------------------------------

const EXPECTED_MARKER = { page: 'withdrawals', unknown: true, at: '2001-02-03T04:05:06.000Z' };
const BODY: BatchRequest = {
  items: [{ key: AUTO_KEY.maxAmount, value: 30_000, expected_version: 3 }],
};
const STORED = { ...MAX_AMOUNT, value: 30_000, version: 4 };

function apiError(code: number, httpStatus: number, data: unknown = null): AdminApiError {
  return new AdminApiError({
    kind: 'api',
    code,
    msg: '',
    data,
    httpStatus,
    ...(code === 42901 ? { retryAfterSeconds: 5 } : {}),
  });
}

it('[F1-08ap-UNIT-MONEY#1] a save with no answer by SAVE_DEADLINE_MS is given up as result-unknown: the request is aborted once, never resent', async () => {
  expect(SAVE_DEADLINE_MS).toBeGreaterThan(0);
  expect(Number.isFinite(SAVE_DEADLINE_MS)).toBe(true);
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    let starts = 0;
    const pending = withDeadline((given) => {
      starts += 1;
      signal = given;
      return new Promise<never>(() => {});
    }, SAVE_DEADLINE_MS);
    const result = pending.then(
      () => 'answered',
      (cause: unknown) => cause,
    );
    await vi.advanceTimersByTimeAsync(SAVE_DEADLINE_MS - 1);
    expect(signal?.aborted, 'still waiting just before the deadline').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const cause = await result;
    expect(cause).toBeInstanceOf(SaveDeadline);
    expect(signal?.aborted, 'the request is aborted').toBe(true);
    expect(starts, 'sent once, not again').toBe(1);
    expect(outcomeOf({ ok: false, cause }, BODY, false)).toEqual({
      kind: 'unknown',
      note: t.timedOut(SAVE_DEADLINE_MS / 1000),
    });
    expect(outcomeOf({ ok: false, cause }, BODY, true).kind).toBe('unknown');
    // An answer within the deadline passes through unchanged.
    await expect(withDeadline(() => Promise.resolve('ok'), SAVE_DEADLINE_MS)).resolves.toBe('ok');
  } finally {
    vi.useRealTimers();
  }
});

it('[F1-08ap-UNIT-MONEY#2] the marker is kept before the batch is answered and follows the answer after the page is left', async () => {
  // The super account leaves the page while its save is under way; the connection then drops.
  const first = deferred<Response>();
  const one = await openTab(SUPER, (method, path) =>
    method === 'POST' && path === CONFIG_BATCH_URL ? first.promise : undefined,
  );
  await saveAmount(one.panel);
  await waitFor(() => expect(batchCalls(one.calls)).toHaveLength(1));
  const superScope = { page: MARKER_PAGE, account: SUPER.adminId };
  await waitFor(() =>
    expect(readUnknown(superScope), 'kept before any answer').toEqual(EXPECTED_MARKER),
  );
  cleanup();
  vi.unstubAllGlobals();
  expect(readUnknown(superScope), 'kept when the page is left').toEqual(EXPECTED_MARKER);
  first.reject(new TypeError('connection reset'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(readUnknown(superScope), 'still kept: nothing settled').toEqual(EXPECTED_MARKER);

  // A config.business account leaves too; the stored answer arrives afterwards: the marker goes.
  const second = deferred<Response>();
  const two = await openTab(BUSINESS, (method, path) =>
    method === 'POST' && path === CONFIG_BATCH_URL ? second.promise : undefined,
  );
  await saveAmount(two.panel);
  await waitFor(() => expect(batchCalls(two.calls)).toHaveLength(1));
  const businessScope = { page: MARKER_PAGE, account: BUSINESS.adminId };
  await waitFor(() => expect(readUnknown(businessScope)).toEqual(EXPECTED_MARKER));
  cleanup();
  second.resolve(ok({ items: [STORED] }));
  await waitFor(() => expect(readUnknown(businessScope), 'settled: dropped').toBeUndefined());
  expect(readUnknown(superScope), 'the other account keeps its own').toEqual(EXPECTED_MARKER);
  expect(batchCalls(one.calls), 'nothing resent').toHaveLength(1);
  expect(batchCalls(two.calls), 'nothing resent').toHaveLength(1);
});

it('[F1-08ap-UNIT-MONEY#3] a retry answered 42901 (or another refusal) leaves the earlier unknown save unknown, locked, with its marker; a first save answered 42901 is settled', async () => {
  const limited = apiError(42901, 429);
  expect(outcomeOf({ ok: false, cause: limited }, BODY, true)).toEqual({
    kind: 'unknown',
    note: t.retryRateLimited,
  });
  for (const cause of [
    apiError(10403, 403, { reason: 'admin_permission_denied' }),
    apiError(10003, 403, { reason: 'verify_phone_missing' }),
    apiError(20902, 409, { resource: 'config_item' }),
    apiError(40001, 400),
    apiError(50001, 500),
  ])
    expect(outcomeOf({ ok: false, cause }, BODY, true).kind, String(cause.code)).toBe('unknown');
  const invalid = apiError(20001, 400, { fields: [AUTO_KEY.maxAmount] });
  expect(outcomeOf({ ok: false, cause: invalid }, BODY, true)).toEqual({
    kind: 'refused',
    cause: invalid,
  });
  expect(
    outcomeOf({ ok: false, cause: apiError(10003, 403, { tier: 'totp' }) }, BODY, true),
  ).toEqual({ kind: 'again' });
  expect(outcomeOf({ ok: false, cause: limited }, BODY, false)).toEqual({
    kind: 'refused',
    cause: limited,
  });

  // Through the page: dropped, then 【原样重试】 answered 429 / 42901.
  let sends = 0;
  const { panel, calls } = await openTab(SUPER, (method, path) => {
    if (method !== 'POST' || path !== CONFIG_BATCH_URL) return undefined;
    sends += 1;
    if (sends === 1) return Promise.reject(new TypeError('connection reset'));
    return Promise.resolve(
      Response.json(
        { code: 42901, msg: '请求过于频繁', data: null, trace_id: 't' },
        { status: 429, headers: { 'Retry-After': '5' } },
      ),
    );
  });
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getAllByText(t.unknownTitle).length).toBe(1));
  await act(async () => {
    fireEvent.click(within(panel).getByRole('button', { name: t.unknownRetry }));
  });
  await enterCode();
  await waitFor(() => expect(batchCalls(calls)).toHaveLength(2));
  await waitFor(() => expect(within(panel).getByText(t.retryRateLimited)).toBeTruthy());
  expect(within(panel).getAllByText(t.unknownTitle)).toHaveLength(1);
  expect(amountOf(panel).disabled, 'still locked').toBe(true);
  expect(amountOf(panel).value, 'not unlocked with the value before the save').not.toBe('500.00');
  expect(
    (within(panel).getByRole('button', { name: t.unknownRetry }) as HTMLButtonElement).disabled,
    'Retry-After: 【原样重试】 waits',
  ).toBe(true);
  expect(
    (within(panel).getByRole('button', { name: t.unknownRecheck }) as HTMLButtonElement).disabled,
    '【刷新核对】 stays offered',
  ).toBe(false);
  expect(readUnknown({ page: MARKER_PAGE, account: SUPER.adminId })).toEqual(EXPECTED_MARKER);
  expect(within(panel).queryByText(t.saved)).toBeNull();
});

it('[F1-08ap-UNIT-MONEY#4] 【刷新】 after a 20902 locks the form until the settings are back; the answer then shows the server values', async () => {
  let armed = false;
  const reread = deferred<Response>();
  const { panel, calls } = await openTab(SUPER, (method, path) => {
    if (method === 'POST' && path === CONFIG_BATCH_URL)
      return Promise.resolve(failed(20902, 409, { resource: 'config_item' }));
    if (armed && method === 'GET' && path === CONFIG_ITEMS_URL) return reread.promise;
    return undefined;
  });
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getByText(t.conflict)).toBeTruthy());
  expect(amountOf(panel).disabled, 'editable after the refusal').toBe(false);

  armed = true;
  const reads = calls.filter((call) => call.path === CONFIG_ITEMS_URL).length;
  await act(async () => {
    fireEvent.click(within(panel).getByRole('button', { name: t.refresh }));
  });
  await waitFor(() =>
    expect(calls.filter((call) => call.path === CONFIG_ITEMS_URL).length).toBe(reads + 1),
  );
  expect(amountOf(panel).disabled, 'locked while reading').toBe(true);
  expect(
    (within(panel).getByRole('button', { name: t.save }) as HTMLButtonElement).disabled,
    '【保存】 locked while reading',
  ).toBe(true);
  await act(async () => {
    fireEvent.change(amountOf(panel), { target: { value: '250' } });
  });
  expect(amountOf(panel).value, 'typing is ignored while reading').toBe('300');

  reread.resolve(
    ok({
      items: [{ ...MAX_AMOUNT, value: 26_000, version: 5 }],
      page: 1,
      page_size: 200,
      total: 1,
    }),
  );
  await waitFor(() => expect(amountOf(panel).value).toBe('260.00'));
  await waitFor(() => expect(amountOf(panel).disabled, 'unlocked once read').toBe(false));
  expect(batchCalls(calls), 'nothing resent').toHaveLength(1);
});

it('[F1-08ap-UNIT-MONEY#6] a batch answer that does not give every key sent (e.g. items: []) is result-unknown, not saved', async () => {
  for (const data of [
    { items: [] },
    {},
    null,
    { items: [{ ...STORED, key: AUTO_KEY.platformDaily }] },
    { items: [STORED, STORED] },
    { items: [STORED, { ...MAX_AMOUNT, key: AUTO_KEY.platformDaily }] },
    { items: [{ key: STORED.key, version: 4 }] },
    { items: [{ ...STORED, version: 2 }] },
    { items: [{ ...STORED, version: '4' }] },
  ]) {
    expect(answeredItems(data, BODY), JSON.stringify(data)).toBeUndefined();
    expect(outcomeOf({ ok: true, data }, BODY, false), JSON.stringify(data)).toEqual({
      kind: 'unknown',
      note: t.unreadable,
    });
  }
  expect(outcomeOf({ ok: true, data: { items: [STORED] } }, BODY, false)).toEqual({
    kind: 'saved',
    items: [STORED],
  });

  // Through the page: an HTTP 200, code 0, items [].
  const { panel } = await openTab(SUPER, (method, path) =>
    method === 'POST' && path === CONFIG_BATCH_URL ? Promise.resolve(ok({ items: [] })) : undefined,
  );
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getAllByText(t.unknownTitle).length).toBe(1));
  expect(within(panel).getByText(t.unreadable)).toBeTruthy();
  expect(within(panel).queryByText(t.saved)).toBeNull();
  expect(amountOf(panel).disabled, 'locked').toBe(true);
  expect(readUnknown({ page: MARKER_PAGE, account: SUPER.adminId })).toEqual(EXPECTED_MARKER);
});

// ---- 资金评审 r2（F1-08ap 实现第 5 轮，D10-2493） ---------------------------------------------------

const itemReads = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === 'GET' && call.path === CONFIG_ITEMS_URL).length;
const buttonOf = (panel: HTMLElement, name: string) =>
  within(panel).getByRole('button', { name }) as HTMLButtonElement;
/** The config-items page answering ② as `row`. */
const pageOf = (row: object) => ok({ items: [row], page: 1, page_size: 200, total: 1 });

/** Presses 【放弃这次提交】 and returns its (last opened) confirmation dialog. */
async function openAbandon(panel: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.click(buttonOf(panel, t.abandon));
  });
  const dialogs = await screen.findAllByRole('dialog', { name: t.abandonTitle });
  return dialogs[dialogs.length - 1]!;
}

it('[F1-08ap-UNIT-MONEY#7] 【刷新核对】 still reading the version sent keeps the result unknown (locked, body and marker kept, 稍后再刷新核对); 【放弃这次提交】 unlocks only after its confirmation', async () => {
  // Pure: every key sent still at its expected_version (or missing / unreadable) → not moved.
  expect(versionMoved([MAX_AMOUNT], BODY)).toBe(false);
  expect(versionMoved([], BODY)).toBe(false);
  expect(versionMoved([{ ...MAX_AMOUNT, version: '4' } as never], BODY)).toBe(false);

  // The connection drops; 【刷新核对】 reads ② still at 500 yuan, version 3 (the version sent).
  const { panel, calls } = await openTab(SUPER);
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getAllByText(t.unknownTitle).length).toBe(1));
  const scope = { page: MARKER_PAGE, account: SUPER.adminId };
  await waitFor(() => expect(readUnknown(scope)).toEqual(EXPECTED_MARKER));
  const reads = itemReads(calls);
  await act(async () => {
    fireEvent.click(buttonOf(panel, t.unknownRecheck));
  });
  await waitFor(() => expect(within(panel).getByText(t.recheckPending)).toBeTruthy());
  expect(itemReads(calls), 'one read').toBe(reads + 1);
  expect(within(panel).getAllByText(t.unknownTitle), 'still unknown').toHaveLength(1);
  expect(amountOf(panel).disabled, 'not unlocked').toBe(true);
  expect(buttonOf(panel, t.save).disabled, '【保存】 not offered').toBe(true);
  expect(buttonOf(panel, t.unknownRetry).disabled, '【原样重试】 still offered').toBe(false);
  expect(buttonOf(panel, t.unknownRecheck).disabled, '【刷新核对】 still offered').toBe(false);
  expect(readUnknown(scope), 'the marker is kept').toEqual(EXPECTED_MARKER);

  // 【放弃这次提交】 asks first; 【继续等待】 changes nothing.
  const first = await openAbandon(panel);
  expect(within(first).getByText(t.abandonConfirm)).toBeTruthy();
  expect(amountOf(panel).disabled, 'nothing unlocked before the confirmation').toBe(true);
  expect(readUnknown(scope)).toEqual(EXPECTED_MARKER);
  await act(async () => {
    fireEvent.click(within(first).getByRole('button', { name: t.abandonCancel }));
  });
  expect(amountOf(panel).disabled, 'still locked after 【继续等待】').toBe(true);
  expect(within(panel).getAllByText(t.unknownTitle)).toHaveLength(1);
  expect(readUnknown(scope)).toEqual(EXPECTED_MARKER);

  // Confirmed: unlocked with the values of the 【刷新核对】 read, the marker dropped, nothing sent.
  const second = await openAbandon(panel);
  await act(async () => {
    fireEvent.click(within(second).getByRole('button', { name: t.abandonOk }));
  });
  await waitFor(() => expect(amountOf(panel).disabled, 'unlocked').toBe(false));
  expect(amountOf(panel).value, 'the server value of the read').toBe('500.00');
  expect(within(panel).queryByText(t.unknownTitle)).toBeNull();
  expect(readUnknown(scope), 'the marker is dropped').toBeUndefined();
  expect(batchCalls(calls), 'nothing resent').toHaveLength(1);
});

it('[F1-08ap-UNIT-MONEY#8] 【刷新核对】 reading a moved version of a key sent unlocks with the server value and drops the marker; no 【放弃这次提交】', async () => {
  // Pure: any key sent at another version than expected → moved (stored, or another write won).
  expect(versionMoved([{ ...MAX_AMOUNT, version: 4 }], BODY)).toBe(true);
  const two: BatchRequest = {
    items: [
      { key: AUTO_KEY.maxAmount, value: 30_000, expected_version: 3 },
      { key: AUTO_KEY.userDaily, value: 1, expected_version: 2 },
    ],
  };
  expect(
    versionMoved(
      [MAX_AMOUNT, { ...MAX_AMOUNT, key: AUTO_KEY.userDaily, value: 3, version: 3 }],
      two,
    ),
  ).toBe(true);

  // Through the page: the read after the drop gives ② at 300 yuan, version 4.
  let armed = false;
  const { panel, calls } = await openTab(BUSINESS, (method, path) =>
    armed && method === 'GET' && path === CONFIG_ITEMS_URL
      ? Promise.resolve(pageOf({ ...MAX_AMOUNT, value: 30_000, version: 4 }))
      : undefined,
  );
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getAllByText(t.unknownTitle).length).toBe(1));
  const scope = { page: MARKER_PAGE, account: BUSINESS.adminId };
  await waitFor(() => expect(readUnknown(scope)).toEqual(EXPECTED_MARKER));
  armed = true;
  await act(async () => {
    fireEvent.click(buttonOf(panel, t.unknownRecheck));
  });
  await waitFor(() => expect(amountOf(panel).disabled, 'unlocked').toBe(false));
  expect(amountOf(panel).value).toBe('300.00');
  expect(within(panel).queryByText(t.unknownTitle)).toBeNull();
  expect(within(panel).queryByText(t.recheckPending)).toBeNull();
  expect(within(panel).queryByRole('button', { name: t.abandon })).toBeNull();
  expect(readUnknown(scope), 'the marker is dropped').toBeUndefined();
  expect(batchCalls(calls), 'nothing resent').toHaveLength(1);
});

it('[F1-08ap-UNIT-MONEY#9] 【关闭】 on the prompt of an earlier submission while a new save is under way or unknown does not lose the new marker (super and config.business alike)', async () => {
  const EARLIER = Date.parse('2001-02-03T03:00:00.000Z');
  for (const account of [SUPER, BUSINESS]) {
    const scope = { page: MARKER_PAGE, account: account.adminId };
    clearUnknown(scope);
    // Left by an earlier submission before signing in again.
    markUnknown(scope, { now: () => EARLIER });
    const pending = deferred<Response>();
    const { panel, calls } = await openTab(account, (method, path) =>
      method === 'POST' && path === CONFIG_BATCH_URL ? pending.promise : undefined,
    );
    // The prompt of the earlier submission on top of 提现审核, with its 【关闭】.
    const prompt = (
      await screen.findByText(withdrawalsTexts.unknownMarker.notice)
    ).closest<HTMLElement>('[role="alert"]');
    expect(prompt, 'the prompt of the earlier submission').not.toBeNull();
    const close = within(prompt!).getByRole('button', {
      name: withdrawalsTexts.unknownMarker.close,
    });
    await saveAmount(panel);
    await waitFor(() => expect(batchCalls(calls)).toHaveLength(1));
    expect(readUnknown(scope)?.at, 'the earlier moment is kept').toBe(
      new Date(EARLIER).toISOString(),
    );

    // 【关闭】 while the save is under way: the new submission's marker is written again.
    await act(async () => {
      fireEvent.click(close);
    });
    await waitFor(() => expect(readUnknown(scope), account.adminId).toEqual(EXPECTED_MARKER));

    // The connection then drops: result unknown, the marker there.
    await act(async () => {
      pending.reject(new TypeError('connection reset'));
    });
    await waitFor(() => expect(within(panel).getAllByText(t.unknownTitle).length).toBe(1));
    expect(readUnknown(scope), account.adminId).toEqual(EXPECTED_MARKER);

    // Dropped again while unknown (e.g. a prompt's 【关闭】 elsewhere): written again.
    await act(async () => {
      clearUnknown(scope);
    });
    expect(readUnknown(scope), account.adminId).toEqual(EXPECTED_MARKER);
    expect(Object.keys(readUnknown(scope) ?? {}).sort()).toEqual(['at', 'page', 'unknown']);
    expect(batchCalls(calls), 'nothing resent').toHaveLength(1);
    cleanup();
    vi.unstubAllGlobals();
  }
});

it('[F1-08ap-UNIT-MONEY#10] 【刷新】 after a 20902 whose read never completes gives up after READ_DEADLINE_MS: read-failed notice, form editable, 【刷新】 offered and reading again', async () => {
  expect(READ_DEADLINE_MS).toBeGreaterThan(0);
  expect(Number.isFinite(READ_DEADLINE_MS)).toBe(true);
  let armed = false;
  let rereads = 0;
  const { panel, calls } = await openTab(SUPER, (method, path) => {
    if (method === 'POST' && path === CONFIG_BATCH_URL)
      return Promise.resolve(failed(20902, 409, { resource: 'config_item' }));
    if (armed && method === 'GET' && path === CONFIG_ITEMS_URL) {
      rereads += 1;
      // The first read: the gateway keeps the connection open and never answers.
      if (rereads === 1) return new Promise<Response>(() => {});
      return Promise.resolve(pageOf({ ...MAX_AMOUNT, value: 26_000, version: 5 }));
    }
    return undefined;
  });
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getByText(t.conflict)).toBeTruthy());
  armed = true;
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await act(async () => {
      fireEvent.click(buttonOf(panel, t.refresh));
    });
    expect(amountOf(panel).disabled, 'locked while reading').toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    });
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(within(panel).getByText(t.refreshFailed)).toBeTruthy());
  expect(rereads, 'one read under way when given up').toBe(1);
  expect(amountOf(panel).disabled, 'editable again').toBe(false);
  // antd's Button copies `loading` into its own state in an effect, so its spinner (and the
  // accessible name 「loading刷新」) can outlast the commit that ended the read by one flush.
  const again = await waitFor(() => {
    const button = buttonOf(panel, t.refresh);
    expect(button.disabled, '【刷新】 offered again').toBe(false);
    return button;
  });
  await act(async () => {
    fireEvent.click(again);
  });
  await waitFor(() => expect(amountOf(panel).value).toBe('260.00'));
  expect(rereads).toBe(2);
  expect(amountOf(panel).disabled).toBe(false);
  expect(batchCalls(calls), 'nothing resent').toHaveLength(1);
});

it('[F1-08ap-UNIT-MONEY#11] a batch answer item missing a member the form relies on (admin_editable …) or with an invalid value is result-unknown, the body kept', async () => {
  expect(answeredItems({ items: [STORED] }, BODY)).toEqual([STORED]);
  const without = (name: string) =>
    Object.fromEntries(Object.entries(STORED).filter(([key]) => key !== name));
  for (const name of [
    'key',
    'value',
    'value_type',
    'options',
    'permission',
    'admin_editable',
    'version',
  ])
    expect(answeredItems({ items: [without(name)] }, BODY), `without ${name}`).toBeUndefined();
  for (const patch of [
    { value: null },
    { value: -1 },
    { value: 1_000_001 },
    { value: 300.5 },
    { value: '30000' },
    { value_type: 'decimal' },
    { options: 'none' },
    { options: [1] },
    { permission: '' },
    { admin_editable: 'true' },
    { version: 3 },
    { version: 4.5 },
  ])
    expect(answeredItems({ items: [{ ...STORED, ...patch }] }, BODY), JSON.stringify(patch)).toBe(
      undefined,
    );
  // The stored values the save checks allow, per kind.
  expect(isValidStored(AUTO_KEY.windowStart, '10:00:00', null)).toBe(true);
  expect(isValidStored(AUTO_KEY.windowStart, '10:30:00', null)).toBe(false);
  expect(isValidStored(AUTO_KEY.riskFlags, ['blacklist_hit', 'had_negative'], null)).toBe(true);
  expect(isValidStored(AUTO_KEY.riskFlags, ['not_a_flag'], null)).toBe(false);
  expect(isValidStored(AUTO_KEY.userDaily, 0, null)).toBe(true);
  expect(isValidStored(AUTO_KEY.warnRate, 10_001, null)).toBe(false);
  expect(isValidStored(AUTO_KEY.windowLimit, 'on', null)).toBe(false);

  // Through the page: HTTP 200, code 0, the one item without admin_editable.
  const { panel, calls } = await openTab(SUPER, (method, path) =>
    method === 'POST' && path === CONFIG_BATCH_URL
      ? Promise.resolve(ok({ items: [without('admin_editable')] }))
      : undefined,
  );
  await saveAmount(panel);
  await waitFor(() => expect(within(panel).getAllByText(t.unknownTitle).length).toBe(1));
  expect(within(panel).getByText(t.unreadable)).toBeTruthy();
  expect(within(panel).queryByText(t.saved)).toBeNull();
  expect(amountOf(panel).disabled, 'locked').toBe(true);
  expect(amountOf(panel).value, 'the body kept, not the answer').toBe('300');
  expect(buttonOf(panel, t.unknownRetry).disabled, '【原样重试】 offered').toBe(false);
  expect(readUnknown({ page: MARKER_PAGE, account: SUPER.adminId })).toEqual(EXPECTED_MARKER);
  expect(batchCalls(calls)).toHaveLength(1);
});
