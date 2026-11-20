// F1-08at（FU-ADMIN-UNKNOWN-ON-RELOGIN，编排 D10-2075 / D10-2061）：结果未知期间会话过期、重新登录后在原页面顶部提示
// 「有一笔提交结果未知，请先到列表核对」。What the tests of this directory decide (the implementation is free
// in everything else):
// - The real shell (createAdminShell, memory router) runs with the real login guard
//   (createAdminApi: providers/auth + providers/data), so a 10001 to a write ends the session and the
//   login page replaces the shell, exactly as in the browser entry; the guard keeps its session in an
//   injected memory storage, so window.sessionStorage / window.localStorage hold only what the pages
//   write. The signed-in account is the answer of GET /admin/v1/me/permissions (AdminMe admin_id /
//   username; refine's getIdentity), never the shell's static `account` option.
// - Time: only `Date` is faked (vi.useFakeTimers toFake ['Date']), so a page clock that defaults to
//   Date.now and an injected clock read the same instant. The result becomes unknown at AT; the clock
//   is moved to LATER before the session expires and the account signs in again.
// - Stored marker: entering the result-unknown state keeps exactly one item, in sessionStorage or
//   localStorage (key free; an account id in the key is allowed), whose whole value is the JSON
//   {"page": <menu id: withdrawals | adjustments>, "unknown": true, "at": <ISO 8601 of AT as
//   Date#toISOString gives it>} — no number, amount, user, Idempotency-Key or request body.
// - Prompt: on the page (inside <main>), above its tabs and tables, one element whose text holds the
//   whole NOTICE and the moment AT in Beijing time (YYYY-MM-DD HH:mm:ss), with exactly one control: a
//   real button named 「关闭」 (text or aria-label). No element of it handles clicks or keys without
//   an interactive role (D10-2050). Pressing 「关闭」 removes it and the stored item.
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createAdminApi, type AdminApi } from '../../../../apps/admin/src/providers/admin-api.ts';
import type {
  AdminIdentity,
  AdminLoginStepData,
  AdminSession,
  AuthStorage,
} from '../../../../apps/admin/src/providers/auth/index.ts';
import { AdminApiError } from '../../../../apps/admin/src/providers/data/index.ts';
import { TITLES } from '../admin-auth/fixtures.ts';
import { controlsOf } from '../admin-withdrawal-manual-paid-controls/controls.ts';

configure({ asyncUtilTimeout: 10_000 });

// ---- fixed values of this task -------------------------------------------------------------

/** The prompt shown on the page after signing in again (D10-2075). */
export const NOTICE = '有一笔提交结果未知，请先到列表核对';
/** The prompt's only control. */
export const CLOSE = '关闭';
/** The moment the result becomes unknown (the clock stands still until then). */
export const AT = '2026-11-18T04:00:00.000Z';
/** AT in Beijing time, as the prompt shows it. */
export const AT_SHOWN = '2026-11-18 12:00:00';
/** The clock when the session expires and the account signs in again. */
export const LATER = '2026-11-18T04:07:00.000Z';
export const LATER_SHOWN = '2026-11-18 12:07:00';

const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const TOKEN = 'example-admin-token';
const PASSWORD = 'example-password';
const OTP = '123456';
/** Valid through the whole test (LATER plus a few hours). */
const SESSION: AdminSession = {
  ['admin_token']: TOKEN,
  expires_at: '2026-11-18T20:00:00+08:00',
  idle_timeout_sec: 1800,
};
const TICKET_EXPIRES = '2026-11-18T13:00:00+08:00';

const LOGIN = '/admin/v1/auth/login';
const TOTP = '/admin/v1/auth/totp';
const LOGOUT = '/admin/v1/auth/logout';
const ME = '/admin/v1/me/permissions';
/** The guard's own calls (the step-up pair under /admin/v1/auth/step-up stays with the page). */
const GUARD_PATHS: ReadonlySet<string> = new Set([
  LOGIN,
  TOTP,
  LOGOUT,
  ME,
  '/admin/v1/auth/password',
  '/admin/v1/auth/totp/secret',
  '/admin/v1/auth/totp/bind',
]);

// ---- accounts ------------------------------------------------------------------------------

export interface Account {
  readonly username: string;
  readonly me: AdminIdentity;
  /** What the shell's permission provider answers for this account. */
  readonly snapshot: PermissionSnapshot;
}
export const ADMIN_ID = {
  first: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b21',
  second: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b22',
} as const;
export function accountOf(
  username: string,
  adminId: string,
  snapshot: PermissionSnapshot,
): Account {
  return {
    username,
    snapshot,
    me: {
      admin_id: adminId,
      username,
      is_super: snapshot.isSuper,
      verify_phone_masked: '138****5678',
      permissions: [],
    },
  };
}

// ---- clock ---------------------------------------------------------------------------------

/** Fakes only `Date`, standing at AT. */
export function startClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(AT));
}
export function moveClock(iso: string): void {
  vi.setSystemTime(Date.parse(iso));
}

// ---- the console with its real login guard -------------------------------------------------

function memoryStorage(): AuthStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function envelope(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: TRACE });
}
function refusal(code: number, status: number): Response {
  return Response.json({ code, msg: '', trace_id: TRACE }, { status });
}
function ticketOf(account: Account): string {
  return `example-login-ticket-${account.me.admin_id}`;
}

export interface Console {
  readonly api: AdminApi;
  /** The account the fake server has signed in last (undefined before any sign-in). */
  current(): Account | undefined;
  /** Signs `account` in through the guard (no page involved). */
  signIn(account: Account): Promise<void>;
  /** Mounts the real shell on the menu `route` (call cleanup() first to mount again). */
  render(route: string): Promise<void>;
  /** Signs `account` in through the login page that replaced the shell. */
  loginWith(account: Account): Promise<void>;
  /** The guard's unified 10001 handling (the session ends, the login page shows). */
  expire(): Promise<void>;
}

const consoles: Console[] = [];

/**
 * The console over `fetch` (the page's fake server): the guard's calls go to a fake login server
 * for `accounts`, everything else (the page's reads and writes, the step-up pair) to `fetch`.
 */
export function createConsole(options: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly accounts: readonly Account[];
}): Console {
  const { accounts } = options;
  let pending: Account | undefined;
  let signedIn: Account | undefined;

  function answer(path: string, init: RequestInit | undefined): Response {
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;
    const authorization = new Headers(init?.headers).get('Authorization');
    if (path === LOGIN) {
      const found = accounts.find(
        (one) => one.username === body['username'] && body['password'] === PASSWORD,
      );
      if (found === undefined) return refusal(10008, 401);
      pending = found;
      const step: AdminLoginStepData = {
        next: 'totp',
        ['login_ticket']: ticketOf(found),
        ticket_expires_at: TICKET_EXPIRES,
      };
      return envelope(step);
    }
    if (path === TOTP) {
      const found = pending;
      if (found === undefined || body['login_ticket'] !== ticketOf(found) || body['code'] !== OTP)
        return refusal(20002, 400);
      pending = undefined;
      signedIn = found;
      return envelope(SESSION);
    }
    if (path === ME) {
      if (authorization !== `Bearer ${TOKEN}` || signedIn === undefined) return refusal(10001, 401);
      return envelope(signedIn.me);
    }
    if (path === LOGOUT) return envelope({});
    return refusal(50001, 500);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (GUARD_PATHS.has(url.pathname)) return answer(url.pathname, init);
    return options.fetch(input, init);
  };
  const api = createAdminApi({
    baseUrl: options.baseUrl,
    fetch,
    storage: memoryStorage(),
    clock: { now: () => Date.now() },
    manualStart: true,
  });

  const created: Console = {
    api,
    current: () => signedIn,
    async signIn(account) {
      await api.auth.login({ step: 'credentials', username: account.username, password: PASSWORD });
      await api.auth.login({ step: 'totp', code: OTP });
      expect(api.auth.getToken(), 'signed in through the guard').toBe(TOKEN);
    },
    async render(route) {
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
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('unexpected direct fetch'))),
      );
      await act(async () => {
        render(
          createAdminShell({
            router: 'memory',
            initialRoute: { menuId: route },
            permissionsProvider: async () => {
              const me = await api.auth.getIdentity({ refresh: true });
              const found = accounts.find((one) => me !== null && one.me.admin_id === me.admin_id);
              if (found === undefined) throw new Error('no signed-in account');
              return found.snapshot;
            },
            account: { username: 'console', displayName: 'console' },
            environment: 'test',
            onLogout: async () => {
              await api.auth.logout({});
            },
            dataProvider: api.data,
            authProvider: api.auth,
          }),
        );
      });
      await settle();
    },
    async loginWith(account) {
      // As the frozen login tests do (admin-auth/app.test.ts): 账号 / 密码, 【下一步】, 动态码, 【登录】.
      await waitFor(() => expect(loggedOut(), 'the login page').toBe(true));
      const user = userEvent.setup();
      const name = await screen.findByLabelText(/^账号/);
      await user.clear(name);
      await user.type(name, account.username);
      const password = screen.getByLabelText(/^密码/);
      await user.clear(password);
      await user.type(password, PASSWORD);
      await user.click(screen.getByRole('button', { name: '下一步' }));
      await screen.findByRole('heading', { name: TITLES.totp });
      await user.type(screen.getByRole('textbox', { name: '动态码' }), OTP);
      await user.click(screen.getByRole('button', { name: '登录' }));
      await waitFor(() => expect(loggedOut()).toBe(false));
      await waitFor(() => expect(api.auth.getToken()).toBe(TOKEN));
      expect(signedIn).toBe(account);
      await settle();
    },
    async expire() {
      await act(async () => {
        await api.auth.onError(
          new AdminApiError({
            code: 10001,
            msg: '请先登录',
            data: undefined,
            httpStatus: 401,
            kind: 'api',
          }),
        );
      });
      await waitFor(() => expect(loggedOut()).toBe(true));
    },
  };
  consoles.push(created);
  return created;
}

afterEach(() => {
  try {
    cleanup();
    for (const one of consoles.splice(0)) one.api.auth.dispose();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    window.localStorage.clear();
    baseline = [];
  }
});

export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

// ---- small DOM helpers ---------------------------------------------------------------------

/** Whitespace removed. */
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
function shown(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.hidden || node.style.display === 'none')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
  }
  return true;
}
function headingShown(title: string): boolean {
  return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, [role="heading"]')).some(
    (node) => shown(node) && squash(node.textContent) === squash(title),
  );
}
/** The login page (its first step) is shown. */
export function loggedOut(): boolean {
  return headingShown(TITLES.credentials);
}
/** Open dialogs and drawers (forms, step-up). */
export function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(shown);
}
/** A GET of `path` was logged after the first `since` requests. */
export function readSince(
  log: readonly { readonly method: string; readonly path: string }[],
  since: number,
  path: string,
): boolean {
  return log.slice(since).some((request) => request.method === 'GET' && request.path === path);
}
/**
 * Passes each step-up the page asks for (`asked()`, at most three, with `pass()`) until `done()`
 * holds — e.g. until a write answered 10001 ended the session.
 */
export async function passStepUpsUntil(
  done: () => boolean,
  asked: () => boolean,
  pass: () => Promise<void>,
): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await waitFor(() => expect(done() || asked(), 'done, or a step-up asked for').toBe(true));
    if (done()) return;
    await pass();
  }
  await waitFor(() => expect(done()).toBe(true));
}

// ---- the stored marker ---------------------------------------------------------------------

interface Stored {
  readonly area: string;
  readonly key: string;
  readonly value: string;
}
let baseline: readonly Stored[] = [];

function everything(): Stored[] {
  const found: Stored[] = [];
  for (const [area, storage] of [
    ['sessionStorage', window.sessionStorage],
    ['localStorage', window.localStorage],
  ] as const) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) found.push({ area, key, value: storage.getItem(key) ?? '' });
    }
  }
  return found;
}
/** Takes what both storages hold now as the state before this task's marker. */
export function takeBaseline(): void {
  baseline = everything();
}
/** Items of both storages that are new or changed since takeBaseline(). */
export function stored(): Stored[] {
  return everything().filter(
    (item) =>
      !baseline.some(
        (old) => old.area === item.area && old.key === item.key && old.value === item.value,
      ),
  );
}
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
/**
 * Exactly one item kept for the result-unknown submission of `page`, and its whole value is
 * {page, unknown: true, at: AT}; neither its key nor its value holds any of `forbidden`.
 */
export function expectMarker(page: string, forbidden: readonly string[]): void {
  const items = stored();
  expect(
    items.map((item) => `${item.area}: ${item.key}`),
    'exactly one item kept (sessionStorage or localStorage)',
  ).toHaveLength(1);
  const item = items[0]!;
  expect(parsed(item.value)).toEqual({ page, unknown: true, at: AT });
  for (const value of forbidden.filter((one) => one !== '')) {
    expect(item.key, 'no business data in the key').not.toContain(value);
    expect(item.value, 'no business data in the value').not.toContain(value);
  }
}
/** Nothing of this task is kept any more. */
export function expectNothingStored(): void {
  expect(stored().map((item) => `${item.area}: ${item.key} = ${item.value}`)).toEqual([]);
}

// ---- the prompt ----------------------------------------------------------------------------

function closeButtons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
    (node) =>
      shown(node) &&
      (squash(node.textContent) === CLOSE || squash(node.getAttribute('aria-label')) === CLOSE),
  );
}
/** The prompts on the page: innermost elements of <main> holding NOTICE and a 「关闭」 button. */
export function banners(): HTMLElement[] {
  const area = document.querySelector<HTMLElement>('main');
  if (area === null) return [];
  const candidates = Array.from(area.querySelectorAll<HTMLElement>('*')).filter(
    (node) =>
      shown(node) && squash(node.textContent).includes(NOTICE) && closeButtons(node).length > 0,
  );
  return candidates.filter(
    (node) => !candidates.some((other) => other !== node && node.contains(other)),
  );
}
/** Some visible element anywhere reads NOTICE. */
export function noticeShown(): boolean {
  return Array.from(document.body.querySelectorAll<HTMLElement>('*')).some(
    (node) => shown(node) && squash(node.textContent).includes(NOTICE),
  );
}

const HANDLERS = [
  'onClick',
  'onClickCapture',
  'onDoubleClick',
  'onMouseDown',
  'onMouseUp',
  'onPointerDown',
  'onPointerUp',
  'onKeyDown',
  'onKeyDownCapture',
  'onKeyUp',
  'onKeyPress',
];
const INTERACTIVE_ROLES = [
  'button',
  'link',
  'checkbox',
  'switch',
  'radio',
  'tab',
  'menuitem',
  'option',
  'textbox',
  'combobox',
];
function interactive(node: Element): boolean {
  const role = (node.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
  if (role !== '') return INTERACTIVE_ROLES.includes(role);
  return (
    node instanceof HTMLButtonElement ||
    node instanceof HTMLInputElement ||
    node instanceof HTMLSelectElement ||
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLAnchorElement && node.hasAttribute('href'))
  );
}
/** React's props of a DOM node (React keeps them on the node under __reactProps$…). */
function reactProps(node: Element): Record<string, unknown> | undefined {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'));
  if (key === undefined) return undefined;
  return (node as unknown as Record<string, Record<string, unknown> | undefined>)[key];
}
/** Elements of `root` (itself included) handling clicks or keys without an interactive role. */
export function handlersWithoutRole(root: HTMLElement): string[] {
  return [root, ...Array.from(root.querySelectorAll('*'))]
    .filter((node) => {
      const props = reactProps(node);
      return (
        props !== undefined &&
        !interactive(node) &&
        HANDLERS.some((name) => typeof props[name] === 'function')
      );
    })
    .map((node) => `${node.localName}.${node.getAttribute('class') ?? ''}`);
}

/**
 * Waits for the one prompt and checks it: NOTICE with the moment AT (not LATER), none of
 * `forbidden`, only its 「关闭」 button as a control, no handler without a role, above every tab
 * list and table of the page.
 */
export async function expectBanner(forbidden: readonly string[]): Promise<HTMLElement> {
  await waitFor(() => expect(banners(), 'one prompt on the page').toHaveLength(1));
  const banner = banners()[0]!;
  const text = squash(banner.textContent);
  expect(text).toContain(NOTICE);
  expect(text, 'the moment the result became unknown').toContain(squash(AT_SHOWN));
  expect(text, 'not the moment of signing in again').not.toContain(squash(LATER_SHOWN));
  for (const value of forbidden.filter((one) => one !== ''))
    expect(text, 'no business data in the prompt').not.toContain(squash(value));
  expect(controlsOf(banner), 'only its close button').toEqual([`button: ${CLOSE}`]);
  expect(handlersWithoutRole(banner), 'no click or key handler without a role').toEqual([]);
  const area = document.querySelector<HTMLElement>('main')!;
  const below = Array.from(area.querySelectorAll('table, [role="tablist"]')).filter(
    (node) => shown(node) && !banner.contains(node),
  );
  expect(below.length, 'the page shows its tabs or tables').toBeGreaterThan(0);
  const following = (node: Element): boolean =>
    (banner.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(
    below.filter((node) => !following(node)).map((node) => node.localName),
    'the prompt is at the top of the page',
  ).toEqual([]);
  return banner;
}

/** Presses 「关闭」 of the one prompt; it goes away and the stored item with it. */
export async function closeBanner(): Promise<void> {
  const found = banners();
  expect(found).toHaveLength(1);
  const buttons = closeButtons(found[0]!);
  expect(buttons, 'one 关闭 button').toHaveLength(1);
  await userEvent.setup().click(buttons[0]!);
  await settle();
  await waitFor(() => expect(noticeShown()).toBe(false));
  await waitFor(() => expectNothingStored());
}
