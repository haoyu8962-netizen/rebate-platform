// Admin app root (规划/03 §9.1): Ant Design theme, router, Refine (telemetry off) and the shell
// layout, wired to the /admin/v1 data provider and the CASL access control. Permissions come from
// the injected provider; menus are hidden by permission key and the server checks every action
// again.
import './styles/admin.css';
import {
  Refine,
  type AccessControlProvider,
  type AuthProvider,
  type DataProvider,
  type ResourceProps,
} from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { ConfigProvider, Layout, Typography, type ThemeConfig } from 'antd';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  useLocation,
  useNavigate,
  type InitialEntry,
} from 'react-router';
import { PlannedOperationsContext } from './components/planned/index.ts';
import { LoadFailedPage, NoPermissionPage, PagePending, WelcomePage } from './layout/pages.tsx';
import { Sidebar } from './layout/Sidebar.tsx';
import { TopBar } from './layout/TopBar.tsx';
import { AdminsPage } from './pages/admins/index.ts';
import { APP_VERSIONS_MENU_ID, AppVersionsPage, editTargetOf } from './pages/app-versions/index.ts';
import { ClaimReviewPage, ClaimsPage } from './pages/claims/index.ts';
import { AuditLogDetailPage, AuditLogsPage } from './pages/audit-logs/index.ts';
import { ConfigCenterPage } from './pages/config-center/index.ts';
import { DashboardPage, dashboardTargetOf } from './pages/dashboard/index.ts';
import { ExportsPage } from './pages/exports/index.ts';
import { FundLedgerPage } from './pages/fund-ledger/index.ts';
import { HomeConfigPage } from './pages/home-config/index.ts';
import { KillSwitchesPage } from './pages/kill-switches/index.ts';
import { MessagesPage } from './pages/messages/index.ts';
import { OrderDetailPage, OrdersPage } from './pages/orders/index.ts';
import { PayOrderDetailPage, PayOrdersPage } from './pages/pay-orders/index.ts';
import { PlatformIconsPage } from './pages/platform-icons/index.ts';
import { ReconPage } from './pages/recon/index.ts';
import { RiskPage } from './pages/risk/index.ts';
import { SettleBillDetailPage, SettleBillsPage } from './pages/settle-bills/index.ts';
import {
  UnionOAuthCallbackPage,
  UnionOAuthCallbackSignedOut,
  UnionsPage,
} from './pages/unions/index.ts';
import { UsersPage } from './pages/users/index.ts';
import {
  WITHDRAWALS_MENU_ID,
  WithdrawalDetailPage,
  WithdrawalsPage,
  withdrawalIdOf,
} from './pages/withdrawals/index.ts';
import { UserDetailView } from './pages/users/UserDetailView.tsx';
import { LoginPage } from './pages/login/index.ts';
import {
  createAccessControl,
  type AccessControl,
  type PermissionSnapshot,
  type PermissionsProvider,
} from './providers/access-control/index.ts';
import { createRefineAccessControl } from './providers/access-control/refine.ts';
import { createAdminApi, createAdminDataProvider, type AdminApi } from './providers/admin-api.ts';
import type { AdminAuthProvider, AuthClock } from './providers/auth/index.ts';
import {
  DASHBOARD_MENU_ID,
  findMenuItem,
  getAdminMenuGroups,
  selectAdminMenuGroups,
  type AdminMenuGroup,
} from './resources/index.ts';
import type { AdminShellOptions } from './shell-options.ts';
import { appVersionsTexts } from './texts/app-versions.ts';
import { claimsTexts } from './texts/claims.ts';
import { auditLogsTexts } from './texts/audit-logs.ts';
import { exportsTexts } from './texts/exports.ts';
import { ordersTexts } from './texts/orders.ts';
import { payOrdersTexts } from './texts/pay-orders.ts';
import { settleBillsTexts } from './texts/settle-bills.ts';
import { shellTexts } from './texts/shell.ts';
import { unionsTexts } from './texts/unions.ts';
import { withdrawalsTexts } from './texts/withdrawals.ts';
import { useReducedMotion } from './motion.ts';
import { createAntdTheme, sameAntdTheme } from './theme.ts';

type PermissionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: PermissionSnapshot }
  | { readonly status: 'failed' };

const NO_GROUPS: readonly AdminMenuGroup[] = [];
/** Without `plannedOperations` (tests, embedding) nothing is blocked. */
const NO_PLANNED: ReadonlySet<string> = new Set();
const USERS_MENU_ID = 'users';
const CLAIMS_MENU_ID = 'claims';
const RECON_MENU_ID = 'recon';
const FUND_LEDGER_MENU_ID = 'fund-ledger';
const SETTLE_BILLS_MENU_ID = 'settle-bills';
const SETTLE_BILL_DETAIL = /^settle-bills\/([^/]+)$/;
const PAY_ORDERS_MENU_ID = 'pay-orders';
const PAY_ORDER_DETAIL = /^pay-orders\/([^/]+)$/;

/** The pay_order_id of a pay order detail address (/pay-orders/<pay_order_id>), else undefined. */
function payOrderIdOf(path: string): string | undefined {
  const found = PAY_ORDER_DETAIL.exec(path)?.[1];
  if (found === undefined) return undefined;
  try {
    return decodeURIComponent(found);
  } catch {
    return found;
  }
}

/** The bill month of a bill detail address (/settle-bills/<bill_id>), else undefined. */
function settleBillIdOf(path: string): string | undefined {
  const found = SETTLE_BILL_DETAIL.exec(path)?.[1];
  if (found === undefined) return undefined;
  try {
    return decodeURIComponent(found);
  } catch {
    return found;
  }
}

/** The claim id of a review page address (/claims/<claim_id>), else undefined. */
function claimIdOf(path: string): string | undefined {
  const found = /^claims\/([^/]+)$/.exec(path);
  if (found === null) return undefined;
  try {
    return decodeURIComponent(found[1]!);
  } catch {
    return undefined;
  }
}

const ORDERS_MENU_ID = 'orders';
const ORDER_DETAIL = /^orders\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The order_id of an order detail address (/orders/<order_id>), else undefined. Only a UUID-shaped
 * id is an order (contract AdminOrderIdPath); other /orders/… addresses (such as a workbench
 * card's /orders/claims) keep their own handling.
 */
function orderIdOf(path: string): string | undefined {
  return ORDER_DETAIL.exec(path)?.[1];
}

const AUDIT_LOGS_MENU_ID = 'audit-logs';
/** 导出记录: no sidebar item; a subpage of 操作日志 (reached from its header link). */
const EXPORTS_ROUTE = 'exports';
const AUDIT_LOG_DETAIL = /^audit-logs\/([^/]+)$/;
const UNIONS_MENU_ID = 'unions';
/** 联盟 OAuth 回调页: no sidebar item; a subpage of 联盟账号与推广位 (the union redirects here). */
const UNION_CALLBACK_ROUTE = 'unions/oauth-callback';

/** Record id of an /audit-logs/<id> address (the detail subpage), else undefined. */
function auditLogIdOf(path: string): string | undefined {
  const found = AUDIT_LOG_DETAIL.exec(path)?.[1];
  if (found === undefined) return undefined;
  try {
    return decodeURIComponent(found);
  } catch {
    return found;
  }
}

// Refine resources: one per menu, nested under its group (for later Refine menus and hooks).
const RESOURCES: ResourceProps[] = getAdminMenuGroups().flatMap((group) => [
  { name: group.key, meta: { label: group.label } },
  ...group.items.map((item) => ({
    name: item.id,
    list: `/${item.id}`,
    meta: { label: item.label, parent: group.key },
  })),
]);

function initialEntry(route: AdminShellOptions['initialRoute']): InitialEntry {
  if (route === undefined) return '/';
  return { pathname: `/${route.menuId}`, state: { subpage: route.subpage } };
}

/** Router state of /users opened from the top-bar search: that user's detail, not the list. */
interface SearchUserState {
  readonly searchUser: string;
}

function searchUserOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('searchUser' in state)) return undefined;
  return typeof state.searchUser === 'string' ? state.searchUser : undefined;
}

function subpageOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('subpage' in state)) return undefined;
  return typeof state.subpage === 'string' ? state.subpage : undefined;
}

/**
 * Shell options plus the REST data provider (providers/data) and the login guard
 * (providers/auth). Without a data provider, the app talks to /admin/v1 on its own origin with
 * the admin_token of the guard. Without an auth provider, the browser router (the real entry,
 * main.tsx) still gets one (sessionStorage session, permissions from /admin/v1/me/permissions);
 * the memory router (tests, embedding) then shows the shell for the injected account.
 */
export interface AdminAppOptions extends AdminShellOptions {
  readonly dataProvider?: DataProvider;
  readonly authProvider?: AdminAuthProvider;
  /** Console clock (epoch ms) for the own guard and time-dependent pages; defaults to Date.now. */
  readonly clock?: AuthClock;
}

/** The browser entry's own guard and data provider against /admin/v1 on this origin. */
function defaultAdminApi(clock: AuthClock | undefined): AdminApi {
  return createAdminApi({
    baseUrl: window.location.origin,
    fetch: (input, init) => globalThis.fetch(input, init),
    manualStart: true,
    ...(clock === undefined ? {} : { clock }),
  });
}

function defaultDataProvider(auth: AdminAuthProvider | undefined): DataProvider {
  return createAdminDataProvider({
    baseUrl: window.location.origin,
    fetch: (input, init) => globalThis.fetch(input, init),
    auth,
  });
}

const subscribeNothing = (): (() => void) => () => undefined;

/** Memory router without a guard (tests, embedding): the host owns the account. */
const HOST_AUTH: AuthProvider = {
  login: () => Promise.resolve({ success: false }),
  logout: () => Promise.resolve({ success: true }),
  check: () => Promise.resolve({ authenticated: true }),
  onError: () => Promise.resolve({}),
};

/** Login route: any other address while signed out shows the login page at /login. */
function LoginRoute({
  auth,
  environment,
  onComplete,
}: {
  readonly auth: AdminAuthProvider;
  readonly environment: AdminShellOptions['environment'];
  readonly onComplete: () => void;
}) {
  const location = useLocation();
  // The union's OAuth redirect in a window without the console session: say so instead of
  // silently dropping state and code on the way to /login (F1-10ga r1 S1).
  if (location.pathname === `/${UNION_CALLBACK_ROUTE}`) return <UnionOAuthCallbackSignedOut />;
  return (
    <>
      {location.pathname === '/login' ? null : <Navigate to="/login" replace />}
      <LoginPage authProvider={auth} environment={environment} onComplete={onComplete} />
    </>
  );
}

/** Builds the admin app element; the caller mounts it (main.tsx, tests). */
export function createAdminShell(options: AdminAppOptions): ReactElement {
  return <AdminApp options={options} />;
}

interface ShellRouterProps {
  readonly kind: NonNullable<AdminShellOptions['router']>;
  readonly initialRoute: AdminShellOptions['initialRoute'];
  readonly children: ReactNode;
}

// BrowserRouter rather than HashRouter: plain paths (/withdrawals) for deep links and the
// audit log; the admin host serves index.html for unknown paths (Vite dev server does already).
function ShellRouter({ kind, initialRoute, children }: ShellRouterProps) {
  const [initialEntries] = useState(() => [initialEntry(initialRoute)]);
  if (kind === 'browser') {
    return <BrowserRouter basename={import.meta.env.BASE_URL}>{children}</BrowserRouter>;
  }
  return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
}

// The antd theme follows the CSS in effect: rebuilt when the system scheme changes or <html>
// data-theme changes, and only when the resulting theme differs. The tree is never remounted.
// Reduced motion (规划/03 §10.6 第 8 条) switches antd motion off and follows the setting too.
function useFollowColorScheme(
  setTheme: Dispatch<SetStateAction<ThemeConfig>>,
  reducedMotion: boolean,
): void {
  useEffect(() => {
    const refresh = (): void =>
      setTheme((previous) => {
        const next = createAntdTheme(document.documentElement, { reducedMotion });
        return sameAntdTheme(previous, next) ? previous : next;
      });
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : undefined;
    media?.addEventListener('change', refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    // The scheme may have changed between the first render and this effect.
    refresh();
    return () => {
      media?.removeEventListener('change', refresh);
      observer.disconnect();
    };
  }, [setTheme, reducedMotion]);
}

function AdminApp({ options }: { readonly options: AdminAppOptions }) {
  const reducedMotion = useReducedMotion();
  const [theme, setTheme] = useState(() =>
    createAntdTheme(document.documentElement, { reducedMotion }),
  );
  useFollowColorScheme(setTheme, reducedMotion);
  // The own guard is built without timers; only the instance React keeps starts them (effect) and
  // stops them on unmount, so a render React throws away (StrictMode) never clears the session.
  const [ownApi] = useState(() =>
    options.authProvider === undefined && options.router === 'browser'
      ? defaultAdminApi(options.clock)
      : undefined,
  );
  const ownAuth = ownApi?.auth;
  useEffect(() => ownAuth?.start(), [ownAuth]);
  const auth = options.authProvider ?? ownAuth;
  const [dataProvider] = useState(
    () => options.dataProvider ?? ownApi?.data ?? defaultDataProvider(auth),
  );
  const [state, setState] = useState<PermissionState>({ status: 'loading' });
  const [signedInName, setSignedInName] = useState<string | undefined>(undefined);
  const latestRequest = useRef(0);

  // Guard: the shell shows only with a live session that finished the login steps here (the
  // binding page keeps its 「进入后台」 step) or was restored from this tab's session.
  const subscribe = useMemo(() => auth?.subscribe ?? subscribeNothing, [auth]);
  const authenticated = useSyncExternalStore(
    subscribe,
    () => auth === undefined || auth.getToken() !== null,
    () => auth === undefined,
  );
  const [entered, setEntered] = useState(authenticated);
  const [landing, setLanding] = useState(false);
  if (!authenticated && entered) setEntered(false);
  const signedIn = auth === undefined || (authenticated && entered);

  // With its own guard the app reads permissions (and the account name) from /me/permissions.
  const permissionsProvider = useMemo<PermissionsProvider>(() => {
    if (ownApi === undefined) return options.permissionsProvider;
    return async () => {
      // Every load (first render, 刷新权限) asks the server again, never the cached answer.
      const { snapshot, username } = await ownApi.loadPermissions();
      setSignedInName(username);
      return snapshot;
    };
  }, [ownApi, options.permissionsProvider]);
  const account =
    signedInName === undefined
      ? options.account
      : { username: signedInName, displayName: signedInName };

  // Each load (first render, 刷新权限) asks the provider again; only the latest answer counts.
  const loadPermissions = useCallback(() => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    void permissionsProvider().then(
      (snapshot) => {
        if (request === latestRequest.current) setState({ status: 'ready', snapshot });
      },
      () => {
        // A failed refresh keeps the menus already shown; a failed first load shows a retry.
        if (request !== latestRequest.current) return;
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'failed' }));
      },
    );
  }, [permissionsProvider]);

  // Permissions load only for a signed-in account; signing out drops the old answer.
  const [wasSignedIn, setWasSignedIn] = useState(signedIn);
  if (wasSignedIn !== signedIn) {
    setWasSignedIn(signedIn);
    if (!signedIn) {
      setState({ status: 'loading' });
      setSignedInName(undefined);
    }
  }
  useEffect(() => {
    if (signedIn) loadPermissions();
    else latestRequest.current += 1;
  }, [signedIn, loadPermissions]);

  // Returns the request so 【退出】 stays disabled while it is under way.
  const onLogout = useCallback(
    (): void | Promise<unknown> =>
      ownAuth !== undefined ? ownAuth.logout({}) : options.onLogout(),
    [ownAuth, options],
  );

  const access = useMemo(
    () => (state.status === 'ready' ? createAccessControl(state.snapshot) : undefined),
    [state],
  );
  const groups = useMemo(
    () => (state.status === 'ready' ? selectAdminMenuGroups(state.snapshot) : NO_GROUPS),
    [state],
  );
  const accessControlProvider = useMemo<AccessControlProvider>(
    () => createRefineAccessControl(access, groups),
    [access, groups],
  );

  return (
    <ConfigProvider theme={theme} button={{ autoInsertSpace: false }}>
      <ShellRouter kind={options.router ?? 'memory'} initialRoute={options.initialRoute}>
        <Refine
          routerProvider={routerProvider}
          resources={RESOURCES}
          dataProvider={dataProvider}
          accessControlProvider={accessControlProvider}
          authProvider={auth ?? HOST_AUTH}
          options={{ disableTelemetry: true }}
        >
          {signedIn || auth === undefined ? (
            <PlannedOperationsContext value={options.plannedOperations ?? NO_PLANNED}>
              <ShellFrame
                options={options}
                account={account}
                state={state}
                access={access}
                groups={groups}
                landing={landing}
                onLanded={() => setLanding(false)}
                onRefresh={loadPermissions}
                onLogout={onLogout}
              />
            </PlannedOperationsContext>
          ) : (
            <LoginRoute
              auth={auth}
              environment={options.environment}
              onComplete={() => {
                setLanding(true);
                setEntered(true);
              }}
            />
          )}
        </Refine>
      </ShellRouter>
    </ConfigProvider>
  );
}

interface ShellFrameProps {
  readonly options: AdminAppOptions;
  readonly state: PermissionState;
  readonly access: AccessControl | undefined;
  readonly groups: readonly AdminMenuGroup[];
  readonly account: AdminShellOptions['account'];
  /** Just signed in: open the first permitted menu, or the home page without permission keys. */
  readonly landing: boolean;
  readonly onLanded: () => void;
  readonly onRefresh: () => void;
  readonly onLogout: () => void | Promise<unknown>;
}

function ShellFrame({
  options,
  state,
  access,
  groups,
  account,
  landing,
  onLanded,
  onRefresh,
  onLogout,
}: ShellFrameProps) {
  const location = useLocation();
  const navigate = useNavigate();

  // The router may apply the navigation in a transition: landing ends only once the address is the
  // landing page, so the old address (/login) never renders and redirects home in the meantime.
  // A failed first load leaves the address at home and keeps landing pending: once 重试 succeeds,
  // the same rule as a first success picks the landing page.
  useEffect(() => {
    if (!landing || state.status === 'loading') return;
    let target = '/';
    if (state.status === 'ready') {
      const { snapshot } = state;
      const first = groups[0]?.items[0];
      const empty = !snapshot.isSuper && snapshot.permissions.length === 0;
      if (!empty && first !== undefined) target = `/${first.id}`;
    }
    if (location.pathname !== target) {
      void navigate(target, { replace: true });
      return;
    }
    if (state.status === 'ready') onLanded();
  }, [landing, state, groups, navigate, onLanded, location.pathname]);

  // A user hit of the top-bar search: each opening is a new history entry (its own detail view).
  const openUser = useCallback(
    (userId: string) => {
      const target: SearchUserState = { searchUser: userId };
      void navigate(`/${USERS_MENU_ID}`, { state: target });
    },
    [navigate],
  );

  const path = location.pathname.replace(/^\/+/, '');
  // The audit record detail (/audit-logs/<id>) and 导出记录 (/exports) are subpages of 操作日志.
  const auditLogId = auditLogIdOf(path);
  const exportsRoute = path === EXPORTS_ROUTE;
  const auditSubpage =
    auditLogId !== undefined
      ? auditLogsTexts.detail.crumb
      : exportsRoute
        ? exportsTexts.title
        : undefined;
  const unionCallback = path === UNION_CALLBACK_ROUTE;
  const menuId =
    auditSubpage !== undefined ? AUDIT_LOGS_MENU_ID : unionCallback ? UNIONS_MENU_ID : path;
  const searchUser = menuId === USERS_MENU_ID ? searchUserOf(location.state) : undefined;
  // A claim's review page (/claims/<claim_id>) belongs to the claims menu (sidebar, crumbs).
  const claimId = claimIdOf(menuId);
  // An order's detail page (/orders/<order_id>) belongs to the orders menu (sidebar, crumbs).
  const orderId = claimId === undefined ? orderIdOf(menuId) : undefined;
  // A withdrawal's detail page (/withdrawals/<withdrawal_id>) belongs to 提现审核.
  const withdrawalId =
    claimId === undefined && orderId === undefined ? withdrawalIdOf(menuId) : undefined;
  // A version row's edit subpage (/app-versions/<platform>/<channel>) belongs to 版本管理.
  const appVersionEdit = editTargetOf(menuId) !== undefined;
  // A bill's detail page (/settle-bills/<bill_id>) belongs to 月结账单 (sidebar, crumbs).
  const settleBillId = settleBillIdOf(menuId);
  // A pay order's detail page (/pay-orders/<pay_order_id>) belongs to 支付单 (sidebar, crumbs).
  const payOrderId = payOrderIdOf(menuId);
  const match = findMenuItem(
    groups,
    claimId !== undefined
      ? CLAIMS_MENU_ID
      : orderId !== undefined
        ? ORDERS_MENU_ID
        : withdrawalId !== undefined
          ? WITHDRAWALS_MENU_ID
          : appVersionEdit
            ? APP_VERSIONS_MENU_ID
            : settleBillId !== undefined
              ? SETTLE_BILLS_MENU_ID
              : payOrderId !== undefined
                ? PAY_ORDERS_MENU_ID
                : menuId,
  );
  let subpage = match === undefined ? undefined : (auditSubpage ?? subpageOf(location.state));
  if (match !== undefined && claimId !== undefined) subpage = claimsTexts.review.crumb;
  if (match !== undefined && orderId !== undefined) subpage = ordersTexts.detail.crumb;
  if (match !== undefined && withdrawalId !== undefined) subpage = withdrawalsTexts.detail.crumb;
  if (match !== undefined && unionCallback) subpage = unionsTexts.callback.crumb;
  if (match !== undefined && appVersionEdit) subpage = appVersionsTexts.editor.crumb;
  if (match !== undefined && settleBillId !== undefined) subpage = settleBillsTexts.detail.crumb;
  if (match !== undefined && payOrderId !== undefined) subpage = payOrdersTexts.detail.crumb;
  // A workbench card opened a route whose page is not in the catalogue yet (e.g. /risk/appeals):
  // the placeholder shows under the card's page name instead of falling back home.
  const cardTarget =
    match === undefined && findMenuItem(getAdminMenuGroups(), menuId) === undefined
      ? dashboardTargetOf(location.state)
      : undefined;
  // First permitted menu after the workbench (sidebar order): where the workbench sends accounts
  // without dashboard.view.
  const firstOther = groups
    .flatMap((group) => group.items)
    .find((item) => item.id !== DASHBOARD_MENU_ID);
  const noPermission =
    state.status === 'ready' && !state.snapshot.isSuper && state.snapshot.permissions.length === 0;
  const fallback = noPermission || firstOther === undefined ? '/' : `/${firstOther.id}`;
  // The top-bar search is on every page of an account with permission keys (not 暂无权限).
  const showSearch = state.status === 'ready' && !noPermission && !landing;
  let crumbs: string[];
  if (match === undefined) crumbs = [cardTarget ?? shellTexts.welcomeCrumb];
  else if (match.group.key === DASHBOARD_MENU_ID) crumbs = [match.item.label];
  else crumbs = [match.group.label, match.item.label, ...(subpage === undefined ? [] : [subpage])];

  let content: ReactNode = (
    <Typography.Text type="secondary" role="status">
      {shellTexts.loading}
    </Typography.Text>
  );
  if (state.status === 'failed') {
    content = <LoadFailedPage onRetry={onRefresh} />;
  } else if (landing) {
    // Keep the loading line until the landing page is chosen (no flash of the old address).
  } else if (state.status === 'ready' && access !== undefined) {
    const { snapshot } = state;
    if (match !== undefined && claimId !== undefined) {
      content = <ClaimReviewPage key={claimId} access={access} claimId={claimId} />;
    } else if (match !== undefined && orderId !== undefined) {
      // Direct address or 【详情】 of a row: only this order is read, never the list.
      content = <OrderDetailPage key={orderId} access={access} orderId={orderId} />;
    } else if (match !== undefined && settleBillId !== undefined) {
      // Direct address or 【查看】 of a row: only this bill is read, never the list.
      content = <SettleBillDetailPage key={settleBillId} access={access} billId={settleBillId} />;
    } else if (
      withdrawalId !== undefined &&
      (match !== undefined || snapshot.isSuper || snapshot.permissions.length > 0)
    ) {
      // Direct address or 【详情】 of a row: only this withdrawal is read, never the list. Without
      // the menu (fund.view alone) the page still opens; without withdraw.review / fund.view it
      // says so and sends nothing.
      content = (
        <WithdrawalDetailPage key={withdrawalId} access={access} withdrawalId={withdrawalId} />
      );
    } else if (match !== undefined && payOrderId !== undefined) {
      // Direct address or 【详情】 of a row: only this pay order is read, never the list.
      content = <PayOrderDetailPage key={payOrderId} access={access} payOrderId={payOrderId} />;
    } else if (match !== undefined && auditLogId !== undefined) {
      // Direct address or 【查看】 of a row: only this record is read, never the list.
      content = <AuditLogDetailPage key={auditLogId} id={auditLogId} access={access} />;
    } else if (match !== undefined && exportsRoute) {
      content = <ExportsPage access={access} clock={options.clock} />;
    } else if (match !== undefined && unionCallback) {
      // The union's OAuth redirect: posts state and code (or error) once, then shows the result.
      content = <UnionOAuthCallbackPage access={access} clock={options.clock} />;
    } else if (match !== undefined && options.renderPage !== undefined) {
      content = options.renderPage(match.item.id, access);
    } else if (searchUser !== undefined && (snapshot.isSuper || snapshot.permissions.length > 0)) {
      // Opened from the top-bar search; 【返回】 goes to the users list.
      content = (
        <UserDetailView
          key={location.key}
          userId={searchUser}
          canReveal={access.can('pii.reveal_phone')}
          onBack={() => void navigate(`/${USERS_MENU_ID}`)}
          onOpenUser={openUser}
        />
      );
    } else if (match !== undefined && match.item.id === DASHBOARD_MENU_ID) {
      content = <DashboardPage access={access} fallback={fallback} />;
    } else if (match !== undefined && match.item.id === 'admins') {
      // Default page for the super-admin-only menu (the menu itself is hidden otherwise).
      content = <AdminsPage />;
    } else if (match !== undefined && match.item.id === 'platform-icons') {
      content = <PlatformIconsPage />;
    } else if (match !== undefined && match.item.id === 'messages') {
      // 消息模板: notify.channels reads and writes; the page itself says so without it.
      content = <MessagesPage access={access} />;
    } else if (match !== undefined && match.item.id === RECON_MENU_ID) {
      // 对账与差错: fund.recon or fund.view reads; only fund.recon closes a difference.
      content = <ReconPage access={access} />;
    } else if (match !== undefined && match.item.id === FUND_LEDGER_MENU_ID) {
      // 平台资金台账: fund.view reads the daily ledger; fund.cash_entry alone gets the page's notice.
      content = <FundLedgerPage access={access} />;
    } else if (match !== undefined && match.item.id === SETTLE_BILLS_MENU_ID) {
      // 月结账单: settle.bill or fund.view reads; the other menu points get the page's notice.
      content = <SettleBillsPage access={access} />;
    } else if (match !== undefined && match.item.id === WITHDRAWALS_MENU_ID) {
      // 提现审核: withdraw.review or fund.view reads; payout.* alone shows the menu but not the list.
      content = <WithdrawalsPage access={access} />;
    } else if (match !== undefined && match.item.id === PAY_ORDERS_MENU_ID) {
      // 支付单: pay.view reads; pay.refund / pay.resolve alone get the page's notice.
      content = <PayOrdersPage access={access} />;
    } else if (match !== undefined && match.item.id === UNIONS_MENU_ID) {
      content = <UnionsPage access={access} clock={options.clock} />;
    } else if (match !== undefined && match.item.id === APP_VERSIONS_MENU_ID) {
      // The list, or a row's edit subpage (the page reads the address itself).
      content = <AppVersionsPage access={access} />;
    } else if (match !== undefined && match.item.id === 'switches') {
      content = <KillSwitchesPage access={access} />;
    } else if (match !== undefined && match.item.id === 'config') {
      content = <ConfigCenterPage access={access} />;
    } else if (match !== undefined && match.item.id === 'risk') {
      // 风控: the 规则清单 tab needs config.risk on top of the risk.* keys that show the menu.
      content = <RiskPage access={access} />;
    } else if (match !== undefined && match.item.id === 'pages') {
      content = <HomeConfigPage access={access} />;
    } else if (match !== undefined && match.item.id === CLAIMS_MENU_ID) {
      // Keyed by the history entry: a new address (sidebar, 【返回】, ?status= link) reads its
      // conditions afresh.
      content = <ClaimsPage key={location.key} access={access} />;
    } else if (match !== undefined && match.item.id === ORDERS_MENU_ID) {
      // Keyed by the history entry: 【返回】 from a detail restores the conditions it carries.
      content = <OrdersPage key={location.key} access={access} />;
    } else if (match !== undefined && match.item.id === 'users') {
      content = <UsersPage access={access} />;
    } else if (match !== undefined && match.item.id === AUDIT_LOGS_MENU_ID) {
      content = <AuditLogsPage access={access} />;
    } else if (match !== undefined) {
      content = <PagePending title={match.item.label} />;
    } else if (menuId === 'users' && (snapshot.isSuper || snapshot.permissions.length > 0)) {
      // A direct address to the users page without user.list / user.lookup: the page itself says
      // so (and sends nothing) instead of silently landing on the home page.
      content = <UsersPage access={access} />;
    } else if (menuId === RECON_MENU_ID && (snapshot.isSuper || snapshot.permissions.length > 0)) {
      // A direct address to /recon without fund.recon / fund.view: the page itself says so (and
      // sends nothing), as the users page does.
      content = <ReconPage access={access} />;
    } else if (
      (menuId === SETTLE_BILLS_MENU_ID || settleBillId !== undefined) &&
      (snapshot.isSuper || snapshot.permissions.length > 0)
    ) {
      // A direct address to 月结账单 without a menu point (fund.view reads but does not show the
      // menu): the page itself reads, or says there is no permission (and sends nothing).
      content =
        settleBillId === undefined ? (
          <SettleBillsPage access={access} />
        ) : (
          <SettleBillDetailPage key={settleBillId} access={access} billId={settleBillId} />
        );
    } else if (
      menuId === FUND_LEDGER_MENU_ID &&
      (snapshot.isSuper || snapshot.permissions.length > 0)
    ) {
      // A direct address to /fund-ledger without the menu (fund.view alone reads; without it the
      // page itself says so and sends nothing).
      content = <FundLedgerPage access={access} />;
    } else if (
      menuId === WITHDRAWALS_MENU_ID &&
      (snapshot.isSuper || snapshot.permissions.length > 0)
    ) {
      // A direct address to /withdrawals without the menu (fund.view alone reads; no read key at
      // all: the page itself says so and sends nothing).
      content = <WithdrawalsPage access={access} />;
    } else if (menuId === DASHBOARD_MENU_ID) {
      // The workbench without dashboard.view: the first permitted menu instead (never a request).
      content = <Navigate to={fallback} replace />;
    } else if (cardTarget !== undefined) {
      content = <PagePending title={cardTarget} />;
    } else if (menuId !== '') {
      // Unknown or no longer permitted menu (e.g. after 刷新权限): back to the home page.
      content = <Navigate to="/" replace />;
    } else if (!snapshot.isSuper && snapshot.permissions.length === 0) {
      content = (
        <NoPermissionPage
          username={account.username}
          displayName={account.displayName}
          permissionCount={snapshot.permissions.length}
          onRefresh={onRefresh}
        />
      );
    } else {
      content = <WelcomePage />;
    }
  }

  return (
    <Layout hasSider className="admin-shell">
      <Sidebar groups={groups} activeId={match?.item.id} />
      <Layout className="admin-column">
        <TopBar
          crumbs={crumbs}
          environment={options.environment}
          displayName={account.displayName}
          onLogout={onLogout}
          onOpenUser={showSearch ? openUser : undefined}
        />
        <Layout.Content className="admin-content" aria-busy={state.status === 'loading'}>
          {content}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
