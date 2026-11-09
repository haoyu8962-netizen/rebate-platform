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
  BEARER,
  TOTP_CODE,
  created,
  createServer,
  detailPath,
  snapshot as snapshotOf,
  yuan,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `recon`): no import
// of a page module, so a missing 【确认扣回】 is an assertion failure, not an import error. Every
// wait (asyncUtilTimeout) is far shorter than the per-test timeout.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → drawer → dialog → step-up → write → list). */
export const FLOW_TIMEOUT = 60_000;

/** The clawback entry (【确认扣回】, order.blacklist_clawback). */
export const CLAWBACK_ENTRY = /^确认扣回/;
/** The row entry of the drawer (design §2: 【处理】【详情】). */
export const DETAIL_ENTRY = /^(?:详情|处理|查看)$/;
/** The submit button of the second confirmation dialog. */
export const CONFIRM = /^(?:确认扣回|确认|确定|提交|扣回)/;
export const CANCEL = /^取消$/;
/** The note field of the confirmation dialog (optional, 1–200 after trimming). */
export const NOTE = /备注/;
/** The step-up dialog (totp tier). */
export const STEP_UP = /二次验证|动态码/;
/** The submit button of the step-up dialog. */
export const VERIFY_BUTTON = /^(?:验证并继续|验证|确认|确定)$/;

/** The Chinese name of blacklist_after_credit (已入账订单命中黑名单待复核) names the blacklist. */
export const BLACKLIST_NAME = /黑名单/;
/** The dialog says the amount actually taken back is the server's calculation. */
export const SERVER_DECIDES =
  /(?:以|按)服务端.{0,12}为准|服务端.{0,6}(?:计算|核算)|实(?:际)?扣.{0,16}(?:服务端|系统).{0,8}(?:为准|计算|核算)/;
/** The dialog names the hit dimensions. */
export const DIMENSIONS_LABEL = /维度/;
/** How a dimension may be shown: its code or its name (contracts/enums/identity.yaml). */
export const DIMENSION_SHOWN = {
  channel: /channel|渠道/,
  order_no_suffix:
    /order_no_suffix|订单号?后6位|订单号?后六位|订单号?尾号|订单号?末6位|订单号?末六位/,
} as const;

/** The success notice of a clawback. */
export const DONE = /已扣回|扣回成功|扣回完成|已确认扣回|完成扣回/;
/** The 20902 recon_diff notice: the difference changed meanwhile, refresh. */
export const CONFLICT = /已变化|已变更|已被.*处理|他人处理|冲突|刷新后重试|已重新读取|已刷新/;
/** blacklist_clawback_disabled: the switch order.blacklist_clawback.enabled is off. */
export const SWITCH_OFF =
  /(?:未|没有|尚未)(?:开启|打开|启用)|开关.{0,8}(?:关|未开)|已关闭.{0,6}(?:功能|开关)/;
/** 10403: no permission. */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;

/** Column titles of the list (spaces removed; matched at the start of the title). */
export const COLUMN = {
  type: /^(?:差错单?)?类型/,
  status: /^(?:差错单?)?状态/,
} as const;
/** Field labels of the filter (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  type: /类型/,
} as const;
export const QUERY = /^(?:查询|搜索|筛选)$/;

/** Servers made with createServer during a test send nothing outside the page's whitelist. */
afterEach(() => {
  const servers = created.splice(0);
  try {
    for (const server of servers)
      expect(
        server.unexpected().map((request) => `${request.method} ${request.path}`),
        'only the list / detail reads, the totp step-up and the clawback are requested',
      ).toEqual([]);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
}

/** Mounts the real admin shell on 资金 / 对账与差错 over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    getToken: () => BEARER,
    onError: vi.fn(),
  });
  const permissions = options.snapshot ?? snapshotOf(server.permissions);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'recon' },
        permissionsProvider: async () => permissions,
        account: { username: 'fin-yi', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider,
      }),
    );
  });
  await settle();
  return { server, directFetch };
}

// ---- basics --------------------------------------------------------------------------------

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
export async function click(node: HTMLElement, twice = false): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
    if (twice) fireEvent.click(node);
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
function textNodesOf(root: Node): Text[] {
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
/** The text nodes of `node` joined with spaces (a row's cells do not run into each other). */
export function textOf(node: Node): string {
  return textNodesOf(node)
    .map((text) => text.data)
    .join(' ');
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
/** `text` shows `fen` as yuan with two decimals (the admin amount format, BR-TEXT-10). */
export function showsAmount(text: string | null | undefined, fen: number): boolean {
  const before = fen < 0 ? '(?<![\\d.])' : '(?<![\\d.-])';
  return new RegExp(`${before}${escape(yuan(fen))}(?!\\d)`).test(moneyText(text));
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
    if (node.classList.contains('ant-popover-hidden')) return false;
  }
  return true;
}
const TITLES = '.ant-modal-title, .ant-drawer-title, .ant-modal-confirm-title';

/** Title of a dialog (aria-label, aria-labelledby looked up inside first, antd titles). */
export function titleOf(node: HTMLElement): string {
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  // Under NODE_ENV=test every antd Modal / Drawer title gets the same id: look inside first.
  const texts = ids.map((id) => {
    const inside = node.querySelector(`[id="${id}"]`);
    return (inside ?? document.getElementById(id))?.textContent ?? '';
  });
  texts.push(node.getAttribute('aria-label') ?? '');
  texts.push(node.querySelector(TITLES)?.textContent ?? '');
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join(' ');
}
export function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
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

/** Open step-up dialogs. */
export function stepUpDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => STEP_UP.test(titleOf(node)));
}
/** Open clawback confirmation dialogs (the ones with the note field). */
export function clawbackDialogs(): HTMLElement[] {
  return openDialogs().filter(
    (node) => !STEP_UP.test(titleOf(node)) && textFields(node, NOTE).length > 0,
  );
}
/** The one open clawback confirmation dialog. */
export async function clawbackDialog(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(clawbackDialogs(), 'one 【确认扣回】 dialog with a note field').toHaveLength(1),
  );
  return clawbackDialogs()[0]!;
}
/** Open dialogs / drawers (not the confirmation or step-up dialog) that show `ref`. */
export function drawersOf(ref: string): HTMLElement[] {
  const pattern = token(ref);
  const found = openDialogs().filter(
    (node) =>
      !STEP_UP.test(titleOf(node)) &&
      textFields(node, NOTE).length === 0 &&
      pattern.test(textOf(node)),
  );
  return found.filter((node) => !found.some((other) => other !== node && node.contains(other)));
}

// ---- the 差错单 list -----------------------------------------------------------------------

const DIFFS_TAB = '差错单';
function tabsNamed(name: string): HTMLElement[] {
  return within(main())
    .queryAllByRole('tab', { hidden: true })
    .filter(
      (tab) =>
        squash(tab.textContent).startsWith(name) ||
        squash(tab.getAttribute('aria-label')).startsWith(name),
    );
}
/** Where the 差错单 list lives: the panel of the 差错单 tab, or the main area without tabs. */
export function scope(): HTMLElement {
  const found = tabsNamed(DIFFS_TAB);
  if (found.length === 0) return main();
  expect(found, `tab ${DIFFS_TAB}`).toHaveLength(1);
  const id = found[0]!.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  if (owned !== null) return owned;
  const panels = within(main()).queryAllByRole('tabpanel');
  expect(panels, 'one visible tab panel').toHaveLength(1);
  return panels[0]!;
}

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
export function rowOf(ref: string): HTMLElement {
  const found = rowsOf(scope(), [ref]);
  expect(found, `one row for ${ref}`).toHaveLength(1);
  return found[0]!;
}
/** Shows the 差错单 list (its tab when the page has tabs) and waits for the row of `ref`. */
export async function openDiffs(server: Server, ref: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      tabsNamed(DIFFS_TAB).length > 0 || server.reads().length > 0,
      'the 差错单 tab or a read of the list',
    ).toBe(true),
  );
  const tab = tabsNamed(DIFFS_TAB)[0];
  if (tab !== undefined && tab.getAttribute('aria-selected') !== 'true') await click(tab);
  await waitFor(() => expect(rowsOf(scope(), [ref])).toHaveLength(1));
  return scope();
}

/** Text of the cell of the row `ref` under the one column whose title matches `title`. */
export function cellText(ref: string, title: RegExp): string {
  const panel = scope();
  const header =
    panel.querySelector<HTMLElement>('thead tr') ??
    Array.from(panel.querySelectorAll<HTMLElement>('[role="row"]')).find(
      (node) => node.querySelector('[role="columnheader"]') !== null,
    ) ??
    null;
  expect(header, 'a header row with column titles').not.toBeNull();
  const titles = Array.from(header!.children, (cell) => squash(cell.textContent));
  const indexes = titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column ${String(title)} among ${titles.join(' | ')}`).toHaveLength(1);
  const cell = rowOf(ref).children[indexes[0]!];
  expect(cell, `${ref} / ${String(title)}`).toBeDefined();
  return squash(textOf(cell!));
}
/** Text of the status cell of the row `ref`. */
export function statusCell(ref: string): string {
  return cellText(ref, COLUMN.status);
}

/** Opens the drawer of the row `ref` (its 【详情】, else 【处理】 / 【查看】). */
export async function openDetail(server: Server, ref: string, id: string): Promise<HTMLElement> {
  await openDiffs(server, ref);
  const row = rowOf(ref);
  const entries = usable(row, DETAIL_ENTRY);
  expect(entries.length, `a usable 【详情】 / 【处理】 for ${ref}`).toBeGreaterThan(0);
  const preferred = entries.find((node) => /^详情$/.test(squash(node.textContent))) ?? entries[0]!;
  const reads = server.detailReads(id).length;
  await click(preferred);
  await waitFor(() => expect(server.detailReads(id).length).toBeGreaterThan(reads));
  await settled(server);
  await waitFor(() => expect(drawersOf(ref), `the drawer of ${ref}`).toHaveLength(1));
  return drawersOf(ref)[0]!;
}

/** Every 【确认扣回】 for `ref` (usable or not), in its row and in its open drawer. */
export function allClawbackEntries(ref: string): HTMLElement[] {
  const scopes = [...rowsOf(scope(), [ref]), ...drawersOf(ref)];
  return [...new Set(scopes.flatMap((node) => actions(node, CLAWBACK_ENTRY)))];
}
/** Usable 【确认扣回】 entries for `ref`. */
export function clawbackEntries(ref: string): HTMLElement[] {
  return allClawbackEntries(ref).filter((node) => !isDisabled(node));
}
/** Waits for a usable 【确认扣回】 for `ref` (an assertion failure when there is none). */
export async function awaitEntry(ref: string): Promise<void> {
  await waitFor(() =>
    expect(clawbackEntries(ref).length, `a usable 【确认扣回】 for ${ref}`).toBeGreaterThan(0),
  );
}

/** Opens the confirmation dialog of `ref` from its drawer (or its row). */
export async function openClawback(server: Server, ref: string, id: string): Promise<HTMLElement> {
  if (drawersOf(ref).length === 0) await openDetail(server, ref, id);
  await awaitEntry(ref);
  await click(clawbackEntries(ref)[0]!);
  return clawbackDialog();
}

/** Presses the submit button of the confirmation dialog (twice in one go when asked). */
export async function pressConfirm(modal: HTMLElement, twice = false): Promise<void> {
  await click(action(modal, CONFIRM), twice);
  await settle();
}

/** The one open step-up dialog. */
export async function stepUp(): Promise<HTMLElement> {
  await waitFor(() => expect(stepUpDialogs(), 'one step-up (动态码) dialog').toHaveLength(1));
  return stepUpDialogs()[0]!;
}
/** Types the totp code into the step-up dialog and presses its submit button. */
export async function verify(modal: HTMLElement, twice = false): Promise<void> {
  await fill(within(modal).getByLabelText('动态码', { exact: true }), TOTP_CODE);
  await click(action(modal, VERIFY_BUTTON), twice);
  await settle();
}

/**
 * Confirms the open dialog (with `note` typed when given), passes the step-up and waits for the
 * clawback request. No clawback is sent before the step-up is passed.
 */
export async function confirmAndVerify(
  server: Server,
  modal: HTMLElement,
  id: string,
  note?: string,
): Promise<void> {
  const sent = server.clawbacks(id).length;
  if (note !== undefined) await fill(textbox(modal, NOTE), note);
  await pressConfirm(modal);
  const dialog = await stepUp();
  expect(server.clawbacks(id), 'no clawback before the step-up').toHaveLength(sent);
  await verify(dialog);
  await waitFor(() => expect(server.clawbacks(id)).toHaveLength(sent + 1));
  await settled(server);
}

/**
 * Confirms the open dialog; passes a step-up when the page asks for one (a still valid step-up
 * may be reused) and waits for the clawback request.
 */
export async function confirmMaybeVerify(
  server: Server,
  modal: HTMLElement,
  id: string,
): Promise<void> {
  const sent = server.clawbacks(id).length;
  await pressConfirm(modal);
  await waitFor(() =>
    expect(
      stepUpDialogs().length > 0 || server.clawbacks(id).length > sent,
      'a step-up dialog or the clawback request',
    ).toBe(true),
  );
  const dialog = stepUpDialogs()[0];
  if (dialog !== undefined) await verify(dialog);
  await waitFor(() => expect(server.clawbacks(id)).toHaveLength(sent + 1));
  await settled(server);
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

/** Presses 【查询】 of the filter. */
export async function query(): Promise<void> {
  await click(action(scope(), QUERY));
  await settle();
}

// ---- text that appeared after an action ----------------------------------------------------

/** Notices: alerts, status lines, antd message / notification, antd Alert, form explains. */
const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-form-item-explain';

export type TextSnapshot = ReadonlyMap<Text, string>;
/** Every text node on the page with its text, taken before an action. */
export function snapshotText(): TextSnapshot {
  return new Map(textNodesOf(document.body).map((node): [Text, string] => [node, node.data]));
}
function changedSince(before: TextSnapshot, keep: (element: Element) => boolean): string {
  return squash(
    textNodesOf(document.body)
      .filter((node) => {
        const element = node.parentElement;
        if (before.get(node) === node.data || element === null) return false;
        if (element.closest('textarea') !== null || !visible(element)) return false;
        return keep(element);
      })
      .map((node) => node.data)
      .join(''),
  );
}
/** New (or changed) text since `before` in notices and in dialogs / drawers. */
export function freshText(before: TextSnapshot): string {
  return changedSince(
    before,
    (element) => element.closest('[role="dialog"]') !== null || element.closest(NOTICES) !== null,
  );
}
/** New (or changed) text since `before` in notices only (alerts, messages, form explains). */
export function freshNotices(before: TextSnapshot): string {
  return changedSince(before, (element) => element.closest(NOTICES) !== null);
}

// ---- requests ------------------------------------------------------------------------------

/** The Idempotency-Key header of a request (null when missing). */
export function idempotencyOf(request: RequestLog): string | null {
  return request.headers.get('Idempotency-Key');
}
/** The X-Step-Up-Token header of a request (null when missing). */
export function stepUpHeader(request: RequestLog): string | null {
  return request.headers.get('X-Step-Up-Token');
}
/**
 * A clawback request: bearer, a handed-out step-up value, an Idempotency-Key, and the body `{}`
 * or `{note}` with the trimmed note when one was typed — never an amount or anything else.
 */
export function assertClawback(server: Server, request: RequestLog, note?: string): void {
  expect(request.headers.get('Authorization')).toBe(`Bearer ${BEARER}`);
  const value = idempotencyOf(request);
  expect(value, 'an Idempotency-Key header').not.toBeNull();
  expect(value!.trim(), 'a non-empty Idempotency-Key').not.toBe('');
  const proof = stepUpHeader(request);
  expect(proof, 'an X-Step-Up-Token header').not.toBeNull();
  expect(server.issued(), 'a step-up value the server handed out').toContain(proof);
  const body = request.body as Record<string, unknown> | undefined;
  expect(body, 'a JSON body ({} without a note)').toBeDefined();
  expect(
    Object.keys(body!).filter((name) => /fen|amount|yuan|money/i.test(name)),
    'no amount in the body',
  ).toEqual([]);
  if (note === undefined) {
    expect(body, 'the body is {} when no note was typed').toEqual({});
  } else {
    expect(Object.keys(body!), 'the note only').toEqual(['note']);
    expect(typeof body!['note']).toBe('string');
    expect((body!['note'] as string).trim()).toBe(note.trim());
  }
}
/** Every step-up request asked for the totp tier with the typed code. */
export function assertTotp(server: Server): void {
  for (const request of server.verifies())
    expect(request.body).toEqual({ tier: 'totp', code: TOTP_CODE });
}
/** The detail of `id` was read more than `count` times. */
export async function readAgain(server: Server, id: string, count: number): Promise<void> {
  await waitFor(() =>
    expect(
      server.requests('GET', detailPath(id)).length,
      'the detail is read again',
    ).toBeGreaterThan(count),
  );
}
/** The row of `ref` is still listed, with the status `name`. */
export async function stillListed(ref: string, name: string): Promise<void> {
  await waitFor(() => expect(rowsOf(scope(), [ref]), `${ref} is still listed`).toHaveLength(1));
  await waitFor(() => expect(statusCell(ref)).toContain(name));
}
