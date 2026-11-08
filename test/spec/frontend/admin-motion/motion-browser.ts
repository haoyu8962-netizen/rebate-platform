/// <reference types="@vitest/browser-playwright" />
// Browser kit for the admin-motion tests: the real admin shell on the workbench (super account,
// contract-shaped dashboard answer) and a per-frame sampler that writes what it measures onto a
// marker element, so the tests wait with expect.element only.
import { createRoot, type Root } from 'react-dom/client';
import { expect } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, SUPER, createServer } from '../admin-dashboard/dashboard-fixtures.ts';

/** First render of the shell (cold antd styles). */
export const FIRST = { timeout: 10_000 };
/** A state change after the page is ready. */
export const SHORT = { timeout: 3_000 };

let root: Root | undefined;
const samplers: (() => void)[] = [];

export function unmount(): void {
  for (const stop of samplers.splice(0)) stop();
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
}

/** Mounts the shell on the workbench; returns a marker carrying the number of open requests. */
export function showDashboard(): HTMLElement {
  const server = createServer();
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    pending += 1;
    marker.dataset['pending'] = String(pending);
    try {
      return await server.fetch(input, init);
    } finally {
      pending -= 1;
      marker.dataset['pending'] = String(pending);
    }
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'dashboard' },
      permissionsProvider: async () => SUPER,
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return marker;
}

/** The workbench has loaded, nothing is in flight and running animations have finished. */
export async function ready(marker: HTMLElement): Promise<void> {
  await expect
    .element(page.getByRole('main').getByRole('heading', { name: /昨日概览/ }), FIRST)
    .toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
}

/** Writes `read()` to `marker.dataset[name]` on every frame until the test unmounts. */
export function sample(marker: HTMLElement, name: string, read: () => string): void {
  let frame = 0;
  let live = true;
  const tick = (): void => {
    if (!live) return;
    marker.dataset[name] = read();
    frame = requestAnimationFrame(tick);
  };
  tick();
  samplers.push(() => {
    live = false;
    cancelAnimationFrame(frame);
  });
}
