// @vitest-environment jsdom
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CARDS, ENDPOINT, createServer } from './dashboard-fixtures.ts';
import { button, click, loaded, mainElement, mount, settled } from './dashboard-helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-14a-STATES#1] 首屏只请求一次聚合接口，经 provider 带 token，加载骨架带 status', async () => {
  const server = createServer();
  const release = server.hold();
  try {
    const { directFetch } = await mount(server);
    await waitFor(() => expect(server.log).toHaveLength(1));
    expect(server.log.map(({ method, path, search }) => ({ method, path, search }))).toEqual([
      { method: 'GET', path: ENDPOINT, search: '' },
    ]);
    expect(server.log[0]!.headers.get('Authorization')).toBe('Bearer example-admin-token');
    expect(
      within(mainElement())
        .queryAllByRole('status')
        .some((node) => /加载|读取/.test(node.textContent ?? '')),
    ).toBe(true);
    expect(mainElement().querySelector('.ant-skeleton')).not.toBeNull();
    expect(within(mainElement()).queryByRole('heading', { name: /昨日概览/ })).toBeNull();
    expect(directFetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release();
    });
  }
  await loaded();
  await settled(server);
  expect(server.log).toHaveLength(1);
  expect(mainElement().querySelector('.ant-skeleton')).toBeNull();
});

it('[AC-F1-14a-STATES#2] 刷新只重新请求一次并显示新值，不重复加载其他接口', async () => {
  const server = createServer();
  const { directFetch } = await mount(server);
  await loaded();
  expect(server.log).toHaveLength(1);
  const { todo: items } = server.state;
  items[0]!.count = 2468;
  const yesterday = server.state.yesterday;
  expect(yesterday).not.toBeNull();
  yesterday!.as_of = '2026-10-12T00:09:00Z';
  await click(button(mainElement(), /^刷新$/));
  await waitFor(() => expect(mainElement().textContent).toContain('2,468'));
  await settled(server);
  expect(mainElement().textContent).toContain('2026-10-12 08:09');
  expect(server.log.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `GET ${ENDPOINT}`,
    `GET ${ENDPOINT}`,
  ]);
  expect(directFetch).not.toHaveBeenCalled();
});

for (const [index, [kind, reply]] of (
  [
    ['网络', () => Promise.reject(new Error('synthetic network failure'))],
    ['5xx', () => new Response('service unavailable', { status: 503 })],
    [
      '解析失败',
      () =>
        new Response('{broken-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ],
  ] as const
).entries()) {
  it(`[AC-F1-14a-STATES#${index + 3}] ${kind} 刷新失败清除旧数据，Result 重试一次恢复`, async () => {
    const server = createServer();
    await mount(server);
    await loaded();
    server.once(reply);
    await click(button(mainElement(), /^刷新$/));
    await waitFor(() =>
      expect(within(mainElement()).queryByRole('button', { name: '重试' })).not.toBeNull(),
    );
    await settled(server);
    expect(mainElement().querySelector('.ant-result')).not.toBeNull();
    expect(mainElement().textContent).toMatch(/失败|出错/);
    // Fixed headings and explanatory copy may stay; old card links and numeric data may not.
    for (const [, title] of CARDS)
      expect(
        within(mainElement()).queryByRole('link', {
          name: (name) => name.startsWith(`${title} `),
        }),
      ).toBeNull();
    for (const value of mainElement().querySelectorAll('.ant-statistic-content'))
      expect(value.textContent).not.toMatch(/1,780|268|1,236\.40|96/);
    expect(server.log).toHaveLength(2);
    const { todo: items } = server.state;
    items[0]!.count = 7654;
    await click(button(mainElement(), /^重试$/));
    await loaded();
    await settled(server);
    expect(mainElement().textContent).toContain('7,654');
    expect(server.log).toHaveLength(3);
    expect(server.log.every(({ method, path }) => method === 'GET' && path === ENDPOINT)).toBe(
      true,
    );
    expect(within(mainElement()).queryByRole('button', { name: '重试' })).toBeNull();
  });

  it(`[AC-F1-14a-STATES#${index + 6}] ${kind} 首次加载失败显示 Result，手动重试只请求一次并恢复`, async () => {
    const server = createServer();
    server.once(reply);
    const { directFetch } = await mount(server);
    await waitFor(() =>
      expect(within(mainElement()).queryByRole('button', { name: '重试' })).not.toBeNull(),
    );
    await settled(server);
    expect(mainElement().querySelector('.ant-result')).not.toBeNull();
    expect(mainElement().textContent).toMatch(/失败|出错/);
    expect(mainElement().querySelector('.ant-skeleton')).toBeNull();
    expect(mainElement().querySelector('.ant-statistic')).toBeNull();
    expect(server.log.map(({ method, path }) => `${method} ${path}`)).toEqual([`GET ${ENDPOINT}`]);
    await click(button(mainElement(), /^重试$/));
    await loaded();
    await settled(server);
    expect(mainElement().textContent).toContain('1,780');
    expect(server.log.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${ENDPOINT}`,
      `GET ${ENDPOINT}`,
    ]);
    expect(mainElement().querySelector('.ant-result')).toBeNull();
    expect(within(mainElement()).queryByRole('button', { name: '重试' })).toBeNull();
    expect(directFetch).not.toHaveBeenCalled();
  });
}
