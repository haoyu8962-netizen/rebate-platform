// @vitest-environment jsdom
// DSX-48 anti-flash (规划/03 §10.6 item 7; ui-rules §2 L2): a skeleton appears only when loading
// lasts longer than motion.skeleton.show-delay, and once shown it stays at least
// motion.skeleton.min-visible before the content replaces it.
//
// The shared mechanism is the hook `useDelayedVisible(loading: boolean): boolean`, exported from
// apps/h5/src/components/base/index.ts: true while the skeleton should be on screen. Skeleton
// itself still renders its block at once (frozen F1-01f-SKELETON#1). The durations come from the
// tokens (generated TS theme, or the CSS variables at run time), never from literals in the
// component; jsdom loads no style sheet, so the variables are also set inline on <html> here with
// the token values, and either source gives the same numbers.
//
// The representative page is the rules page (entries/app/pages/rules): its first screen uses the
// hook (DELAY#4).
import { createElement, type ReactElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Base from '../../../../apps/h5/src/components/base/index.ts';
import { Skeleton } from '../../../../apps/h5/src/components/base/index.ts';
import { RulesPage } from '../../../../apps/h5/src/entries/app/pages/rules/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { articles, BODY_TEXT, CDN, reply, server, summaries } from '../h5-rules/fixtures.ts';
import { MIN_VISIBLE_MS, SHOW_DELAY_MS, SKELETON_BLOCK } from './expected.ts';

type UseDelayedVisible = (loading: boolean) => boolean;

const CSS_VARIABLES: readonly [string, string][] = [
  ['--motion-skeleton-show-delay', `${SHOW_DELAY_MS}ms`],
  ['--motion-skeleton-min-visible', `${MIN_VISIBLE_MS}ms`],
];

/** Every clock the hook could read is fake; microtasks and setImmediate stay real. */
const FAKE_CLOCKS = {
  toFake: [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'Date',
    'performance',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ],
} as const;

const clients: ReturnType<typeof createQueryClient>[] = [];

beforeEach(() => {
  for (const [name, value] of CSS_VARIABLES) {
    document.documentElement.style.setProperty(name, value);
  }
  vi.useFakeTimers({ toFake: [...FAKE_CLOCKS.toFake] });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
  for (const [name] of CSS_VARIABLES) document.documentElement.style.removeProperty(name);
  document.body.replaceChildren();
});

/** The hook from base/index.ts, asserted to exist before use. */
function delayedVisible(): UseDelayedVisible {
  const value: unknown = Reflect.get(Base, 'useDelayedVisible');
  expect(typeof value, 'apps/h5/src/components/base/index.ts exports useDelayedVisible').toBe(
    'function',
  );
  return value as UseDelayedVisible;
}

type HarnessComponent = (props: { loading: boolean }) => ReactElement;

/** Skeleton while the hook says so, an empty busy region while waiting, else the content. */
function harness(useDelayedVisible: UseDelayedVisible): HarnessComponent {
  return function Harness({ loading }: { loading: boolean }): ReactElement {
    const skeleton = useDelayedVisible(loading);
    if (skeleton) return createElement(Skeleton, { width: '100%', height: 20 });
    if (loading) return createElement('div', { 'aria-busy': 'true' });
    return createElement('p', null, 'loaded content');
  };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Records whether a skeleton block was ever added to `container`, also between two checks. */
function watchSkeleton(container: HTMLElement): { seen: () => boolean; stop: () => void } {
  let seen = container.querySelector(SKELETON_BLOCK) !== null;
  const inspect = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (
          node instanceof Element &&
          (node.matches(SKELETON_BLOCK) || node.querySelector(SKELETON_BLOCK) !== null)
        ) {
          seen = true;
        }
      }
    }
  };
  const observer = new MutationObserver(inspect);
  observer.observe(container, { childList: true, subtree: true });
  return {
    seen: () => {
      // Pending records too, so a block added and removed since the last check still counts.
      inspect(observer.takeRecords());
      if (container.querySelector(SKELETON_BLOCK) !== null) seen = true;
      return seen;
    },
    stop: () => observer.disconnect(),
  };
}

function skeletonShown(container: HTMLElement): boolean {
  return container.querySelector(SKELETON_BLOCK) !== null;
}

it('[AC-DSX-48-DELAY#1] 加载在 show-delay 之内结束：骨架从头到尾都不出现，直接显示内容', () => {
  const Harness = harness(delayedVisible());
  const view = render(createElement(Harness, { loading: true }));
  const watch = watchSkeleton(view.container);
  expect(skeletonShown(view.container)).toBe(false);
  advance(SHOW_DELAY_MS - 1);
  expect(skeletonShown(view.container)).toBe(false);
  view.rerender(createElement(Harness, { loading: false }));
  expect(screen.getByText('loaded content')).toBeTruthy();
  advance(SHOW_DELAY_MS + MIN_VISIBLE_MS + 1_000);
  expect(skeletonShown(view.container)).toBe(false);
  expect(screen.getByText('loaded content')).toBeTruthy();
  expect(watch.seen(), 'the skeleton never appeared').toBe(false);
  watch.stop();
});

it('[AC-DSX-48-DELAY#2] 加载超过 show-delay：此前不出骨架，到 show-delay 时出现并在加载期间一直保留', () => {
  const Harness = harness(delayedVisible());
  const view = render(createElement(Harness, { loading: true }));
  const watch = watchSkeleton(view.container);
  advance(SHOW_DELAY_MS - 1);
  expect(watch.seen(), `no skeleton before ${SHOW_DELAY_MS}ms`).toBe(false);
  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  advance(1);
  expect(skeletonShown(view.container), `skeleton at ${SHOW_DELAY_MS}ms`).toBe(true);
  advance(5_000);
  expect(skeletonShown(view.container), 'skeleton while still loading').toBe(true);
  expect(screen.queryByText('loaded content')).toBeNull();
  watch.stop();
});

it('[AC-DSX-48-DELAY#3] 骨架出现后至少保留 min-visible 才换成内容；已满 min-visible 时加载一结束立即换', () => {
  const Harness = harness(delayedVisible());
  const short = render(createElement(Harness, { loading: true }));
  advance(SHOW_DELAY_MS);
  expect(skeletonShown(short.container), 'skeleton appeared').toBe(true);
  advance(50);
  short.rerender(createElement(Harness, { loading: false }));
  expect(skeletonShown(short.container), 'kept right after loading ended').toBe(true);
  expect(screen.queryByText('loaded content')).toBeNull();
  advance(MIN_VISIBLE_MS - 50 - 1);
  expect(skeletonShown(short.container), `kept until ${MIN_VISIBLE_MS}ms after it appeared`).toBe(
    true,
  );
  expect(screen.queryByText('loaded content')).toBeNull();
  advance(1);
  expect(skeletonShown(short.container), 'gone once min-visible has passed').toBe(false);
  expect(screen.getByText('loaded content')).toBeTruthy();
  short.unmount();

  const long = render(createElement(Harness, { loading: true }));
  advance(SHOW_DELAY_MS + MIN_VISIBLE_MS + 200);
  expect(skeletonShown(long.container)).toBe(true);
  long.rerender(createElement(Harness, { loading: false }));
  expect(skeletonShown(long.container), 'no extra hold after min-visible').toBe(false);
  expect(screen.getByText('loaded content')).toBeTruthy();
});

/** Flushes promise chains of the fake HTTP boundary and React without moving the fake clock. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });
  }
}

async function advancePage(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

it('[AC-DSX-48-DELAY#4] 规则页首屏接入防闪：列表在途 show-delay 前无骨架、到点出骨架，返回后骨架仍保留到 min-visible 才显示正文', async () => {
  delayedVisible();
  const list = Promise.withResolvers<Response>();
  const http = server((url) =>
    url.pathname === '/v1/articles' ? list.promise : reply(articles[0]),
  );
  const client = createQueryClient();
  clients.push(client);
  const view = render(
    createQueryProvider(createElement(RulesPage, { api: http.api, mediaCdnOrigin: CDN }), client),
  );
  await settle();
  expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual(['/v1/articles']);

  await advancePage(SHOW_DELAY_MS - 1);
  expect(skeletonShown(view.container), `no skeleton before ${SHOW_DELAY_MS}ms`).toBe(false);
  await advancePage(1);
  expect(skeletonShown(view.container), `skeleton at ${SHOW_DELAY_MS}ms`).toBe(true);

  await act(async () => {
    list.resolve(reply(summaries()));
  });
  await settle();
  expect(skeletonShown(view.container), 'kept right after the list arrived').toBe(true);
  expect(screen.queryByRole('heading', { level: 1, name: '返利规则' })).toBeNull();
  await advancePage(MIN_VISIBLE_MS - 1);
  expect(skeletonShown(view.container), `kept until ${MIN_VISIBLE_MS}ms after it appeared`).toBe(
    true,
  );
  expect(screen.queryByRole('heading', { level: 1, name: '返利规则' })).toBeNull();
  await advancePage(1);
  expect(skeletonShown(view.container), 'gone once min-visible has passed').toBe(false);
  expect(screen.getByRole('heading', { level: 1, name: '返利规则' })).toBeTruthy();
  expect(screen.getByText(BODY_TEXT)).toBeTruthy();
});
