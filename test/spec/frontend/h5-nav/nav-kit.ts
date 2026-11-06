/// <reference types="@vitest/browser-playwright" />
// F1-01x (F1-01-nav) browser kit: mounts the real app shell (createAppShell, lazy contract routes)
// at a URL with a fake native transport that answers ui.setNavBar and records every call. Only the
// shell is mounted: the API client stays null (no app.getEnv), so pages send no requests.
import type { BridgeRequest, BridgeResponse } from '@couli/bridge-sdk';
import { createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, vi } from 'vitest';
import { createAppShell } from '../../../../apps/h5/src/entries/app/shell.ts';
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { installBridge } from '../bridge-sdk/kit.ts';

/**
 * Upper bound of each expect.element wait. Route chunks load through the dev server and the first
 * one can take a few seconds; the bound stays well below the test timeouts below, so a shell that
 * never calls ui.setNavBar ends in an assertion failure, not in a test timeout.
 */
export const WAIT = { timeout: 8_000 } as const;

/** Timeout of a test that waits for one or two route entries (≥ 3 × WAIT). */
export const TEST_TIMEOUT = 30_000;

/** Timeout of the walk over all nine routes plus the return to /earnings (ten entries). */
export const WALK_TIMEOUT = 120_000;

/** contracts/bridge.schema.json ui.setNavBar params.title maxLength. */
export const TITLE_MAX = 50;

/**
 * Page-title keys in contracts/texts.default.json per H5 route. Only /earnings has one
 * (08 BR-TEXT-01 `earnings.title`「页面标题与入口文字」). The other eight routes have no page-title
 * key yet (me.grid.* / settings.* are entry labels, not page titles); for them the tests only
 * require that the title is not hard-coded (absent, empty, or a contract dictionary value).
 */
export const EARNINGS_TITLE: string = dictionary.texts['earnings.title'];

const DICTIONARY_VALUES: ReadonlySet<string> = new Set<string>(Object.values(dictionary.texts));

/** The nine contract h5 paths (contracts/routes.json kind=h5), in contract order. */
export function contractH5Paths(): string[] {
  const paths: string[] = [];
  for (const route of Object.values(bridge.routes)) {
    if (route.kind === 'h5' && route.h5_path !== null) paths.push(route.h5_path);
  }
  return paths;
}

export interface NavCall {
  /** location.pathname when native received the call. */
  path: string;
  search: string;
  hasTitle: boolean;
  title: unknown;
  params: Readonly<Record<string, unknown>>;
}

export interface ShellHarness {
  calls: NavCall[];
  /** data-nav-count and data-last-nav-path follow the recorded calls (for expect.element). */
  probe: HTMLElement;
}

let root: Root | undefined;

/** Fake native: declares only ui.setNavBar, records it, answers every request with code 0. */
function installNavBridge(probe: HTMLElement): NavCall[] {
  const calls: NavCall[] = [];
  installBridge(['ui.setNavBar'], (request: BridgeRequest): BridgeResponse => {
    if (request.method === 'ui.setNavBar') {
      const params =
        typeof request.params === 'object' && request.params !== null
          ? (request.params as Record<string, unknown>)
          : {};
      calls.push({
        path: window.location.pathname,
        search: window.location.search,
        hasTitle: Object.hasOwn(params, 'title'),
        title: params['title'],
        params,
      });
      probe.dataset.navCount = String(calls.length);
      probe.dataset.lastNavPath = window.location.pathname;
    }
    return { id: request.id, code: 0, msg: '', data: {} };
  });
  return calls;
}

/** Mounts the real shell (under StrictMode, as main.tsx does) with the URL at `path`. */
export function mountShell(path: string): ShellHarness {
  const probe = document.createElement('span');
  probe.dataset.navCount = '0';
  document.body.append(probe);
  const calls = installNavBridge(probe);
  window.history.replaceState(null, '', path);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(createElement(StrictMode, null, createAppShell()));
  return { calls, probe };
}

export function unmountShell(): void {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
}

/** In-app navigation the way the router sees a native back / forward: history entry + popstate. */
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Waits until native has received a ui.setNavBar call while the URL path was `path`. */
export async function entered(harness: ShellHarness, path: string): Promise<void> {
  await expect.element(harness.probe, WAIT).toHaveAttribute('data-last-nav-path', path);
}

let settleRound = 0;

/**
 * Waits until the page has had two animation frames after the last navigation, so the router and
 * React have committed it and run its effects (a repeat ui.setNavBar, if any, has been sent).
 */
export async function settled(harness: ShellHarness): Promise<void> {
  settleRound += 1;
  const token = String(settleRound);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      harness.probe.dataset.settled = token;
    }),
  );
  await expect.element(harness.probe, WAIT).toHaveAttribute('data-settled', token);
}

/** Calls received while the URL path was `path`. */
export function callsAt(harness: ShellHarness, path: string): NavCall[] {
  return harness.calls.filter((call) => call.path === path);
}

/** /earnings: every call carries the contract dictionary value of earnings.title. */
export function expectEarningsTitle(calls: readonly NavCall[]): void {
  expect(calls.length, 'ui.setNavBar calls on /earnings').toBeGreaterThan(0);
  expect(EARNINGS_TITLE.length).toBeGreaterThan(0);
  expect(EARNINGS_TITLE.length).toBeLessThanOrEqual(TITLE_MAX);
  for (const call of calls) {
    expect(call.hasTitle, 'ui.setNavBar params.title present').toBe(true);
    expect(call.title).toBe(EARNINGS_TITLE);
  }
}

/**
 * Route without a page-title key: the title is absent, empty or a value of the contract
 * dictionary (never Chinese written in code), at most 50 characters, and repeated calls on the
 * same route keep the same title.
 */
export function expectNotHardCoded(calls: readonly NavCall[]): void {
  expect(calls.length, 'ui.setNavBar calls on this route').toBeGreaterThan(0);
  for (const call of calls) {
    if (!call.hasTitle) continue;
    expect(typeof call.title, 'ui.setNavBar params.title type').toBe('string');
    const title = String(call.title);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(
      title === '' || DICTIONARY_VALUES.has(title),
      `title「${title}」is a contracts/texts.default.json value or empty`,
    ).toBe(true);
  }
  expect(new Set(calls.map((call) => (call.hasTitle ? call.title : undefined))).size).toBe(1);
}
