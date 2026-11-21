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
  FILTER_PARAMS,
  LIST,
  UNMASKED_VALUES,
  createServer,
  disallowedRequests,
  snapshot as snapshotOf,
  type RequestLog,
  type RequestMatch,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `withdrawals`, the
// detail at withdrawals/{id}): no import of a page module, so a missing page is an assertion
// failure, not an import error. antd's first Table / Tabs / Select render of a file is slow in
// jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → filter → detail). */
export const FLOW_TIMEOUT = 60_000;

/** The no-permission notice (10403, or neither withdraw.review nor fund.view). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** A failure of a read. */
export const LOAD_FAILED = /失败|出错|错误/;
/** The empty list. */
export const EMPTY = /暂无|没有.*(?:提现|数据|记录)/;
/** The notice of an unknown withdrawal (20001 [withdrawal_id]). */
export const NOT_FOUND = /不存在|未找到|找不到|无此/;

/** The row entry of the detail (design §2 / §6: 【详情】, read 「查看 W… 详情」). */
export const DETAIL_ENTRY = /^(?:详情|查看详情|查看.*详情|查看)$/;
export const QUERY = /^(?:查询|搜索|筛选)$/;
export const RESET = /^重置$/;
export const RETRY = /重试/;
/**
 * Write entries that have no contract in this task (approve, reject, batch approve, batch manual
 * and automatic payout, one-click batch, manual success, execute, cancel a WeChat transfer,
 * export, risk flag recalculation, settings save): never usable on this page.
 */
export const WRITE =
  /^(?:审核通过|通过审核|驳回|批量通过|批量手动打款|批量自动打款|一键组批|手动成功|录入并确认|执行打款|撤销微信转账|导出(?!记录)|重新计算|恢复默认值)/;

/**
 * A reveal entry (【查看】 beside a masked value, 「显示完整账号」 …). This section offers none:
 * the audited reveal belongs to a later section.
 */
export const REVEAL =
  /^(?:查看|显示)(?:全量|完整|明文)?$|^(?:查看|显示)(?:全量|完整|明文)?(?:收款)?(?:账号|手机号?|号码|姓名|实名|身份证号?)$|揭示|reveal/i;

/**
 * Field labels (antd Form.Item label, aria-label or placeholder), case-insensitive. The date
 * range also takes antd's default RangePicker placeholders (Start date / End date, 开始日期 /
 * 结束日期).
 */
export const LABEL = {
  reviewMode: /审核方式|review_mode/i,
  channel: /收款方式|payout_channel|payout_method/i,
  outBizNo: /提现单号|out_biz_no/i,
  createdFrom: /起始|开始|\bstart\b|created_from/i,
  createdTo: /截止|结束|\bend\b|created_to/i,
} as const;

// ---- every request and every rendering of a test -------------------------------------------

/** The fake servers and direct-fetch stubs of the current test. */
const mounted: {
  readonly server: Server;
  readonly directFetch: { readonly mock: { readonly calls: readonly unknown[] } };
}[] = [];
/** Unmasked comparison values seen in the document at any time during the current test. */
const sightings = new Set<string>();
let watcher: MutationObserver | undefined;
const SHOWN_ATTRIBUTES = ['title', 'aria-label', 'value', 'placeholder', 'alt'];

function note(text: string): void {
  for (const value of UNMASKED_VALUES) if (text.includes(value)) sightings.add(value);
}
/** The shown attributes and field values of `nodes`. */
function noteAttributes(nodes: readonly Element[]): void {
  for (const node of nodes) {
    for (const name of SHOWN_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value !== null) note(value);
    }
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) note(node.value);
  }
}
/** Records every unmasked comparison value in the whole document (text, titles, labels, fields). */
function lookForUnmasked(): void {
  note(document.body.textContent ?? '');
  noteAttributes(Array.from(document.body.querySelectorAll('*')));
}
/** After each change: the document text, changed attributes and added elements. */
function lookAtChanges(records: MutationRecord[]): void {
  note(document.body.textContent ?? '');
  for (const record of records) {
    if (record.type === 'attributes' && record.target instanceof Element)
      noteAttributes([record.target]);
    for (const added of Array.from(record.addedNodes))
      if (added instanceof Element)
        noteAttributes([added, ...Array.from(added.querySelectorAll('*'))]);
  }
}
function watchUnmasked(): void {
  if (watcher !== undefined) return;
  watcher = new MutationObserver(lookAtChanges);
  watcher.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
}

/**
 * Throughout the test: no request but the allowed reads (GET /admin/v1/withdrawals, GET
 * /admin/v1/withdrawals/{id}, the common reads), no direct fetch, and no unmasked phone number,
 * payee account or payee name on the page at any time.
 */
export function assertOnlyReads(): void {
  lookForUnmasked();
  for (const { server, directFetch } of mounted) {
    expect(disallowedRequests(server.log), 'only the allowed GET reads').toEqual([]);
    expect(directFetch.mock.calls.length, 'no direct fetch').toBe(0);
  }
  expect([...sightings], 'no unmasked phone number, payee account or payee name').toEqual([]);
}

afterEach(() => {
  try {
    if (mounted.length > 0) assertOnlyReads();
  } finally {
    watcher?.disconnect();
    watcher = undefined;
    mounted.length = 0;
    sightings.clear();
    cleanup();
    vi.unstubAllGlobals();
  }
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  readonly planned?: ReadonlySet<string>;
  /** The console route without the leading slash; defaults to the list (`withdrawals`). */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 提现审核 (or a detail route) over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  mounted.push({ server, directFetch });
  watchUnmasked();
  const onError = vi.fn();
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    getToken: () => 'example-admin-token',
    onError,
  });
  const permissions = options.snapshot ?? snapshotOf(server.permissions);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: options.route ?? 'withdrawals' },
        permissionsProvider: async () => permissions,
        account: { username: 'fin-yi', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider,
        ...(options.planned === undefined ? {} : { plannedOperations: options.planned }),
      }),
    );
  });
  await settle();
  return { server, directFetch, onError };
}

/** The shell's main landmark (looked up without the accessibility filter). */
export function main(): HTMLElement {
  const found = document.querySelector<HTMLElement>('main');
  expect(found, 'the shell renders its main landmark').not.toBeNull();
  return found!;
}
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
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
export async function fill(node: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(node, { target: { value } });
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** `word` as a whole token (not inside a longer [A-Za-z0-9_] run). */
function token(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`);
}
/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;
/** The text nodes of `node` joined with spaces (cells and fields do not run into each other). */
export function textOf(node: Node): string {
  const walker = document.createTreeWalker(node, SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode())
    parts.push((text as Text).data);
  return parts.join(' ');
}

// ---- amounts -------------------------------------------------------------------------------

/** Text without thousands separators and yuan signs; a minus sign stays on its number. */
export function moneyText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[,，¥￥]/g, '')
    .replace(/[−–—]/g, '-')
    .replace(/-\s+/g, '-')
    .replace(/\s+/g, ' ');
}
/**
 * `text` shows the yuan amount `yuan` (written out by hand in the test, e.g. '1234.56'), not as
 * part of a longer number; thousands separators and the yuan sign are ignored.
 */
export function showsYuan(text: string | null | undefined, yuan: string): boolean {
  return new RegExp(`(?<![\\d.-])${escape(yuan)}(?![\\d])`).test(moneyText(text));
}

// ---- the 审核列表 ---------------------------------------------------------------------------

export const LIST_TAB = '审核列表';

/** Tabs of the page whose name starts with `name` (a count badge may follow). */
export function tabsNamed(name: string, root: HTMLElement = main()): HTMLElement[] {
  return within(root)
    .queryAllByRole('tab', { hidden: true })
    .filter(
      (tab) =>
        squash(tab.textContent).startsWith(name) ||
        squash(tab.getAttribute('aria-label')).startsWith(name),
    );
}
/** Where the review list lives: the panel of the 审核列表 tab, or the main area without it. */
export function scope(): HTMLElement {
  const found = tabsNamed(LIST_TAB);
  if (found.length === 0) return main();
  expect(found, `tab ${LIST_TAB}`).toHaveLength(1);
  const id = found[0]!.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  if (owned !== null) return owned;
  return main();
}
/**
 * Shows the review list (its tab when the page has tabs) and, when `number` is given, waits for
 * the row of that withdrawal number.
 */
export async function openList(server: Server, number?: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      tabsNamed(LIST_TAB).length > 0 || server.reads().length > 0,
      'the 审核列表 tab or a read of the list',
    ).toBe(true),
  );
  const tab = tabsNamed(LIST_TAB)[0];
  if (tab !== undefined && tab.getAttribute('aria-selected') !== 'true') await click(tab);
  if (number !== undefined) await waitFor(() => expect(rowsOf(scope(), [number])).toHaveLength(1));
  return scope();
}

// ---- rows ----------------------------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';

/** The innermost rows of `root` whose text holds every token of `words`. */
export function rowsOf(root: HTMLElement, words: readonly string[]): HTMLElement[] {
  const patterns = words.map(token);
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) => {
    const text = textOf(node);
    return patterns.every((pattern) => pattern.test(text));
  });
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** The one row of the list for the withdrawal number `number`. */
export function rowOf(number: string): HTMLElement {
  const found = rowsOf(scope(), [number]);
  expect(found, `one row for ${number}`).toHaveLength(1);
  return found[0]!;
}
/** The withdrawal numbers among `numbers` that have a row in the list. */
export function listed(numbers: readonly string[]): string[] {
  return numbers.filter((number) => rowsOf(scope(), [number]).length > 0);
}

/** Column titles of the list's header row (spaces removed). */
export function columnTitles(): string[] {
  const panel = scope();
  const header =
    panel.querySelector<HTMLElement>('thead tr') ??
    Array.from(panel.querySelectorAll<HTMLElement>('[role="row"]')).find(
      (node) => node.querySelector('[role="columnheader"]') !== null,
    ) ??
    null;
  expect(header, 'a header row with column titles').not.toBeNull();
  return Array.from(header!.children, (cell) => squash(cell.textContent));
}
/** Text of the cell of the row `number` under the one column whose title matches `title`. */
export function cellText(number: string, title: RegExp): string {
  const titles = columnTitles();
  const indexes = titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column titled ${String(title)} among ${titles.join(' | ')}`).toHaveLength(1);
  const cell = rowOf(number).children[indexes[0]!];
  expect(cell, `${number} / ${String(title)}`).toBeDefined();
  return textOf(cell!);
}

// ---- labelled fields and sections of the detail --------------------------------------------

/** `words` (a regex alternation) as a whole label, with an optional 「（元）」 and colon. */
export function labelled(words: string): RegExp {
  return new RegExp(`^(?:${words})(?:[（(]元[)）])?[:：]?$`);
}
/** Detail amount labels (金额明细: 申请金额、手续费、代扣个税、实付金额). */
export const AMOUNT_LABEL = {
  amount: labelled('申请金额|提现金额'),
  fee: labelled('手续费'),
  tax: labelled('代扣个税|个税|代扣个人所得税|个人所得税|税费?|代扣税费?'),
  net: labelled('实付金额|实付|实发金额|实发|到账金额|到账'),
} as const;
/** List amount columns: 申请金额 and 实付 (titles may carry a unit). */
export const AMOUNT_COLUMN = {
  amount: /^(?:申请|提现)金额/,
  net: /^(?:实付|实发|到账)/,
} as const;

/** The innermost of `nodes` (no other of them inside it). */
function innermost(nodes: readonly HTMLElement[]): HTMLElement[] {
  return nodes.filter((node) => !nodes.some((other) => other !== node && node.contains(other)));
}
/** The value element paired with the label element `label` (Descriptions, table, dl, plain). */
function valueOf(label: HTMLElement, root: HTMLElement): HTMLElement | null {
  const cell = label.closest<HTMLElement>('.ant-descriptions-item-label');
  if (cell !== null) {
    const next = cell.nextElementSibling;
    if (next?.matches('.ant-descriptions-item-content')) return next as HTMLElement;
    const inItem = cell.parentElement?.querySelector<HTMLElement>('.ant-descriptions-item-content');
    if (inItem !== null && inItem !== undefined) return inItem;
    // Vertical bordered layout: the content sits in the same column of the next row.
    const row = cell.closest('tr');
    const index = row === null ? -1 : Array.from(row.children).indexOf(cell);
    return (row?.nextElementSibling?.children.item(index) as HTMLElement | null) ?? null;
  }
  const th = label.closest<HTMLElement>('th');
  if (th !== null && th.nextElementSibling !== null) return th.nextElementSibling as HTMLElement;
  const dt = label.closest<HTMLElement>('dt');
  if (dt !== null && dt.nextElementSibling?.matches('dd'))
    return dt.nextElementSibling as HTMLElement;
  for (let node: HTMLElement | null = label; node !== null && node !== root;) {
    if (node.nextElementSibling !== null) return node.nextElementSibling as HTMLElement;
    node = node.parentElement;
  }
  return null;
}
/**
 * Texts of the values paired with every label matching `label` (a whole-label pattern such as
 * AMOUNT_LABEL.amount) inside `root`; at least one such field must be there.
 */
export function fieldValues(root: HTMLElement, label: RegExp): string[] {
  const labels = innermost(
    Array.from(root.querySelectorAll<HTMLElement>('*')).filter((node) =>
      label.test(squash(node.textContent)),
    ),
  );
  expect(labels.length, `a field labelled ${String(label)}`).toBeGreaterThan(0);
  return labels.map((node) => {
    const value = valueOf(node, root);
    expect(value, `the value of the field ${String(label)}`).not.toBeNull();
    return textOf(value!);
  });
}

const TITLE = [
  'h1, h2, h3, h4, h5, h6, [role="heading"]',
  '.ant-card-head-title, .ant-descriptions-title, .ant-collapse-header-text, legend, caption',
].join(', ');
const SECTION = [
  '.ant-card, .ant-descriptions, section, [role="region"], [role="group"]',
  '.ant-collapse-item, fieldset',
].join(', ');
/**
 * The part of `root` owned by the section titled `title`: the Card, Descriptions, region … whose
 * first title it is, else the largest ancestor of the title holding no other title, else (titles
 * side by side in one container) a copy of the title and its following siblings up to the next
 * title.
 */
export function section(root: HTMLElement, title: RegExp): HTMLElement {
  const titles = Array.from(root.querySelectorAll<HTMLElement>(TITLE));
  const own = titles.filter((node) => title.test(squash(node.textContent)));
  expect(own.length, `a section titled ${String(title)}`).toBeGreaterThan(0);
  const heading = own[0]!;
  const isOther = (other: HTMLElement): boolean => other !== heading && !heading.contains(other);
  let area: HTMLElement = heading;
  let node = heading.parentElement;
  while (node !== null && node !== root) {
    const current: HTMLElement = node;
    if (current.matches(SECTION)) {
      const first = titles.find((other) => current.contains(other));
      if (first !== undefined && !isOther(first)) area = current;
      break;
    }
    if (titles.some((other) => isOther(other) && current.contains(other))) break;
    area = current;
    node = current.parentElement;
  }
  if (area !== heading) return area;
  const copy = document.createElement('div');
  copy.append(heading.cloneNode(true));
  for (let next = heading.nextElementSibling; next !== null; next = next.nextElementSibling) {
    if (next.matches(TITLE) || next.querySelector(TITLE) !== null) break;
    copy.append(next.cloneNode(true));
  }
  return copy;
}

// ---- buttons -------------------------------------------------------------------------------

export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('[aria-disabled="true"], fieldset[disabled]') !== null
  );
}
/** Buttons and links of `root` whose text or aria-label matches `name` (spaces ignored). */
export function actions(root: HTMLElement, name: RegExp): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]'),
  ).filter(
    (node) =>
      name.test(squash(node.textContent)) || name.test(squash(node.getAttribute('aria-label'))),
  );
}
export function action(root: HTMLElement, name: RegExp): HTMLElement {
  const found = actions(root, name);
  expect(found, `one action ${String(name)}`).toHaveLength(1);
  return found[0]!;
}
/** Usable (not disabled) actions of `root` named `name`. */
export function usable(root: HTMLElement, name: RegExp): HTMLElement[] {
  return actions(root, name).filter((node) => !isDisabled(node));
}

/** Whether `node` sits in a row of the review list (a table row holding a withdrawal number). */
function inListRow(node: HTMLElement): boolean {
  const row = node.closest<HTMLElement>('.ant-table-row, [role="row"]');
  return row !== null && row.closest('.ant-descriptions') === null && /W\d{14}/.test(textOf(row));
}
/** Usable reveal entries of `root`, leaving out the 【查看】 detail entries of list rows. */
export function revealEntries(root: HTMLElement): HTMLElement[] {
  return usable(root, REVEAL).filter((node) => !inListRow(node));
}

/**
 * The page offers no usable write entry (and, on a detail, no usable reveal entry); pressing every
 * write, reveal or 【查看】-like entry, usable or not, sends nothing but the allowed reads and
 * shows no unmasked value.
 */
export async function assertReadOnly(
  server: Server,
  options: { readonly root?: HTMLElement; readonly detail?: boolean } = {},
) {
  const root = options.root ?? main();
  expect(
    usable(root, WRITE).map((node) => squash(node.textContent)),
    'no usable write entry (approve / reject / batch / payout / export …)',
  ).toEqual([]);
  if (options.detail === true)
    expect(
      revealEntries(root).map(
        (node) => squash(node.textContent) || squash(node.getAttribute('aria-label')),
      ),
      'no usable reveal entry beside the masked values',
    ).toEqual([]);
  const pressable = [...actions(root, WRITE), ...actions(root, REVEAL), ...actions(root, /^查看/)];
  for (const node of new Set(pressable)) if (node.isConnected) await click(node);
  await settled(server);
  expect(server.writes(), 'no request other than GET').toEqual([]);
  assertOnlyReads();
}

/**
 * A read of the review table: GET /admin/v1/withdrawals with exactly the filter parameters
 * `filters` (paging aside) and a page size other than 1, so a count read of the status tabs (other
 * filters, or page_size=1) is not one.
 */
export function tableRead(filters: Readonly<Record<string, string>> = {}): RequestMatch {
  return (request) =>
    request.method === 'GET' &&
    request.path === LIST &&
    (request.query['page_size'] ?? '20') !== '1' &&
    FILTER_PARAMS.every((name) => request.query[name] === filters[name]);
}
/** The reads of `server` matching `match`. */
export function readsWhere(server: Server, match: RequestMatch): RequestLog[] {
  return server.log.filter(match);
}

/** Text of `root` without the rows of withdrawals (W + 14 digits): notices, headings, filters. */
export function textBesideRows(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const row of Array.from(copy.querySelectorAll(ROW)))
    if (/W\d{14}/.test(row.textContent ?? '')) row.remove();
  return textOf(copy);
}
/** How often `pattern` occurs in `text`. */
export function occurrences(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (text.match(new RegExp(pattern.source, flags)) ?? []).length;
}

// ---- dialogs and the detail ----------------------------------------------------------------

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
  }
  return true;
}
export function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
}
/**
 * Where the detail of `number` is shown: an open drawer / dialog holding it, else the main area
 * (the detail route withdrawals/{id}).
 */
export function detailArea(number: string): HTMLElement {
  const pattern = token(number);
  const drawers = openDialogs().filter((node) => pattern.test(textOf(node)));
  return drawers[0] ?? main();
}
/** Waits for the detail read of `id` and for the detail of `number` to be shown. */
export async function detailShown(server: Server, id: string, number: string) {
  await waitFor(() => expect(server.detailReads(id).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(textOf(detailArea(number))).toMatch(token(number)));
  return detailArea(number);
}
/** Opens the detail of the row `number` through its 【详情】 entry. */
export async function openDetail(server: Server, number: string, id: string) {
  await openList(server, number);
  const entries = usable(rowOf(number), DETAIL_ENTRY);
  expect(entries.length, `a usable 【详情】 for ${number}`).toBeGreaterThan(0);
  const named = entries.find((node) => /^详情$/.test(squash(node.textContent)));
  await click(named ?? entries[0]!);
  return detailShown(server, id, number);
}

// ---- fields --------------------------------------------------------------------------------

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
/** Text inputs and textareas of `root` labelled (or with a placeholder) matching `label`. */
export function textFields(
  root: HTMLElement,
  label: RegExp,
): (HTMLInputElement | HTMLTextAreaElement)[] {
  const labelled = within(root).queryAllByLabelText(label);
  const placeholders = within(root).queryAllByPlaceholderText(label);
  return [...new Set([...labelled, ...placeholders])].filter(isTextField);
}
/** The one text input (or textarea) labelled `label` in `root`. */
export function textbox(root: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const found = textFields(root, label);
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
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

/**
 * Chooses `option` in the select (antd Select or native) or radio group labelled `label` inside
 * `root`; returns the texts of every option that was offered.
 */
export async function choose(root: HTMLElement, label: RegExp, option: RegExp): Promise<string[]> {
  const combos = within(root).queryAllByRole('combobox', { name: label });
  if (combos.length > 0) {
    expect(combos, `one select labelled ${String(label)}`).toHaveLength(1);
    const combo = combos[0]!;
    if (combo instanceof HTMLSelectElement) {
      const offered = Array.from(combo.options);
      const target = offered.find((item) => option.test(item.text.trim()));
      expect(target, `option ${String(option)} of ${String(label)}`).toBeDefined();
      await act(async () => {
        fireEvent.change(combo, { target: { value: target!.value } });
      });
      return offered.map((item) => item.text.trim());
    }
    await act(async () => {
      fireEvent.mouseDown(combo);
    });
    let target: HTMLElement | undefined;
    let offered: string[] = [];
    await waitFor(() => {
      const nodes = optionNodes(combo);
      offered = nodes.map((node) => (node.textContent ?? '').trim());
      target = nodes.find((node) => option.test((node.textContent ?? '').trim()));
      expect(target, `option ${String(option)} of ${String(label)}`).toBeDefined();
    });
    await click(target!);
    return offered;
  }
  const groups = within(root).queryAllByRole('radiogroup', { name: label });
  expect(groups, `a select or radio group labelled ${String(label)}`).toHaveLength(1);
  const radios = within(groups[0]!).queryAllByRole('radio');
  const text = (node: HTMLElement): string =>
    (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? '').trim();
  const target = radios.filter((node) => option.test(text(node)));
  expect(target, `a radio option ${String(option)} for ${String(label)}`).toHaveLength(1);
  await click(target[0]!);
  return radios.map(text);
}

/** Types a date (YYYY-MM-DD) into a plain input or an antd picker input. */
export async function fillDate(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input);
  });
}
/** The application-time start / end input of the filter. */
export function dateField(which: 'from' | 'to'): HTMLInputElement | HTMLTextAreaElement {
  return textbox(scope(), which === 'from' ? LABEL.createdFrom : LABEL.createdTo);
}

/** Presses 【查询】 of the filter. */
export async function query(): Promise<void> {
  await click(action(scope(), QUERY));
  await settle();
}

/** Clicks the page control 「下一页」 (or the page number 2). */
export async function nextPage(): Promise<void> {
  const next =
    scope().querySelector<HTMLElement>(
      '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    ) ?? scope().querySelector<HTMLElement>('[title="2"]');
  expect(next, 'a page-number pagination control for page 2').not.toBeNull();
  await click(next!);
}

// ---- requests ------------------------------------------------------------------------------

/** Keys of a list request's query that listAdminWithdrawals does not take. */
export function extraParams(request: RequestLog, allowed: readonly string[]): string[] {
  return Object.keys(request.query).filter((name) => !allowed.includes(name));
}
