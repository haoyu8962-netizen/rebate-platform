import { on } from '@couli/bridge-sdk';
import { bridge } from '@couli/contracts-ts';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ApiProvider, createAppApi, type AppApiClient } from '../../shared/api/app-api.ts';
import { clearAccountData, createQueryClient, createQueryProvider } from '../../shared/query.ts';
import { syncNavBar } from './nav-bar.ts';
import { createAppRoutes } from './routes.ts';

type AppRouter = ReturnType<typeof createBrowserRouter>;
type RouterLocation = AppRouter['state']['location'];

/** Nothing is drawn while the first lazy route loads; native shows its own loading state. */
function HydrateFallback() {
  return null;
}

/** H5 paths whose contract route needs no login (auth none): help, rules, notice, agreement. */
const ANONYMOUS_PATHS: ReadonlySet<string> = new Set(
  Object.values(bridge.routes).flatMap((route) =>
    route.kind === 'h5' && route.h5_path !== null && route.auth === 'none' ? [route.h5_path] : [],
  ),
);

/** Whether the page on screen is an anonymous contract route (unknown routes count as login). */
function onAnonymousPage(router: AppRouter): boolean {
  const page = router.state.matches.at(-1);
  return page?.route.path !== undefined && ANONYMOUS_PATHS.has(page.route.path);
}

interface AccountSession {
  /** Bumped on every auth.changed; the page tree is remounted under the new value. */
  epoch: number;
  /** After a logout: the location the page tree was taken down at (null while signed in). */
  parkedAt: RouterLocation | null;
}

interface AccountScopeProps {
  router: AppRouter;
  api: AppApiClient | null;
  client: QueryClient;
}

/**
 * The shell's single auth.changed subscription (account switch or logout in the same WebView),
 * mounted with the shell and independent of any page. On each event: drop the H5 token and any
 * acquisition in flight, cancel and clear the whole query cache, and remount the page tree so no
 * page keeps showing the previous account's data. A new login remounts at once and the page
 * fetches again with a new token. On a logout an anonymous page (contract auth none) is remounted
 * and keeps working without a token; any other page is taken down (no automatic request or token
 * call) until native navigates elsewhere or signs in again.
 */
function AccountScope({ router, api, client }: AccountScopeProps): ReactElement | null {
  const [session, setSession] = useState<AccountSession>({ epoch: 0, parkedAt: null });
  useEffect(
    () =>
      on('auth.changed', ({ logged_in: loggedIn }) => {
        api?.invalidateToken();
        clearAccountData(client);
        const parkedAt = loggedIn || onAnonymousPage(router) ? null : router.state.location;
        setSession((current) => ({ epoch: current.epoch + 1, parkedAt }));
      }),
    [api, client, router],
  );
  // The router keeps tracking history while its provider is unmounted; any completed navigation
  // yields a new location object and brings the page tree back.
  const location = useSyncExternalStore(router.subscribe, () => router.state.location);
  if (session.parkedAt !== null && session.parkedAt === location) return null;
  return <RouterProvider key={session.epoch} router={router} />;
}

/**
 * Native title bar: one ui.setNavBar per entry into a route (a change of path, not of query),
 * mounted with the shell so it also follows navigation while the page tree is taken down.
 */
function NavBarSync({ router }: { router: AppRouter }): null {
  const pathname = useSyncExternalStore(router.subscribe, () => router.state.location.pathname);
  useEffect(() => {
    syncNavBar(pathname);
  }, [pathname]);
  return null;
}

/**
 * Query provider, App API provider and React Router (lazy route modules), without an H5 title
 * bar (native draws the title, set through ui.setNavBar). One API client per shell; it is null without bridge, app.getEnv, base URL or brand, and
 * pages then read null from useApi() and send nothing.
 */
export function createAppShell(): ReactElement {
  const router = createBrowserRouter([{ path: '/', HydrateFallback, children: createAppRoutes() }]);
  const api = createAppApi();
  const client = createQueryClient();
  return createQueryProvider(
    <ApiProvider api={api}>
      <NavBarSync router={router} />
      <AccountScope router={router} api={api} client={client} />
    </ApiProvider>,
    client,
  );
}
