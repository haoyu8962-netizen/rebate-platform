// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EMPTY,
  FOOTER,
  LABELS,
  NO_HIT_FOOTER,
  ORDER,
  ORDER_NUMBER,
  UID,
  UNKNOWN_NUMBER,
  USER,
  WITHDRAWAL,
  WITHDRAWAL_NUMBER,
  createServer,
  type Hit,
} from './search-fixtures.ts';
import {
  FLOW_TIMEOUT,
  click,
  input,
  key,
  listbox,
  mainElement,
  mount,
  options,
  settled,
  submit,
} from './search-helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function userDetail(): Promise<void> {
  await waitFor(() => expect(mainElement().textContent).toContain('K7QX2M'));
  expect(mainElement().textContent).toContain(UID);
  expect(mainElement().textContent).toContain('基本信息');
  expect(mainElement().textContent).toContain('138****5678');
  expect(screen.getByRole('navigation', { name: '面包屑' }).textContent).toContain('用户查询');
}

async function noHitNotice(): Promise<HTMLElement> {
  const message = `没有找到「${UNKNOWN_NUMBER}」`;
  await waitFor(() => expect(screen.queryByText(message, { exact: false })).not.toBeNull());
  await waitFor(() => expect(screen.queryByText(NO_HIT_FOOTER, { exact: false })).not.toBeNull());
  const footer = screen.getByText(NO_HIT_FOOTER, { exact: false });
  let panel = screen.getByText(message, { exact: false });
  // Locate the shared text container without imposing a role or nesting depth.
  while (!panel.contains(footer) && panel.parentElement) panel = panel.parentElement;
  expect(panel.contains(footer)).toBe(true);
  return panel;
}

async function placeholderHit(hit: Hit, query: string): Promise<void> {
  const server = createServer({ items: [hit], truncated: false });
  await mount(server, {
    permissionsProvider: async () => ({
      isSuper: false,
      permissions: hit.type === 'order' ? ['order.view'] : ['order.view', 'fund.view'],
    }),
  });
  // The current page's own reads (the orders list once that page is live) settle before the
  // search; only those may reach the shared users/page fixture, and nothing may be added by the
  // search or by activating the hit.
  await settled(server);
  // BR-ID-46: besides the orders list, the orders page reads the latest sync record at most once
  // for its status bar (GET order-syncs, page=1 and page_size=1 only); nothing else may be read.
  const others = server.users.log.filter(
    (entry) => !(entry.method === 'GET' && entry.path === '/admin/v1/orders'),
  );
  expect(others.length).toBeLessThanOrEqual(1);
  expect(
    others.every(
      (entry) =>
        entry.method === 'GET' &&
        entry.path === '/admin/v1/order-syncs' &&
        entry.query['page'] === '1' &&
        entry.query['page_size'] === '1' &&
        Object.keys(entry.query).length === 2,
    ),
  ).toBe(true);
  const pageRequests = server.users.log.length;
  await submit(query);
  const entries = await options();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.textContent).toContain(hit.summary);
  expect((await listbox()).textContent).not.toContain(USER.id);
  const before = mainElement().textContent;
  expect(before).toContain('订单查询');
  const crumbs = screen.getByRole('navigation', { name: '面包屑' }).textContent;
  // Chosen allowed fallback: show the summary, and keep the current page on activation.
  await click(entries[0]!);
  await settled(server);
  expect(mainElement().textContent).toBe(before);
  expect(screen.getByRole('navigation', { name: '面包屑' }).textContent).toBe(crumbs);
  expect(server.users.log).toHaveLength(pageRequests);
}

async function multiplePlaceholderHit(
  hit: Hit,
  query: string,
  by: 'enter' | 'click',
): Promise<void> {
  const server = createServer({ items: [hit, USER], truncated: false });
  await mount(server);
  // The current page's own reads (the orders list once that page is live) settle before the
  // search; only those may reach the shared users/page fixture, and nothing may be added by the
  // search or by activating the hit.
  await settled(server);
  // BR-ID-46: besides the orders list, the orders page reads the latest sync record at most once
  // for its status bar (GET order-syncs, page=1 and page_size=1 only); nothing else may be read.
  const others = server.users.log.filter(
    (entry) => !(entry.method === 'GET' && entry.path === '/admin/v1/orders'),
  );
  expect(others.length).toBeLessThanOrEqual(1);
  expect(
    others.every(
      (entry) =>
        entry.method === 'GET' &&
        entry.path === '/admin/v1/order-syncs' &&
        entry.query['page'] === '1' &&
        entry.query['page_size'] === '1' &&
        Object.keys(entry.query).length === 2,
    ),
  ).toBe(true);
  const pageRequests = server.users.log.length;
  await submit(query);
  const entries = await options();
  expect(entries).toHaveLength(2);
  expect(entries[0]!.textContent).toContain(hit.summary);
  expect(entries[1]!.textContent).toContain(USER.summary);
  expect(entries[0]!.getAttribute('aria-selected')).toBe('true');
  expect((await listbox()).contains(document.activeElement)).toBe(true);
  const before = mainElement().textContent;
  const crumbs = screen.getByRole('navigation', { name: '面包屑' }).textContent;
  expect(before).toContain('订单查询');
  // Use the same allowed fallback as single hits: activation keeps the current page.
  if (by === 'enter') await key('{Enter}');
  else await click(entries[0]!);
  await settled(server);
  expect(mainElement().textContent).toBe(before);
  expect(screen.getByRole('navigation', { name: '面包屑' }).textContent).toBe(crumbs);
  expect(server.users.log).toHaveLength(pageRequests);
  expect(server.log).toHaveLength(1);
}

it(
  '[AC-F1-07h-RESULT#1] 单个 user 命中从订单页直接进入 users 菜单的真实用户详情',
  async () => {
    const server = createServer({ items: [USER], truncated: false });
    await mount(server, {
      permissionsProvider: async () => ({
        isSuper: false,
        permissions: ['order.view', 'user.lookup'],
      }),
    });
    await submit(UID);
    await userDetail();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(server.log).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#2] 单个 order 命中只显示候选摘要，点击保持原页',
  async () => {
    await placeholderHit(ORDER, ORDER_NUMBER);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#3] 单个 withdrawal 命中只显示候选摘要，点击保持原页',
  async () => {
    await placeholderHit(WITHDRAWAL, WITHDRAWAL_NUMBER);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#4] 多命中按服务端顺序显示类型与脱敏摘要，读屏名含 ID，首条高亮且焦点进入列表',
  async () => {
    // Covers all three labels, including the order/withdrawal followed by owner shape.
    const hits = [WITHDRAWAL, USER, ORDER, { ...USER, id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02' }];
    await mount(createServer({ items: hits, truncated: false }));
    await submit(WITHDRAWAL_NUMBER);
    const box = await listbox();
    const entries = await options();
    expect(entries).toHaveLength(hits.length);
    for (const [index, hit] of hits.entries()) {
      const name = `${LABELS[hit.type]} ${hit.id} ${hit.summary}`;
      expect(
        within(box).queryByRole('option', {
          name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        }),
      ).toBe(entries[index]);
      expect(entries[index]!.textContent).toContain(LABELS[hit.type]);
      expect(entries[index]!.textContent).toContain(hit.summary);
      expect(entries[index]!.getAttribute('aria-selected')).toBe(String(index === 0));
    }
    expect(box.contains(document.activeElement)).toBe(true);
    expect(box.textContent).toContain(FOOTER);
    expect(box.textContent).not.toContain('请输入更完整的号码');
    expect(box.textContent).not.toContain('13800005678');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#5] 上下键切换高亮，回车打开选中的 user 而不是第一条订单',
  async () => {
    const server = createServer();
    await mount(server);
    await submit(ORDER_NUMBER);
    const entries = await options();
    expect(entries[0]!.getAttribute('aria-selected')).toBe('true');
    await key('{ArrowDown}');
    await waitFor(() => expect(entries[1]!.getAttribute('aria-selected')).toBe('true'));
    expect(entries[0]!.getAttribute('aria-selected')).toBe('false');
    await key('{ArrowUp}');
    await waitFor(() => expect(entries[0]!.getAttribute('aria-selected')).toBe('true'));
    expect(entries[1]!.getAttribute('aria-selected')).toBe('false');
    await key('{ArrowDown}{Enter}');
    await userDetail();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(server.log).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#6] Esc 关闭候选并把焦点还给原输入框，不再发搜索请求',
  async () => {
    const { server } = await mount();
    await submit(ORDER_NUMBER);
    const box = await listbox();
    expect(box.contains(document.activeElement)).toBe(true);
    await key('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(document.activeElement).toBe(await input());
    expect((await input()).value).toContain(ORDER_NUMBER);
    expect(server.log).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#7] 点击多命中的 user 候选打开真实详情并关闭候选',
  async () => {
    await mount();
    await submit(ORDER_NUMBER);
    const entries = await options();
    expect(entries).toHaveLength(2);
    await click(entries[1]!);
    await userDetail();
    expect(screen.queryByRole('listbox')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#8] 服务端最多十条且 truncated 时全部显示并提示请输入更完整的号码',
  async () => {
    const hits: Hit[] = Array.from({ length: 10 }, (_, index) => ({
      type: 'order',
      id: `0199a3b4-5c6d-7e8f-9a0b-${String(index + 1).padStart(12, '0')}`,
      summary: `淘宝 订单样例 ${index + 1} · 已付款`,
    }));
    await mount(createServer({ items: hits, truncated: true }));
    await submit(ORDER_NUMBER);
    const entries = await options();
    expect(entries).toHaveLength(10);
    for (const [index, hit] of hits.entries())
      expect(entries[index]!.textContent).toContain(hit.summary);
    expect((await listbox()).textContent).toContain('请输入更完整的号码');
    expect((await listbox()).textContent).toContain(FOOTER);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#9] 查无和无搜索权限返回同样空结果，提示一致且没有权限字样',
  async () => {
    const server = createServer(EMPTY);
    await mount(server);
    await submit(UNKNOWN_NUMBER);
    const first = await noHitNotice();
    expect(first.textContent).toContain(`没有找到「${UNKNOWN_NUMBER}」`);
    expect(first.textContent).toContain(NO_HIT_FOOTER);
    expect(first.textContent).not.toContain('权限');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(first.textContent).not.toContain('请输入更完整的号码');
    const copy = first.textContent;
    cleanup();
    const denied = createServer(EMPTY);
    await mount(denied, {
      initialRoute: { menuId: 'content' },
      permissionsProvider: async () => ({ isSuper: false, permissions: ['content.article'] }),
    });
    await submit(UNKNOWN_NUMBER);
    expect((await noHitNotice()).textContent).toBe(copy);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(denied.log).toHaveLength(1);
    expect(document.querySelector('.ant-message-error')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#10] 第二次搜索无命中时清除上次候选，不留旧对象可点击',
  async () => {
    const { server } = await mount();
    await submit(ORDER_NUMBER);
    expect(await options()).toHaveLength(2);
    await key('{Escape}');
    server.result.items = [];
    await submit(UNKNOWN_NUMBER);
    const notice = await noHitNotice();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(notice.textContent).not.toContain(ORDER.id);
    expect(notice.textContent).not.toContain(USER.id);
    expect(server.log).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#11] 订单与所属用户多命中时，回车激活订单保持原页、不进入假详情',
  async () => {
    await multiplePlaceholderHit(ORDER, ORDER_NUMBER, 'enter');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#12] 订单与所属用户多命中时，点击订单保持原页、不进入假详情',
  async () => {
    await multiplePlaceholderHit(ORDER, ORDER_NUMBER, 'click');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#13] 提现单与所属用户多命中时，回车激活提现单保持原页、不进入假详情',
  async () => {
    await multiplePlaceholderHit(WITHDRAWAL, WITHDRAWAL_NUMBER, 'enter');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-RESULT#14] 提现单与所属用户多命中时，点击提现单保持原页、不进入假详情',
  async () => {
    await multiplePlaceholderHit(WITHDRAWAL, WITHDRAWAL_NUMBER, 'click');
  },
  FLOW_TIMEOUT,
);
