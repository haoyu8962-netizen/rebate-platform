import { waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import {
  LIST,
  createServer as createOrdersServer,
  detail,
  manyRows,
  ok,
  type Row,
  type Server,
} from '../admin-orders/orders-fixtures.ts';
import { button, click, mainElement, row } from '../admin-orders/orders-helpers.ts';
import {
  SYNCS,
  createServer as createSyncServer,
  failure,
  syncRecords,
  type ServerOptions,
} from '../admin-orders-sync/fixtures.ts';

export const DEFAULT_HEADINGS = [
  '订单号',
  '平台',
  '商品',
  '用户',
  '付款时间',
  '付款金额',
  '联盟佣金',
  '返利状态',
  '操作',
];
export const OPTIONAL_HEADINGS = ['平台状态', '标记'];

export function columnHeadings(): string[] {
  return within(mainElement())
    .queryAllByRole('columnheader')
    .map((heading) => heading.textContent?.trim() ?? '');
}

export async function toggleColumn(name: string, checked: boolean): Promise<void> {
  const controls = within(mainElement()).queryAllByRole('checkbox', { name });
  expect(controls, `列设置中的「${name}」`).toHaveLength(1);
  expect(controls[0]).toHaveProperty('checked', checked);
  await click(controls[0]!);
}

export async function saveHiddenCommission(): Promise<string> {
  await click(button(mainElement(), /^列设置$/));
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  try {
    await toggleColumn('联盟佣金', true);
    expect(columnHeadings()).not.toContain('联盟佣金');
    const keys = new Set(storage.mock.calls.map(([key]) => key));
    expect(keys.size).toBe(1);
    const [key] = keys;
    expect(window.localStorage.getItem(key!)).not.toBeNull();
    return key!;
  } finally {
    storage.mockRestore();
  }
}

export const SECOND_PAGE_QUERY = {
  platform: 'pdd',
  rebate_status: 'CREDITED',
  page: '2',
  page_size: '50',
};
export const SECOND_PAGE_ROUTE = `/orders?${new URLSearchParams(SECOND_PAGE_QUERY)}`;
const [deepLinkedOrder, ...otherOrders] = manyRows();
const drawerOrders = [...otherOrders.slice(0, 51), deepLinkedOrder!, otherOrders[51]!];
export const SECOND_PAGE_ORDERS = drawerOrders.slice(50);
export const DRAWER_DETAILS = SECOND_PAGE_ORDERS.slice(1).map((order, index) =>
  detail({ ...order, raw_item_id: `item-drawer-${index + 1}` }),
);

export function createDrawerServer(): Server {
  const server = createPageServer(drawerOrders);
  for (const order of DRAWER_DETAILS) {
    server.once('GET', `${LIST}/${order.order_id}`, () => ok(order));
  }
  return server;
}

export function addressQuery(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

export function detailReads(server: Server): string[] {
  return server
    .requests('GET')
    .map(({ path }) => path)
    .filter((path) => path.startsWith(`${LIST}/`));
}

export function viewButton(number: string): HTMLElement {
  const matches = within(row(number)).queryAllByRole('button', {
    name: new RegExp(`(?=.*查看)(?=.*${number})`),
  });
  expect(matches, `订单 ${number} 的「查看」按钮`).toHaveLength(1);
  return matches[0]!;
}

export function orderDialogs(): HTMLElement[] {
  return within(document.body).queryAllByRole('dialog');
}

export async function loadedDrawer(number: string, rawItemId: string): Promise<HTMLElement> {
  const dialog = await waitFor(() => {
    const dialogs = orderDialogs();
    expect(dialogs, '订单详情抽屉').toHaveLength(1);
    const shown = dialogs[0]!;
    expect(shown.textContent).toContain(number);
    expect(shown.textContent, '详情接口返回的商品 ID').toContain(rawItemId);
    return shown;
  });
  expect(dialog.closest('.ant-drawer-right')).not.toBeNull();
  return dialog;
}

export const SYNC_ERROR_MESSAGE = '同步记录接口暂不可用';

/** Dispatch through both existing fixtures while keeping the order helper's request interface. */
export function createPageServer(orders?: Row[], options?: ServerOptions): Server {
  const orderServer = createOrdersServer(orders);
  const syncServer = createSyncServer(options);
  const fetch: typeof globalThis.fetch = (input, init) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    const syncPath = pathname === SYNCS || pathname.startsWith(`${SYNCS}/`);
    return (syncPath ? syncServer : orderServer).fetch(input, init);
  };
  return {
    ...orderServer,
    fetch,
    get log() {
      return [...orderServer.log, ...syncServer.log];
    },
    get pending() {
      return orderServer.pending + syncServer.pending;
    },
    requests(method, path) {
      return [...orderServer.requests(method, path), ...syncServer.requests(method, path)];
    },
    once(method, path, reply) {
      const syncPath = path === SYNCS || path.startsWith(`${SYNCS}/`);
      (syncPath ? syncServer : orderServer).once(method, path, reply);
    },
  };
}

export function serverWithFailedSync(): Server {
  const server = createPageServer();
  server.once('GET', SYNCS, () => failure(50001, undefined, SYNC_ERROR_MESSAGE));
  return server;
}

export function serverWithKuaishouSync(): Server {
  const [latest] = syncRecords();
  return createPageServer(undefined, {
    records: [
      { ...latest!, platform: 'kuaishou', status: 'running', created_at: '2026-10-22T16:15:00Z' },
    ],
  });
}

export function expectInitialSync(server: Server): void {
  const syncRequests = server.log.filter(
    ({ path }) => path === SYNCS || path.startsWith(`${SYNCS}/`),
  );
  expect(syncRequests.map(({ method, path, query }) => ({ method, path, query }))).toEqual([
    { method: 'GET', path: SYNCS, query: { page: '1', page_size: '1' } },
  ]);
}

export function expectSummaryAboveList(texts: readonly (string | RegExp)[]): HTMLElement {
  const main = mainElement();
  const table = within(main).queryByRole('table');
  expect(table).not.toBeNull();
  // Tab labels and filter options cannot supply the sync record's display name.
  const filters = '[role="tablist"], [role="tab"], [role="combobox"]';
  const summary = Array.from(main.querySelectorAll<HTMLElement>('*'))
    .reverse()
    .find((element) => {
      const text = element.textContent ?? '';
      return (
        !element.contains(table) &&
        (element.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
        element.closest(filters) === null &&
        element.querySelector(filters) === null &&
        texts.every((part) => (typeof part === 'string' ? text.includes(part) : part.test(text)))
      );
    });
  expect(summary, `列表上方的同步状态包含 ${texts.join('、')}`).toBeDefined();
  return summary!;
}
