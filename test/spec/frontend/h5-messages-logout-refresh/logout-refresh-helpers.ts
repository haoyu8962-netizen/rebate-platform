import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
// 静态引入同时预热壳层的懒加载路由模块（同一文件），壳层里首屏不再等冷启动的 import。
import { MessagesPage } from '../../../../apps/h5/src/entries/app/pages/messages/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import {
  clearAccountData,
  createQueryClient,
  createQueryProvider,
} from '../../../../apps/h5/src/shared/query.ts';

type QueryClient = ReturnType<typeof createQueryClient>;

const clients: QueryClient[] = [];
const observers = new Set<FakeObserver>();
const releases: (() => void)[] = [];

afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const release of releases.splice(0)) release();
  });
  for (const client of clients.splice(0)) client.clear();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 可手动触发的 IntersectionObserver：列表末尾的哨兵由 reachBottom() 触发。 */
class FakeObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  readonly targets = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  intersect(): void {
    if (this.targets.size === 0) return;
    this.callback(
      Array.from(this.targets, (target) => ({
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        time: 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
      })),
      this,
    );
  }
}

/** 挂载前调用：页面的滚到底哨兵改用可手动触发的观察器。 */
export function stubObserver(): void {
  vi.stubGlobal('IntersectionObserver', FakeObserver);
}

/** 滚到底：触发当前所有哨兵。 */
export function reachBottom(): void {
  act(() => {
    for (const observer of [...observers]) observer.intersect();
  });
}

/** 在页面顶部下拉超过阈值后松手（原生触摸事件冒泡，不直接调页面内部函数）。 */
export function pullDown(target: HTMLElement): void {
  act(() => {
    fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 100, clientY: 30 }] });
    fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(target, {
      touches: [],
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 200 }],
    });
  });
}

/** 挂起的响应；测试中途断言失败也会在 afterEach 里放行，不留悬空的 Promise。 */
export function held<T>(fallback: T) {
  const pending = Promise.withResolvers<T>();
  releases.push(() => pending.resolve(fallback));
  return pending;
}

/** 让挂起的 Promise、零延时计时器与 React 更新跑完（不推进任何计时器）。 */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** GET /v1/messages 请求，按发出顺序。 */
export function listRequests(requests: readonly Request[]): Request[] {
  return requests.filter(
    (request) => request.method === 'GET' && new URL(request.url).pathname === '/v1/messages',
  );
}

/** 列表请求带的游标；第一页为 []。 */
export function cursorOf(request: Request): string[] {
  return new URL(request.url).searchParams.getAll('cursor');
}

/** 查询缓存里所有数据的文本（用来查旧账号的消息是否还在缓存里）。 */
export function cachedText(client: QueryClient): string {
  return JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data ?? null),
  );
}

/** 页面上的提示文字（role=alert），没有时为空串。 */
export function alertText(): string {
  return screen
    .queryAllByRole('alert')
    .map((element) => element.textContent ?? '')
    .join(' ');
}

/** 某段文字在页面上出现的次数。 */
export function count(text: string): number {
  return screen.queryAllByText(text, { exact: false }).length;
}

/**
 * 只挂消息页（不经壳层），查询客户端与 API 客户端由测试给。logout() 照壳层退出登录对缓存与页面树
 * 做的两步：作废当前代并取消、清空全部查询，再撤下页面。不调 API 客户端的 invalidateToken：
 * 那一层（F1-01s）本来就让在途响应失败，这里只核页面自己的作废。
 */
export function mountPage(api: H5ApiClient) {
  stubObserver();
  const client = createQueryClient();
  clients.push(client);
  const view = render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api },
        createElement(
          MemoryRouter,
          { initialEntries: ['/messages'] },
          createElement(MessagesPage, {}),
        ),
      ),
      client,
    ),
  );
  return {
    ...view,
    client,
    logout(): void {
      act(() => {
        clearAccountData(client);
      });
      view.unmount();
    },
  };
}

/** 断言一条请求是只取第一页（不带游标）的列表请求。 */
export function expectFirstPage(request: Request): void {
  expect(new URL(request.url).pathname).toBe('/v1/messages');
  expect(cursorOf(request), '刷新只取第一页，不带游标').toEqual([]);
}
