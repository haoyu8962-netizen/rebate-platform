import { waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import {
  LIST,
  createServer as createOrdersServer,
  manyRows,
  type Row,
  type Server,
} from '../admin-orders/orders-fixtures.ts';
import { button, click, mainElement, row } from '../admin-orders/orders-helpers.ts';
import { detailOnSecondPage } from '../admin-orders-standard/kit.ts';
import {
  SYNCS,
  createServer as createSyncServer,
  failure,
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
export const DRAWER_ORDERS = [...detailOnSecondPage(), ...manyRows().slice(51, 53)];

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

export async function loadedDrawer(number: string): Promise<HTMLElement> {
  await waitFor(() => {
    const dialogs = orderDialogs();
    expect(dialogs, '订单详情抽屉').toHaveLength(1);
    expect(dialogs[0]!.textContent).toContain(number);
  });
  const dialog = orderDialogs()[0]!;
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

export function expectInitialSync(server: Server): void {
  const syncRequests = server.log.filter(
    ({ path }) => path === SYNCS || path.startsWith(`${SYNCS}/`),
  );
  expect(syncRequests.map(({ method, path, query }) => ({ method, path, query }))).toEqual([
    { method: 'GET', path: SYNCS, query: { page: '1', page_size: '1' } },
  ]);
}

export function expectSummaryAboveList(texts: readonly (string | RegExp)[]): void {
  const main = mainElement();
  const table = within(main).queryByRole('table');
  expect(table).not.toBeNull();
  const summary = Array.from(main.querySelectorAll<HTMLElement>('*')).find((element) => {
    const text = element.textContent ?? '';
    return (
      !element.contains(table) &&
      (element.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
      texts.every((part) => (typeof part === 'string' ? text.includes(part) : part.test(text)))
    );
  });
  expect(summary, `列表上方的同步状态包含 ${texts.join('、')}`).toBeDefined();
}
