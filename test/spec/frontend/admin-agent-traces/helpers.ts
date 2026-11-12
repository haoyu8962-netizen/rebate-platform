import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  BASE_URL,
  createServer,
  snapshot as snapshotOf,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, browser router, menu id
// `agent-traces` or the workbench card address /agent/reports?overdue=true): no page module is
// imported, so a missing page is an assertion failure, not an import error. No planned list is
// passed (nothing is blocked). antd's first Table / Tabs / Drawer / Modal / Select render of a
// file is slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });

/** The menu (texts/menu.ts) and the two tabs of the page. */
export const MENU = 'AI 助手记录';
export const SESSIONS_TAB = '会话留痕';
export const REPORTS_TAB = 'AI 举报';

/** The no-permission notice (10403, or no agent.trace). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** The 20902 notice: the report was handled by someone else or changed meanwhile. */
export const CONFLICT = /已被.*处理|他人|已变化|已变更|冲突|已刷新|刷新后/;
/** The 20001 notice of an unknown session. */
export const NOT_FOUND = /不存在|未找到|找不到/;
/** A failure of a read. */
export const LOAD_FAILED = /失败|出错|错误|异常/;
export const RETRY = /重试/;
/** The mark of an overdue report (more than 48 hours pending). */
export const OVERDUE_MARK = /超时|逾期|超\s*48/;
/** The guest of a session without user_id. */
export const GUEST = '访客';
/** Pending / handled (AdminAgentReportStatus). */
export const PENDING_NAME = '待处理';
export const HANDLED_NAME = '已处理';

/** The entry that opens a session's trace (a row action, never automatic). */
export const TRACE_ENTRY =
  /^(?:查看|详情|留痕|查看留痕|查看会话|会话留痕|打开|打开会话|查看详情|会话详情)$/;
/** The 【标记已处理】 entry of a pending report (agent.report). */
export const HANDLE_ENTRY = /^标记已处理$/;
/** The submit button of the handle dialog. */
export const SUBMIT = /^(?:确认|确定|提交|保存|标记已处理)/;
export const CLOSE = /^(?:关闭|close|返回)$/i;
export const QUERY = /^(?:查询|搜索|筛选)$/;

/** Field labels (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  user: /用户\s*(?:ID|id|编号)|user_id/,
  session: /会话\s*(?:ID|id|编号)|session_id/,
  badcase: /badcase|坏例/i,
  reported: /举报/,
  status: /状态/,
  overdue: /超时|逾期/,
  note: /处理说明|说明|备注/,
} as const;
/** The end of a time window (to, exclusive). */
const TIME_TO = /止|至|到|结束|截止|end\b|(?<![a-z_])to\b/i;
/** The start of a time window (from, inclusive). */
const TIME_FROM = /起|从|自|开始|start|from/i;

const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const auth of sessions.splice(0)) auth.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

export interface MountOptions {
  /** The address opened (default /agent-traces). */
  readonly route?: string;
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  /** The console's clock (ISO time): both Date and the shell's clock option read it. */
  readonly clock?: string;
}

/** Mounts the real admin shell (browser router) at `route` over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  installMediaQuery();
  const { clock } = options;
  if (clock !== undefined) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(clock));
  }
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const auth = harness().create();
  sessions.push(auth);
  await signIn(auth);
  window.history.replaceState(null, '', options.route ?? '/agent-traces');
  const onError = vi.fn();
  const permissions = options.snapshot ?? snapshotOf(server.permissions);
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: auth,
        permissionsProvider: async () => permissions,
        account: { username: 'ops-jia', displayName: '运营甲' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError,
        }),
        ...(clock === undefined ? {} : { clock: { now: () => Date.parse(clock) } }),
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

/** The one sidebar link of the menu 「AI 助手记录」. */
export function menuLink(): HTMLElement {
  const nav = screen.queryByRole('navigation', { name: '主导航' });
  expect(nav, 'sidebar 主导航').not.toBeNull();
  const links = within(nav!).queryAllByRole('link', { name: MENU });
  expect(links, `menu link ${MENU}`).toHaveLength(1);
  return links[0]!;
}

// ---- tabs ----------------------------------------------------------------------------------

/** Tabs of the page whose name starts with `name` (a count badge may follow). */
export function tabsNamed(name: string): HTMLElement[] {
  const wanted = squash(name);
  return within(main())
    .queryAllByRole('tab', { hidden: true })
    .filter(
      (tab) =>
        squash(tab.textContent).startsWith(wanted) ||
        squash(tab.getAttribute('aria-label')).startsWith(wanted),
    );
}
export function tabOf(name: string): HTMLElement {
  const found = tabsNamed(name);
  expect(found, `one tab ${name}`).toHaveLength(1);
  return found[0]!;
}
export function selected(tab: HTMLElement): boolean {
  return tab.getAttribute('aria-selected') === 'true';
}
/** The panel of the tab `name`. */
export function panel(name: string): HTMLElement {
  const tab = tabOf(name);
  const id = tab.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  expect(owned, `the panel of ${name} (aria-controls)`).not.toBeNull();
  return owned!;
}
/** Waits for both tabs, selects `name` (clicking it when needed) and returns its panel. */
export async function openTab(name: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(tabsNamed(SESSIONS_TAB), `tab ${SESSIONS_TAB}`).toHaveLength(1);
    expect(tabsNamed(REPORTS_TAB), `tab ${REPORTS_TAB}`).toHaveLength(1);
  });
  const tab = tabOf(name);
  if (!selected(tab)) await click(tab);
  await waitFor(() => expect(selected(tabOf(name)), `tab ${name} selected`).toBe(true));
  await settle();
  return panel(name);
}

// ---- rows and cells ------------------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';
/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** `word` as a whole word (not inside a longer [A-Za-z0-9_-] run). */
function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])${escape(word)}(?![A-Za-z0-9_-])`);
}
/** The text nodes of `node` joined with spaces (cells do not run into each other). */
export function textOf(node: Node): string {
  const walker = document.createTreeWalker(node, SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode())
    parts.push((text as Text).data);
  return parts.join(' ');
}
/** Text plus the aria-label / title of every element inside (a shortened id keeps its full form there). */
export function searchable(node: HTMLElement): string {
  const labels = [node, ...Array.from(node.querySelectorAll<HTMLElement>('*'))].flatMap((el) => [
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
  ]);
  return `${textOf(node)} ${labels.join(' ')}`;
}
/** The innermost rows of `root` that show every one of `words`. */
export function rowsOf(root: HTMLElement, words: readonly string[]): HTMLElement[] {
  const patterns = words.map((word) => wordPattern(word));
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) => {
    const text = searchable(node);
    return patterns.every((pattern) => pattern.test(text));
  });
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** The one row of `root` showing `id`. */
export function rowOf(root: HTMLElement, id: string): HTMLElement {
  const found = rowsOf(root, [id]);
  expect(found, `one row for ${id}`).toHaveLength(1);
  return found[0]!;
}
/** Waits until `root` shows a row for each of `ids`. */
export async function rowsShown(root: HTMLElement, ids: readonly string[]): Promise<void> {
  await waitFor(() => {
    for (const id of ids) expect(rowsOf(root, [id]), `one row for ${id}`).toHaveLength(1);
  });
}
/** The row's text without its action buttons (「标记已处理」 must not read as the status 已处理). */
export function statusText(row: HTMLElement): string {
  const copy = row.cloneNode(true) as HTMLElement;
  for (const node of Array.from(copy.querySelectorAll('button, a, [role="button"]'))) node.remove();
  return squash(textOf(copy));
}
/** The order of `ids` as their rows appear in `root`. */
export function rowOrder(root: HTMLElement, ids: readonly string[]): string[] {
  const rows = ids.map((id): [string, HTMLElement] => [id, rowOf(root, id)]);
  return rows
    .sort(([, a], [, b]) =>
      a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map(([id]) => id);
}

/** Column titles of the header row of `root` (spaces removed). */
function columnTitles(root: HTMLElement): string[] {
  const header =
    root.querySelector<HTMLElement>('thead tr') ??
    Array.from(root.querySelectorAll<HTMLElement>('[role="row"]')).find(
      (node) => node.querySelector('[role="columnheader"]') !== null,
    ) ??
    null;
  expect(header, 'a header row with column titles').not.toBeNull();
  return Array.from(header!.children, (cell) => squash(cell.textContent));
}
/** Text of the cell of the row `id` under the one column whose title matches `title`. */
export function cellText(root: HTMLElement, id: string, title: RegExp): string {
  const titles = columnTitles(root);
  const indexes = titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column titled ${String(title)} among ${titles.join(' | ')}`).toHaveLength(1);
  const cell = rowOf(root, id).children[indexes[0]!];
  expect(cell, `${id} / ${String(title)}`).toBeDefined();
  return textOf(cell!);
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

// ---- dialogs and drawers -------------------------------------------------------------------

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    // A closed antd Drawer may stay mounted (rc-drawer drops ant-drawer-open).
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
    // A modal / drawer on its way out (its leave motion may never finish in jsdom).
    if (Array.from(node.classList).some((name) => /-leave(?:-active)?$/.test(name))) return false;
  }
  return true;
}
export function openDialogs(): HTMLElement[] {
  const found = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
    visible,
  );
  return found.filter((node) => !found.some((other) => other !== node && node.contains(other)));
}

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

/** Open dialogs holding the handling note field (the 【标记已处理】 dialog). */
export function noteDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => textFields(node, LABEL.note).length > 0);
}
export async function noteDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(noteDialogs(), 'one handle dialog with a note').toHaveLength(1));
  return noteDialogs()[0]!;
}
/** Open dialogs / drawers showing a session's trace (not the handle dialog). */
export function traceDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => textFields(node, LABEL.note).length === 0);
}
/** The one open trace dialog (drawer or modal) showing `sessionId`. */
export async function traceDialog(sessionId: string): Promise<HTMLElement> {
  const pattern = wordPattern(sessionId);
  await waitFor(() => {
    const found = traceDialogs().filter((node) => pattern.test(searchable(node)));
    expect(found, `one open trace of ${sessionId}`).toHaveLength(1);
  });
  return traceDialogs().filter((node) => pattern.test(searchable(node)))[0]!;
}

/** Usable trace entries of the row `id` in `root`. */
export function traceEntries(root: HTMLElement, id: string): HTMLElement[] {
  return usable(rowOf(root, id), TRACE_ENTRY);
}
/** Opens the trace of the row `id` (its 【查看】 / 【详情】 / 【留痕】). */
export async function openTrace(root: HTMLElement, id: string): Promise<void> {
  const entries = traceEntries(root, id);
  expect(entries.length, `a usable trace entry for ${id}`).toBeGreaterThan(0);
  await click(entries[0]!);
  await settle();
}
/** Closes the trace dialog `dialog` (its close button, else Escape). */
export async function closeTrace(dialog: HTMLElement): Promise<void> {
  const buttons = usable(dialog, CLOSE);
  expect(buttons.length, 'a close button on the trace').toBeGreaterThan(0);
  await click(buttons[0]!);
  await waitFor(() => expect(traceDialogs(), 'the trace is closed').toEqual([]));
  await settle();
}

// ---- fields --------------------------------------------------------------------------------

const EXPLAIN = '[role="alert"], .ant-form-item-explain-error';

/** Text of the error shown next to `input` (its form item or its error description). */
export function fieldError(input: HTMLElement): string {
  const ids = [input.getAttribute('aria-errormessage') ?? ''];
  // A description is an error only while the field is marked invalid (not a standing help text).
  if (input.getAttribute('aria-invalid') === 'true')
    ids.push(input.getAttribute('aria-describedby') ?? '');
  const texts = ids
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '');
  const item = input.closest('.ant-form-item');
  const nearby = item === null ? [] : Array.from(item.querySelectorAll(EXPLAIN));
  for (const node of nearby) texts.push(node.textContent ?? '');
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join(' ');
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

/** Chooses `option` in the select (antd or native) or radio group labelled `label` in `root`. */
export async function choose(root: HTMLElement, label: RegExp, option: RegExp): Promise<void> {
  const combos = within(root).queryAllByRole('combobox', { name: label });
  if (combos.length > 0) {
    expect(combos, `one select labelled ${String(label)}`).toHaveLength(1);
    const combo = combos[0]!;
    if (combo instanceof HTMLSelectElement) {
      const target = Array.from(combo.options).find((item) => option.test(item.text.trim()));
      expect(target, `option ${String(option)} of ${String(label)}`).toBeDefined();
      await act(async () => {
        fireEvent.change(combo, { target: { value: target!.value } });
      });
      return;
    }
    await act(async () => {
      fireEvent.mouseDown(combo);
    });
    let target: HTMLElement | undefined;
    await waitFor(() => {
      target = optionNodes(combo).find((node) => option.test((node.textContent ?? '').trim()));
      expect(target, `option ${String(option)} of ${String(label)}`).toBeDefined();
    });
    await click(target!);
    return;
  }
  const groups = within(root).queryAllByRole('radiogroup', { name: label });
  expect(groups, `a select or radio group labelled ${String(label)}`).toHaveLength(1);
  const radios = within(groups[0]!).queryAllByRole('radio');
  const text = (node: HTMLElement): string =>
    (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? '').trim();
  const target = radios.filter((node) => option.test(text(node)));
  expect(target, `a radio option ${String(option)} for ${String(label)}`).toHaveLength(1);
  await click(target[0]!);
}

/** Turns the 「只看超时」 filter on: a checkbox / switch, else a select or radio option. */
export async function filterOverdue(root: HTMLElement): Promise<void> {
  const toggles = [
    ...within(root).queryAllByRole('checkbox', { name: LABEL.overdue }),
    ...within(root).queryAllByRole('switch', { name: LABEL.overdue }),
  ];
  if (toggles.length > 0) {
    expect(toggles, 'one overdue toggle').toHaveLength(1);
    const toggle = toggles[0]!;
    const on =
      toggle.getAttribute('aria-checked') === 'true' ||
      (toggle instanceof HTMLInputElement && toggle.checked);
    if (!on) await click(toggle);
    return;
  }
  await choose(root, LABEL.overdue, /^(?:是|超时|已超时|仅超时|只看超时|逾期|已逾期)$/);
}

/** The start (from) or end (to) input of the time window in `root`. */
export function timeField(root: HTMLElement, which: 'from' | 'to'): HTMLElement {
  const candidates = [
    ...within(root).queryAllByRole('textbox'),
    ...within(root).queryAllByRole('combobox'),
    ...Array.from(root.querySelectorAll<HTMLElement>('input:not([type]), input[type="text"]')),
  ];
  const named = (node: HTMLElement): string => {
    const own = node instanceof HTMLInputElement ? node.labels : null;
    const labels = own === null ? [] : Array.from(own, (label) => label.textContent ?? '');
    const by = (node.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '');
    return [
      node.getAttribute('aria-label') ?? '',
      node.getAttribute('placeholder') ?? '',
      ...labels,
      ...by,
    ].join(' ');
  };
  const fields = [...new Set(candidates)].filter((node) => {
    const name = named(node);
    if (LABEL.user.test(name) || LABEL.session.test(name)) return false;
    if (!/时间|日期|time|date|起|止|从|到|至/i.test(name)) return false;
    return which === 'to' ? TIME_TO.test(name) : TIME_FROM.test(name) && !TIME_TO.test(name);
  });
  expect(fields, `one ${which} time input`).toHaveLength(1);
  return fields[0]!;
}
/** Types a Beijing time (YYYY-MM-DD HH:mm:ss) into a plain input or an antd picker input. */
export async function fillTime(
  root: HTMLElement,
  which: 'from' | 'to',
  value: string,
): Promise<void> {
  const input = timeField(root, which);
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    fireEvent.blur(input);
  });
}

/** Presses 【查询】 of the filter in `root`. */
export async function query(root: HTMLElement): Promise<void> {
  await click(action(root, QUERY));
  await settle();
}

/** Clicks the page control 「下一页」 (or the page number 2) in `root`. */
export async function nextPage(root: HTMLElement): Promise<void> {
  const next =
    root.querySelector<HTMLElement>(
      '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    ) ?? root.querySelector<HTMLElement>('[title="2"]');
  expect(next, 'a page-number pagination control for page 2').not.toBeNull();
  await click(next!);
}

// ---- text that appeared after an action ----------------------------------------------------

/** Notices: alerts, status lines, antd message / notification / Alert, field errors. */
const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-form-item-explain, .ant-result';

function textNodes(): Text[] {
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
export type TextSnapshot = ReadonlyMap<Text, string>;
/** Every text node on the page with its text, taken before an action. */
export function snapshotText(): TextSnapshot {
  return new Map(textNodes().map((node): [Text, string] => [node, node.data]));
}
/** Text the operator is told in: a notice, or a dialog / drawer. */
function inReply(node: Text): boolean {
  const element = node.parentElement;
  if (element === null || element.closest('textarea') !== null || !visible(element)) return false;
  if (element.closest('[role="dialog"]') !== null) return true;
  return element.closest(NOTICES) !== null;
}
/** Every text shown in notices and in dialogs / drawers right now. */
export function noticeText(): string {
  return squash(
    textNodes()
      .filter(inReply)
      .map((node) => node.data)
      .join(''),
  );
}
/** Text that is new (or changed) since `before`, in notices and in dialogs / drawers. */
export function freshText(before: TextSnapshot): string {
  return squash(
    textNodes()
      .filter((node) => before.get(node) !== node.data && inReply(node))
      .map((node) => node.data)
      .join(''),
  );
}

// ---- requests ------------------------------------------------------------------------------

/** Keys of a request's query that `allowed` does not list. */
export function extraParams(request: RequestLog, allowed: readonly string[]): string[] {
  return Object.keys(request.query).filter((name) => !allowed.includes(name));
}
/** The last element of `list` (asserted to exist). */
export function last<T>(list: readonly T[]): T {
  expect(list.length, 'at least one entry').toBeGreaterThan(0);
  return list[list.length - 1]!;
}
