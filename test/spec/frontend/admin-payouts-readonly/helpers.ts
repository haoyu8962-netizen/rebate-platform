import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  click,
  fieldValues,
  labelled,
  main,
  openDialogs,
  section,
  settle,
  squash,
  textOf,
} from '../admin-withdrawals/helpers.ts';
import {
  BASE_URL,
  allowedHere,
  snapshot,
  type Grants,
  type PayoutServer,
  type RequestLog,
} from './fixtures.ts';

// The read-only payout tabs are reached only through the real shell (createAdminShell, menu id
// `withdrawals`): no page module is imported, so a missing tab is an assertion failure, not an
// import error. Only the frozen pure helpers of admin-withdrawals are reused (its mount and its
// request guard are not: they forbid the two payout reads of this task).
export { click, labelled, main, openDialogs, settle, squash, textOf };

/** Per-test timeout of a flow with one mount (antd's first render of a file is slow in jsdom). */
export const FLOW_TIMEOUT = 60_000;
/** Per-test timeout of a flow that mounts the page several times. */
export const MULTI_TIMEOUT = 150_000;

export const TAB = { review: '审核列表', queue: '打款队列', unknown: '结果待确认' } as const;
export const SUB_TAB = { all: '全部', paying: '打款中', approved: '待执行' } as const;
/** Row entries (exact accessible names, spaces ignored). */
export const ENTRY = { attempts: '打款记录', detail: '详情', handle: '处置' } as const;

/** The no-permission notice (10403). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** A failed read. */
export const LOAD_FAILED = /失败|出错|错误/;
/** An empty list. */
export const EMPTY = /暂无|没有.*(?:提现|数据|记录)/;
export const RETRY = /重试/;
/**
 * Write entries of the later payout tasks (F1-08bb execute, F1-08bc enter balances, F1-08bd
 * lift pauses) and of the detail page: none may be on these tabs, not even disabled.
 */
export const WRITE =
  /^(?:执行所选|执行打款|录入企业支付宝余额|录入运营账户余额|录入余额|暂停队列|解除暂停|解除通道暂停|恢复队列|批量手动打款|批量自动打款|一键组批|手动成功|立即查询|人工处置|撤销微信转账)/;

/**
 * Field labels of the 打款队列 cards and of the 打款记录 drawer (whole labels, spaces ignored, an
 * optional 「（元）」 and colon), each shown beside its own value. The card titles (企业支付宝可用余额,
 * 垫资水位, 今日已发出 / 单日限额, 队列状态) are not field labels.
 */
export const FIELD = {
  /** W of the enterprise Alipay channel (watermark.available_fen), or 未录入. */
  available: labelled('可用余额W|可用余额'),
  /** t_W (watermark.measured_at). */
  measuredAt: labelled('取数时间'),
  /** P of the enterprise Alipay channel (forecast_withdrawal_fen). */
  forecast: labelled('预计提现P|预计提现'),
  /** The conclusion of W against P (water_level), only when there is one. */
  level: labelled('水位结论'),
  /** watermark_usable_bp as a percentage. */
  usable: labelled('可用比例'),
  dailySent: labelled('今日已发出'),
  dailyCap: labelled('单日限额'),
  singleCap: labelled('单笔上限'),
  /** payout_enabled. */
  payout: labelled('打款开关'),
  /** queue_paused. */
  queue: labelled('队列运行状态|队列运行'),
  /** A channel card: enabled. */
  enabled: labelled('开通状态|开通'),
  /** A channel card: paused. */
  paused: labelled('暂停状态|暂停'),
  /** The drawer's summary. */
  number: labelled('提现单号'),
  net: labelled('实付金额'),
  status: labelled('提现状态'),
} as const;

/** The titles of the three channel cards. */
export const CHANNEL_TITLE = {
  alipay: /^企业支付宝$/,
  bank_card: /^银行卡$/,
  wechat: /^微信零钱$/,
} as const;

/** Column titles (spaces removed). */
export const COLUMN = {
  net: /^实付/,
  status: /^状态$/,
  firstTransfer: /^首次转账/,
  latestQuery: /^最近一次查询/,
  time: /^时间$/,
  kind: /^类型$/,
  result: /^结果$/,
  code: /^响应码/,
} as const;

/** The page_size of the first of `reads` (a positive integer up to 200, as the contract takes). */
export function pageSizeOf(reads: readonly RequestLog[]): string {
  const size = reads[0]?.query['page_size'];
  expect(typeof size, 'the read sends page_size').toBe('string');
  expect(size, 'page_size is a positive integer').toMatch(/^[1-9][0-9]*$/);
  expect(Number(size), 'page_size up to 200').toBeLessThanOrEqual(200);
  return size!;
}

/** The queries of `reads`, ordered by their status (so two reads of one view compare whole). */
export function queriesByStatus(reads: readonly RequestLog[]): Record<string, string>[] {
  const queries = reads.map((read) => read.query);
  return queries.sort((a, b) => (a['status'] ?? '').localeCompare(b['status'] ?? ''));
}

/** The text (spaces removed) of the first level-4 heading of the main area (a detail's number). */
export function pageHeading(): string {
  return squash(main().querySelector('h4')?.textContent);
}

export function everyGrant(points: Grants): PermissionSnapshot {
  return snapshot(points);
}
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- mounting and the request guard ----------------------------------------------------------

const mounted: {
  readonly server: PayoutServer;
  readonly direct: { readonly mock: { readonly calls: readonly unknown[] } };
}[] = [];

afterEach(() => {
  const current = mounted.splice(0);
  try {
    for (const { server, direct } of current) {
      expect(direct.mock.calls.length, 'no direct fetch').toBe(0);
      expect(
        server.log.filter((request) => !allowedHere(request)).map((r) => `${r.method} ${r.path}`),
        'only the allowed GET reads (withdrawals, payout overview, unknown payouts, common reads)',
      ).toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

/** Mounts the real admin shell on /withdrawals over `server` for an account with `permissions`. */
export async function mount(server: PayoutServer, permissions: PermissionSnapshot): Promise<void> {
  installMediaQuery();
  const direct = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', direct);
  mounted.push({ server, direct });
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'withdrawals' },
        permissionsProvider: async () => permissions,
        account: { username: 'fin-yi', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          ['getToken']: () => 'example-admin-token',
          onError: vi.fn(),
        }),
      }),
    );
  });
  await settle();
}

export async function settled(server: PayoutServer): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await settle();
}

// ---- visibility, tabs and panels -----------------------------------------------------------

/** Not inside a hidden element, an inactive tab pane or a closed drawer. */
export function isShown(node: Element): boolean {
  for (let current: Element | null = node; current !== null; current = current.parentElement) {
    if (current instanceof HTMLElement && (current.hidden || current.style.display === 'none'))
      return false;
    if (current.classList.contains('ant-tabs-tabpane-hidden')) return false;
    if (current.classList.contains('ant-drawer') && !current.classList.contains('ant-drawer-open'))
      return false;
  }
  return true;
}

/** Tabs of `root` named exactly `name` (spaces ignored). */
export function tabsIn(root: HTMLElement, name: string): HTMLElement[] {
  return within(root)
    .queryAllByRole('tab', { hidden: true })
    .filter((tab) => squash(tab.textContent) === name);
}

/** The names of the page's own tabs: the tab list holding 「审核列表」. */
export function pageTabNames(): string[] {
  const review = tabsIn(main(), TAB.review);
  expect(review, `one tab ${TAB.review}`).toHaveLength(1);
  const list = review[0]!.closest<HTMLElement>('[role="tablist"]');
  expect(list, 'the tab list of the page').not.toBeNull();
  return within(list!)
    .queryAllByRole('tab', { hidden: true })
    .map((tab) => squash(tab.textContent));
}

/** The tab panel a tab controls. */
export async function panelOf(tab: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const id = tab.getAttribute('aria-controls');
    const panel = id === null || id === '' ? null : document.getElementById(id);
    expect(panel, `the panel of the tab ${squash(tab.textContent)}`).not.toBeNull();
    return panel!;
  });
}

/** Selects the one tab named `name` inside `root` (when it is not selected yet). */
export async function selectTab(root: HTMLElement, name: string): Promise<HTMLElement> {
  await waitFor(() => expect(tabsIn(root, name), `one tab ${name}`).toHaveLength(1));
  const tab = tabsIn(root, name)[0]!;
  if (tab.getAttribute('aria-selected') !== 'true') await click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected'), `${name} selected`).toBe('true'));
  return tab;
}

/** Opens a page tab (打款队列 / 结果待确认 / 审核列表) and returns its panel. */
export async function openTab(name: string): Promise<HTMLElement> {
  return panelOf(await selectTab(main(), name));
}

// ---- tables --------------------------------------------------------------------------------

export interface Grid {
  /** Column titles of the header row (spaces removed). */
  readonly titles: readonly string[];
  /** The data rows shown. */
  readonly rows: readonly HTMLElement[];
}

function gridOf(table: HTMLElement): Grid {
  const header = table.querySelector('thead tr');
  const titles = header === null ? [] : Array.from(header.children, (c) => squash(c.textContent));
  const antd = table.classList.contains('ant-table');
  const rows = Array.from(
    table.querySelectorAll<HTMLElement>(antd ? 'tbody tr.ant-table-row' : 'tbody tr'),
  );
  return { titles, rows: rows.filter(isShown) };
}

/** The shown tables of `root` (antd Tables, else plain tables). */
export function grids(root: HTMLElement): Grid[] {
  const antd = Array.from(root.querySelectorAll<HTMLElement>('.ant-table')).filter(isShown);
  const plain = Array.from(root.querySelectorAll<HTMLElement>('table')).filter(isShown);
  return (antd.length > 0 ? antd : plain).map(gridOf);
}

/** The one shown table of `root` with a column titled like `column`. */
export function gridWith(root: HTMLElement, column: RegExp): Grid {
  const found = grids(root).filter((grid) => grid.titles.some((title) => column.test(title)));
  expect(found.length, `one table with a column ${String(column)}`).toBe(1);
  return found[0]!;
}

const NUMBER = /W\d{14}/g;

/** The withdrawal numbers of the shown table rows of `root`, row by row (one per row). */
export function numbersIn(root: HTMLElement): string[] {
  return grids(root).flatMap((grid) =>
    grid.rows.flatMap((row) => [...new Set(textOf(row).match(NUMBER) ?? [])].slice(0, 1)),
  );
}

/** Waits until the shown rows of `root` list exactly `numbers` (in that order). */
export async function listed(root: HTMLElement, numbers: readonly string[]): Promise<void> {
  await waitFor(() => expect(numbersIn(root)).toEqual(numbers));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one row of `grid` for the withdrawal number `number`. */
export function rowIn(grid: Grid, number: string): HTMLElement {
  const word = new RegExp(`(?<![A-Za-z0-9_])${escape(number)}(?![A-Za-z0-9_])`);
  const found = grid.rows.filter((row) => word.test(textOf(row)));
  expect(found, `one row for ${number}`).toHaveLength(1);
  return found[0]!;
}

/** The text (spaces removed) of `row`'s cell under the one column of `grid` titled like `title`. */
export function cellIn(grid: Grid, row: HTMLElement, title: RegExp): string {
  const indexes = grid.titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column ${String(title)} among ${grid.titles.join(' | ')}`).toHaveLength(1);
  const cell = row.children.item(indexes[0]!);
  expect(cell, `the cell ${String(title)}`).not.toBeNull();
  return squash(textOf(cell!));
}

/** Every row of `grid` as its cells under `columns` (spaces removed), in row order. */
export function cellsOf(grid: Grid, columns: readonly RegExp[]): string[][] {
  return grid.rows.map((row) => columns.map((title) => cellIn(grid, row, title)));
}

/** Clicks the page-number control for page 2 among the shown controls of `root`. */
export async function pageTwo(root: HTMLElement): Promise<void> {
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[title="2"], [title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    ),
  ).filter(isShown);
  expect(controls.length, 'a pagination control for page 2').toBeGreaterThan(0);
  await click(controls[0]!);
}

// ---- labelled fields and sections ----------------------------------------------------------

/** The values (spaces removed) of every field of `root` labelled `label` (a whole label). */
export function values(root: HTMLElement, label: RegExp): string[] {
  return fieldValues(root, label).map((text) => squash(text));
}

/** The part of `root` owned by the card / section titled `title`. */
export function card(root: HTMLElement, title: RegExp): HTMLElement {
  return section(root, title);
}

/** Shown elements of `root` whose own whole text (spaces removed) is one of `texts`. */
export function exactTexts(root: HTMLElement, texts: readonly string[]): string[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
    (node) => texts.includes(squash(node.textContent)) && isShown(node),
  );
  const inner = nodes.filter(
    (node) => !nodes.some((other) => other !== node && node.contains(other)),
  );
  return inner.map((node) => squash(node.textContent));
}

// ---- entries -------------------------------------------------------------------------------

const PRESSABLE = 'button, a, [role="button"], [role="link"], [role="menuitem"]';

function nameOf(node: HTMLElement): string {
  return squash(node.textContent) || squash(node.getAttribute('aria-label'));
}

/** Shown buttons and links of `root` named exactly `name` (spaces ignored). */
export function entries(root: HTMLElement, name: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(PRESSABLE))
    .filter(isShown)
    .filter((node) => nameOf(node) === name || squash(node.getAttribute('aria-label')) === name);
}

/** The one usable entry of `root` named `name`. */
export function entry(root: HTMLElement, name: string): HTMLElement {
  const found = entries(root, name);
  expect(found, `one entry ${name}`).toHaveLength(1);
  const node = found[0]!;
  expect(
    node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true',
    `${name} usable`,
  ).toBe(false);
  return node;
}

/** Names of the write entries of `root`, shown or not, usable or not. */
export function writeEntries(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(PRESSABLE))
    .filter(
      (node) => WRITE.test(nameOf(node)) || WRITE.test(squash(node.getAttribute('aria-label'))),
    )
    .map(nameOf);
}

// ---- states --------------------------------------------------------------------------------

/** A loading indicator inside `root`. */
export function loadingIn(root: HTMLElement): boolean {
  const marks = root.querySelectorAll(
    '[role="status"], [aria-busy="true"], .ant-spin-spinning, .ant-skeleton',
  );
  return marks.length > 0 || /加载中|正在加载|正在读取/.test(textOf(root));
}

/** The one open (shown) dialog or drawer. */
export async function openDialog(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = openDialogs();
    expect(found, 'one open drawer').toHaveLength(1);
    return found[0]!;
  });
}
