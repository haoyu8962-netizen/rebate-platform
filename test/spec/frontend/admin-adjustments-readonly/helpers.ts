import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  BASE_URL,
  COLUMN,
  FIELD,
  MENU_ID,
  REF_COLUMN,
  TEXT,
  VERIFY,
  createServer,
  snapshot as snapshotOf,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `adjustments`): no
// import of a page module, so a missing page is an assertion failure, not an import error. What
// this task decides about the page (texts in fixtures.ts TEXT / COLUMN / FIELD):
// - two tabs (antd Tabs, role="tab"): 「调账单」 for fund.adjust or fund.view, 「坏账核销」 for
//   fund.writeoff or fund.view; a tab whose point is missing is not shown; the 调账单 tab is the
//   one open first when shown. A count may follow a tab name.
// - each tab is a table (column titles exact) with its own empty / failed notice; the 调账单 tab
//   has the filter 状态 / 原因 / 用户 ID with 【查询】【重置】 and paging.
// - 【详情】 of a row opens one drawer titled 「调账单详情」: label / value items (a label element
//   whose whole text is the label, its value the next element after it, e.g. antd Descriptions),
//   the linked documents table (单据类型 / 单据号), the 「已红冲」 mark as an element of its own
//   (not inside the 状态 or 红冲单 value), and the reversal form as a link in 红冲单 whose text
//   is its adjust_id.
// Every compared text has its whitespace collapsed and trimmed. antd's first Table / Drawer /
// Select render of a file is slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  /** The address without its leading slash; defaults to the page (adjustments). */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 调账与核销 over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const onError = vi.fn();
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    ['getToken']: () => 'example-admin-token',
    onError,
  });
  const permissions = options.snapshot ?? snapshotOf(server.permissions);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: options.route ?? MENU_ID },
        permissionsProvider: async () => permissions,
        account: { username: 'fin-adjust', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider,
      }),
    );
  });
  await settle();
  return { server, directFetch, onError };
}

// ---- basics --------------------------------------------------------------------------------

/** Whitespace collapsed to one space and trimmed. */
export function norm(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
/** Whitespace removed (button names: antd may space two-character labels). */
export function compact(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
/** The shell's main landmark (looked up without the accessibility filter). */
export function main(): HTMLElement {
  const found = document.querySelector<HTMLElement>('main');
  expect(found, 'the shell renders its main landmark').not.toBeNull();
  return found!;
}
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await settle();
}
export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
}

function hiddenNode(node: Element): boolean {
  if (node instanceof HTMLElement && node.style.display === 'none') return true;
  if (node instanceof HTMLElement && node.hidden) return true;
  // A closed antd Drawer may stay mounted (rc-drawer drops ant-drawer-open).
  if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
    return true;
  return (
    node.classList.contains('ant-tabs-tabpane-hidden') ||
    node.classList.contains('ant-popover-hidden')
  );
}
function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement)
    if (hiddenNode(node)) return false;
  return true;
}

/** Some visible element of `root` has exactly the text `text`. */
export function hasText(root: HTMLElement, text: string): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('*')).some(
    (node) => visible(node) && norm(node.textContent) === text,
  );
}

/** Sidebar links named exactly 「调账与核销」. */
export function menuLinks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a[href]')).filter(
    (node) => norm(node.textContent) === TEXT.menu,
  );
}

// ---- tabs and panels -----------------------------------------------------------------------

const COUNT_SUFFIX = /(?:\d+|[（(]\d+[)）])$/;

function tabNodes(): HTMLElement[] {
  return Array.from(main().querySelectorAll<HTMLElement>('[role="tab"]'));
}
function tabName(node: HTMLElement): string {
  return compact(node.textContent).replace(COUNT_SUFFIX, '');
}
/** Names of the page's tabs in order (a trailing count left out). */
export function tabNames(): string[] {
  return tabNodes().map(tabName);
}
/** Opens the tab named `name`. */
export async function openTab(name: string): Promise<void> {
  await waitFor(() => expect(tabNames().filter((one) => one === name)).toHaveLength(1));
  const node = tabNodes().find((one) => tabName(one) === name);
  await click(node!);
  await settle();
}
function hiddenPanel(node: HTMLElement): boolean {
  if (node.getAttribute('aria-hidden') === 'true' || hiddenNode(node)) return true;
  return (
    node.classList.contains('ant-tabs-tabpane') &&
    !node.classList.contains('ant-tabs-tabpane-active')
  );
}
/** The one shown tab panel of the page. */
export function panel(): HTMLElement {
  const shown = Array.from(main().querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter(
    (node) => !hiddenPanel(node),
  );
  expect(shown, 'one shown tab panel').toHaveLength(1);
  return shown[0]!;
}

// ---- tables --------------------------------------------------------------------------------

export interface TableRow {
  readonly element: HTMLElement;
  /** Cell text by column title. */
  readonly cells: Readonly<Record<string, string>>;
}
export type Cells = Record<string, string | undefined>;

function headerCells(root: HTMLElement, title: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('thead th')).filter(
    (node) => visible(node) && norm(node.textContent) === title,
  );
}
function dataRow(node: HTMLElement): boolean {
  return (
    !node.classList.contains('ant-table-measure-row') &&
    !node.classList.contains('ant-table-placeholder') &&
    node.getAttribute('aria-hidden') !== 'true' &&
    node.querySelector('td') !== null
  );
}
/** A table of `root` has a column titled exactly `title`. */
export function hasColumn(root: HTMLElement, title: string): boolean {
  return headerCells(root, title).length > 0;
}
/** The body rows of the one table of `root` with a column titled `title`. */
export function tableRows(root: HTMLElement, title: string): TableRow[] {
  const heads = headerCells(root, title);
  expect(heads, `one column titled ${title}`).toHaveLength(1);
  const head = heads[0]!;
  const titles = Array.from(head.parentElement!.children, (cell) => norm(cell.textContent));
  const container = head.closest<HTMLElement>('.ant-table') ?? head.closest<HTMLElement>('table');
  expect(container, `the table of ${title}`).not.toBeNull();
  const rows = Array.from(container!.querySelectorAll<HTMLElement>('tbody tr')).filter(dataRow);
  return rows.map((element) => {
    const cells: Record<string, string> = {};
    Array.from(element.children).forEach((cell, index) => {
      const name = titles[index];
      if (name !== undefined && name !== '') cells[name] = norm(cell.textContent);
    });
    return { element, cells };
  });
}
/** The cells of `row` under the titles `titles` only. */
export function pick(row: TableRow, titles: readonly string[]): Cells {
  const picked: Cells = {};
  for (const title of titles) picked[title] = row.cells[title];
  return picked;
}
/** The texts of the column `title` of the table of `root`, in row order. */
export function column(root: HTMLElement, title: string): (string | undefined)[] {
  return tableRows(root, title).map((row) => row.cells[title]);
}
/** The one row of the table of `root` whose cell under `title` is `value`. */
export function rowWith(root: HTMLElement, title: string, value: string): TableRow {
  const found = tableRows(root, title).filter((row) => row.cells[title] === value);
  expect(found, `one row with ${title} ${value}`).toHaveLength(1);
  return found[0]!;
}
/** Body rows of every table in `root` (0 when no table is shown). */
export function dataRowCount(root: HTMLElement): number {
  return Array.from(root.querySelectorAll<HTMLElement>('tbody tr')).filter(dataRow).length;
}
/** Waits until the column `title` of the shown panel reads exactly `expected`. */
export async function waitColumn(title: string, expected: readonly string[]): Promise<void> {
  await waitFor(() => expect(column(panel(), title)).toEqual(expected));
}

// ---- buttons -------------------------------------------------------------------------------

export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('[aria-disabled="true"], fieldset[disabled]') !== null
  );
}
function named(node: HTMLElement, name: string): boolean {
  if (compact(node.textContent) === compact(name)) return true;
  return norm(node.getAttribute('aria-label')) === name;
}
/** Visible buttons and links of `root` named exactly `name` (text without spaces, or aria-label). */
export function buttons(root: HTMLElement, name: string): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]');
  return Array.from(all).filter((node) => visible(node) && named(node, name));
}
/** Usable (not disabled) buttons of `root` named `name`. */
export function usable(root: HTMLElement, name: string): HTMLElement[] {
  return buttons(root, name).filter((node) => !isDisabled(node));
}
/** The one usable button of `root` named `name`. */
export function button(root: HTMLElement, name: string): HTMLElement {
  const found = usable(root, name);
  expect(found, `one usable button ${name}`).toHaveLength(1);
  return found[0]!;
}

// ---- paging --------------------------------------------------------------------------------

const NEXT =
  '.ant-pagination-next, [title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]';
/** Clicks 「下一页」 of the pagination in `root`. */
export async function nextPage(root: HTMLElement): Promise<void> {
  const found = Array.from(root.querySelectorAll<HTMLElement>(NEXT)).filter(visible);
  expect(found.length, 'a 下一页 control').toBeGreaterThan(0);
  await click(found[0]!);
  await settle();
}

// ---- dialogs and drawers -------------------------------------------------------------------

function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
}
/** Candidate titles of a dialog (aria-labelledby, aria-label, antd titles), each normalised. */
function titlesOf(node: HTMLElement): string[] {
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const texts = ids.map((id) => {
    const inside = node.querySelector(`[id="${id}"]`);
    return (inside ?? document.getElementById(id))?.textContent ?? '';
  });
  texts.push(node.getAttribute('aria-label') ?? '');
  for (const title of Array.from(node.querySelectorAll('.ant-modal-title, .ant-drawer-title')))
    texts.push(title.textContent ?? '');
  return texts.map(norm);
}
function innermost(nodes: readonly HTMLElement[]): HTMLElement[] {
  return nodes.filter((node) => !nodes.some((other) => other !== node && node.contains(other)));
}
/** Open detail drawers (dialogs titled 「调账单详情」). */
export function detailDrawers(): HTMLElement[] {
  return innermost(openDialogs().filter((node) => titlesOf(node).includes(TEXT.detailTitle)));
}
/** The one open detail drawer. */
export function drawer(): HTMLElement {
  const found = detailDrawers();
  expect(found, 'one open drawer titled 调账单详情').toHaveLength(1);
  return found[0]!;
}
const STEP_UP_TITLE = /二次验证|动态码|短信验证/;
/** A step-up dialog is open (none on this page). */
export function stepUpOpen(): boolean {
  const titles = openDialogs().flatMap(titlesOf);
  return titles.some((title) => STEP_UP_TITLE.test(title));
}

// ---- labelled items of the detail ----------------------------------------------------------

function labelNodes(root: HTMLElement, label: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
    (node) =>
      node.closest('thead') === null &&
      visible(node) &&
      norm(node.textContent) === label &&
      !Array.from(node.children).some((child) => norm(child.textContent) === label),
  );
}
/** The value element of the one item labelled `label` in `root`. */
export function fieldNode(root: HTMLElement, label: string): HTMLElement {
  const labels = labelNodes(root, label);
  expect(labels, `one item labelled ${label}`).toHaveLength(1);
  let current: Element | null = labels[0]!;
  while (current !== null && current !== root) {
    const next = current.nextElementSibling;
    if (next instanceof HTMLElement) return next;
    current = current.parentElement;
  }
  return expect.unreachable(`a value after the label ${label}`);
}
/** The value of the one item labelled `label` in `root`. */
export function fieldValue(root: HTMLElement, label: string): string {
  return norm(fieldNode(root, label).textContent);
}
/** The values of the items labelled `labels` in `root`. */
export function fields(root: HTMLElement, labels: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const label of labels) values[label] = norm(fieldNode(root, label).textContent);
  return values;
}
/** The linked documents of the detail as [单据类型, 单据号] (empty when no table is shown). */
export function refRows(root: HTMLElement): (string | undefined)[][] {
  if (!hasColumn(root, REF_COLUMN.type)) return [];
  return tableRows(root, REF_COLUMN.type).map((row) => {
    return [row.cells[REF_COLUMN.type], row.cells[REF_COLUMN.id]];
  });
}

/** Opens 【详情】 of the list row `adjustId` and waits for its read; returns the drawer. */
export async function openDetail(server: Server, adjustId: string): Promise<HTMLElement> {
  const reads = server.detailReads(adjustId).length;
  const row = rowWith(panel(), COLUMN.id, adjustId);
  await click(button(row.element, TEXT.detailEntry));
  await waitFor(() => expect(server.detailReads(adjustId)).toHaveLength(reads + 1));
  await settled(server);
  await waitFor(() => expect(detailDrawers()).toHaveLength(1));
  await waitFor(() => expect(fieldValue(drawer(), FIELD.id)).toBe(adjustId));
  return drawer();
}

// ---- filter fields -------------------------------------------------------------------------

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
/** The one text input labelled (or with the placeholder) exactly `label` in `root`. */
export function textbox(root: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelled = within(root).queryAllByLabelText(label);
  const placeholders = within(root).queryAllByPlaceholderText(label);
  const found = [...new Set([...labelled, ...placeholders])].filter(isTextField);
  expect(found, `one input labelled ${label}`).toHaveLength(1);
  return found[0]!;
}
export async function fill(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  });
}

function dropdownOf(combo: HTMLElement): HTMLElement | null {
  const id = combo.getAttribute('aria-controls') ?? combo.getAttribute('aria-owns');
  const list = id === null || id === '' ? null : document.getElementById(id);
  return list?.closest<HTMLElement>('.ant-select-dropdown') ?? null;
}
function optionNodes(combo: HTMLElement): HTMLElement[] {
  const own = dropdownOf(combo);
  const scopes =
    own !== null
      ? [own]
      : Array.from(
          document.querySelectorAll<HTMLElement>(
            '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
          ),
        );
  // rc-select's virtual accessibility mirror is not a click target: use the visible contents.
  return scopes.flatMap((node) =>
    Array.from(node.querySelectorAll<HTMLElement>('.ant-select-item-option-content')),
  );
}
/** The one select (antd Select or native) named exactly `label` inside `root`. */
export function combobox(root: HTMLElement, label: string): HTMLElement {
  const combos = within(root).queryAllByRole('combobox', { name: label });
  expect(combos, `one select labelled ${label}`).toHaveLength(1);
  return combos[0]!;
}
/**
 * Chooses the option whose whole text is `option` in the select labelled `label` inside `root`;
 * returns the texts of every option offered.
 */
export async function choose(root: HTMLElement, label: string, option: string): Promise<string[]> {
  const combo = combobox(root, label);
  if (combo instanceof HTMLSelectElement) {
    const offered = Array.from(combo.options);
    const target = offered.find((item) => norm(item.text) === option);
    expect(target, `option ${option} of ${label}`).toBeDefined();
    await act(async () => {
      fireEvent.change(combo, { target: { value: target!.value } });
    });
    return offered.map((item) => norm(item.text)).filter((text) => text !== '');
  }
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  let target: HTMLElement | undefined;
  let offered: string[] = [];
  await waitFor(() => {
    const nodes = optionNodes(combo);
    offered = nodes.map((node) => norm(node.textContent));
    target = nodes.find((node) => norm(node.textContent) === option);
    expect(target, `option ${option} of ${label}`).toBeDefined();
  });
  await click(target!);
  await settle();
  return offered;
}
/** Presses 【查询】 of the shown panel. */
export async function query(): Promise<void> {
  await click(button(panel(), TEXT.query));
  await settle();
}
/** Presses 【重置】 of the shown panel. */
export async function reset(): Promise<void> {
  await click(button(panel(), TEXT.reset));
  await settle();
}

// ---- states --------------------------------------------------------------------------------

/** A loading state in the main area (aria-busy, a progress bar or a spinning antd Spin). */
export function busy(): boolean {
  return (
    main().querySelector('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') !== null
  );
}

// ---- requests ------------------------------------------------------------------------------

/** No step-up was asked for (no verify request, no step-up dialog). */
export function assertNoStepUp(server: Server): void {
  expect(server.requests('POST', VERIFY)).toEqual([]);
  expect(stepUpOpen(), 'no step-up dialog').toBe(false);
}
