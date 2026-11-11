// F1-15b harness: mounts the real shell (frozen admin-planned kit, browser router) on /config or
// /invite-rewards over the fake server of ./fixtures.ts, and finds what the page shows by visible
// text, roles and labels only (no production helpers, no page internals).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { formatYuanAdmin } from '../../../../packages/money/src/index.ts';
import { openInviteGroup } from '../admin-invite-reward-config/helpers.ts';
import { SUPER, click, mainElement, mount, reset, settled } from '../admin-planned/kit.ts';
import { squash } from '../admin-platform-icons/helpers.ts';
import { MENU } from '../admin-shell/fixtures.ts';
import { REWARDS, type RewardServer } from './fixtures.ts';

export { SUPER, click, mainElement, reset, settled, squash };

/** Every config.* point, no fund.view: sees the configuration center only. */
export const CONFIG_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: ['config.general', 'config.business', 'config.risk'],
};
/** A non-super account with one config point and fund.view. */
export const FUND_AND_CONFIG: PermissionSnapshot = {
  isSuper: false,
  permissions: ['config.business', 'fund.view'],
};

export const SUBPAGE = '/invite-rewards';
export const NO_PERMISSION = /无权限|没有.*权限|权限不足/;
/** Write controls a read-only page must not offer (no re-issue, no change of a result). */
export const WRITE_CONTROL = /补发|重发|重新发放|手工|手动|修改|编辑|删除|作废|新增|新建|保存|提交/;
/** Budget figure labels (task 依据摘录 第 3 条), each shown together with its amount. */
export const TODAY_GRANTED = /今日已发/;
export const TODAY_LEFT = /今日剩余/;
export const RESERVED = /累计已占用/;
export const TOTAL_GRANTED = /累计已发/;
export const TOTAL_LEFT = /累计剩余/;
export const ANY_FIGURE = /今日已发|今日剩余|累计已占用|累计已发|累计剩余/;

export async function mountAt(
  server: RewardServer,
  route: string,
  snapshot: PermissionSnapshot = SUPER,
): Promise<void> {
  await mount({ route, fetch: server.fetch, snapshot });
}

/** Opens the configuration center's invite group (frozen F1-15a flow). */
export async function openBudgetGroup(server: RewardServer): Promise<void> {
  await openInviteGroup(server.config);
  await settled(server);
}

const AMOUNT_TEXT = /\d[\d,]*\.\d{2}/g;

export function amountsIn(text: string | null | undefined): string[] {
  return squash(text).match(AMOUNT_TEXT) ?? [];
}

/**
 * The innermost element of the main area holding both the label and an amount (an antd
 * Statistic, a Descriptions item, a labelled line …). Exactly one must exist.
 */
export function figure(label: RegExp): HTMLElement {
  const holds = (node: Element): boolean =>
    label.test(squash(node.textContent)) && amountsIn(node.textContent).length > 0;
  const candidates = Array.from(mainElement().querySelectorAll('*')).filter(holds);
  const innermost = candidates.filter(
    (node) => !candidates.some((other) => other !== node && node.contains(other)),
  );
  expect(innermost, `one budget figure labelled ${String(label)}`).toHaveLength(1);
  return innermost[0] as HTMLElement;
}

/** The figure shows `fen` in the console's amount format, as its first amount, never negative. */
export function expectFigure(label: RegExp, fen: bigint): void {
  const text = squash(figure(label).textContent);
  const expected = squash(formatYuanAdmin(fen));
  expect(text, String(label)).toContain(expected);
  const shown = amountsIn(text)[0];
  expect(shown, String(label)).toBe(amountsIn(expected)[0]);
  // No minus sign right before the amount (directly or before its currency sign).
  const before = text.slice(0, text.indexOf(shown ?? '')).slice(-2);
  expect(before, `${String(label)} is not negative`).not.toMatch(/[-−]/);
}

/** Links or buttons of the main area that lead to the record subpage. */
export function entries(): HTMLElement[] {
  return ['link', 'button'].flatMap((role) =>
    within(mainElement()).queryAllByRole(role, { name: /发放记录/ }),
  );
}

/** Buttons and links of `scope` whose name reads as a write operation. */
export function writeControls(scope: HTMLElement): HTMLElement[] {
  return ['link', 'button']
    .flatMap((role) => within(scope).queryAllByRole(role))
    .filter((node) =>
      WRITE_CONTROL.test(squash(node.textContent) + (node.getAttribute('aria-label') ?? '')),
    );
}

/** Table body rows of the main area that show this (masked) phone number. */
export function rowsWith(phone: string): HTMLElement[] {
  return Array.from(mainElement().querySelectorAll<HTMLElement>('tbody tr')).filter((node) =>
    (node.textContent ?? '').includes(phone),
  );
}

export function rowOf(phone: string): HTMLElement {
  const found = rowsWith(phone);
  expect(found, `one table row for ${phone}`).toHaveLength(1);
  return found[0]!;
}

export async function listed(phone: string): Promise<HTMLElement> {
  await waitFor(() => expect(rowsWith(phone), `row for ${phone}`).toHaveLength(1));
  return rowOf(phone);
}

/** A label and the text it labels: a table cell under its column header, a Descriptions item. */
export interface Unit {
  readonly label: string;
  readonly content: string;
}

/**
 * The header text of every leaf column of the table holding `row` (grouped headers joined top to
 * bottom, so a column 「邀请人」 under a group 「两方结果」 reads 「两方结果 邀请人」).
 */
function columnLabels(row: HTMLElement): string[] {
  const scope = row.closest('.ant-table') ?? row.closest('table');
  const head = scope?.querySelector('thead');
  expect(head, 'a table header above the row').toBeTruthy();
  const grid: string[][] = [];
  const lines: HTMLTableRowElement[] = head ? Array.from(head.rows) : [];
  lines.forEach((line, top) => {
    const cells = (grid[top] = grid[top] ?? []);
    let column = 0;
    for (const cell of Array.from(line.cells)) {
      while (cells[column] !== undefined) column += 1;
      const across = Math.max(1, cell.colSpan);
      const down = Math.max(1, cell.rowSpan);
      for (let r = top; r < top + down; r += 1) {
        const target = (grid[r] = grid[r] ?? []);
        for (let c = column; c < column + across; c += 1) target[c] = squash(cell.textContent);
      }
      column += across;
    }
  });
  const width = Math.max(0, ...grid.map((cells) => cells.length));
  return Array.from({ length: width }, (_, column) => {
    const parts: string[] = [];
    for (const cells of grid) {
      const text = cells[column];
      if (text !== undefined && text !== '' && parts.at(-1) !== text) parts.push(text);
    }
    return parts.join(' ');
  });
}

/** Every cell of a table body row, labelled with its column header. */
export function rowUnits(row: HTMLElement): Unit[] {
  const labels = columnLabels(row);
  const units: Unit[] = [];
  let column = 0;
  expect(row, 'a table body row').toBeInstanceOf(HTMLTableRowElement);
  const cells = row instanceof HTMLTableRowElement ? Array.from(row.cells) : [];
  for (const cell of cells) {
    units.push({ label: labels[column] ?? '', content: squash(cell.textContent) });
    column += Math.max(1, cell.colSpan);
  }
  return units;
}

/** The one cell of `row` under the one leaf column whose header matches `header`. */
export function cellUnder(row: HTMLElement, header: RegExp): string {
  const found = rowUnits(row).filter((unit) => header.test(unit.label));
  expect(
    found.map((unit) => unit.label),
    `one column headed ${String(header)}`,
  ).toHaveLength(1);
  return found[0]?.content ?? '';
}

const LABEL_SELECTOR = '.ant-descriptions-item-label, dt, tbody th, .ant-form-item-label';

/**
 * Label / content pairs of a detail view (antd Descriptions, bordered or not; dt / dd). With
 * none, the whole text is one unlabelled unit (split by the party names it contains).
 */
export function dialogUnits(scope: HTMLElement): Unit[] {
  const units = Array.from(scope.querySelectorAll<HTMLElement>(LABEL_SELECTOR)).flatMap(
    (label): Unit[] => {
      const content = label.nextElementSibling;
      if (content === null || content.matches(LABEL_SELECTOR)) return [];
      return [{ label: squash(label.textContent), content: squash(content.textContent) }];
    },
  );
  return units.length > 0 ? units : [{ label: '', content: squash(scope.textContent) }];
}

export type Party = 'inviter' | 'invitee';
export type PartyTexts = Readonly<Record<Party, string>>;

const INVITEE_NAME = /被邀请[人方]/;
const PARTY_NAME = /被邀请[人方]|邀请[人方]/g;

function partyOf(label: string): Party | null {
  const invitee = INVITEE_NAME.test(label);
  const inviter = /邀请[人方]/.test(label.replace(/被邀请[人方]/g, ''));
  if (invitee === inviter) return null;
  return invitee ? 'invitee' : 'inviter';
}

/**
 * What the units show for each party: a unit whose label names one party (「邀请人结果」,
 * 「不发原因（被邀请人）」, a column 「被邀请人」 under 「两方结果」) belongs to it as a whole;
 * otherwise its content is split at the party names it contains (「邀请人：不发 被邀请人：已发」).
 * Text named for neither party is left out.
 */
export function byParty(units: readonly Unit[]): PartyTexts {
  const parts: Record<Party, string[]> = { inviter: [], invitee: [] };
  for (const unit of units) {
    const own = partyOf(unit.label);
    const marks = Array.from(unit.content.matchAll(PARTY_NAME));
    const first = marks[0]?.index ?? unit.content.length;
    if (own !== null && first > 0) parts[own].push(unit.content.slice(0, first));
    marks.forEach((mark, index) => {
      const party = INVITEE_NAME.test(mark[0]) ? 'invitee' : 'inviter';
      const start = (mark.index ?? 0) + mark[0].length;
      const end = marks[index + 1]?.index ?? unit.content.length;
      parts[party].push(unit.content.slice(start, end));
    });
  }
  return { inviter: parts.inviter.join(' | '), invitee: parts.invitee.join(' | ') };
}

/** Chinese names of the skip reasons the attribution tests use (enum invite_reward_skip_reason). */
export const RISK_REASON = /封禁|申诉|冻结|风控|受限|限制/;
export const MINOR_REASON = /未满|未成年/;

/**
 * One party shows 不发 with its reason, the other 已发 and neither 不发 nor that reason (results
 * and reasons are never swapped between the parties).
 */
export function expectParties(shown: PartyTexts, skipped: Party, reason: RegExp): void {
  const paid: Party = skipped === 'inviter' ? 'invitee' : 'inviter';
  expect(shown[skipped], `${skipped} result`).toMatch(/不发/);
  expect(shown[skipped], `${skipped} skip reason`).toMatch(reason);
  expect(shown[skipped], `${skipped} is not paid`).not.toMatch(/已发/);
  expect(shown[paid], `${paid} result`).toMatch(/已发/);
  expect(shown[paid], `${paid} is paid`).not.toMatch(/不发/);
  expect(shown[paid], `${paid} has no skip reason`).not.toMatch(reason);
}

/** Column header texts of the main area's table. */
export function headers(): string[] {
  return within(mainElement())
    .queryAllByRole('columnheader')
    .map((node) => squash(node.textContent))
    .filter((text) => text !== '');
}

/** Query strings of the list requests, in order. */
export function listQueries(server: RewardServer): Record<string, string>[] {
  return server.requests('GET', REWARDS).map((request) => request.query);
}

export function lastQuery(server: RewardServer): Record<string, string> | undefined {
  return listQueries(server).at(-1);
}

/** page_size of the first list request (the page's own choice, 1 … 200). */
export function firstPageSize(server: RewardServer): string {
  const first = listQueries(server)[0];
  expect(first, 'a first list request').toBeDefined();
  const size = Number(first?.['page_size']);
  expect(Number.isInteger(size) && size >= 1 && size <= 200, `page_size ${size}`).toBe(true);
  return String(size);
}

/** Label text of an input: aria-label, aria-labelledby, <label>, placeholder, form item label. */
function labelOf(input: HTMLElement): string {
  const parts: (string | null | undefined)[] = [
    input.getAttribute('aria-label'),
    input.getAttribute('placeholder'),
    input.closest('label')?.textContent,
    input.closest('.ant-form-item')?.querySelector('.ant-form-item-label')?.textContent,
  ];
  for (const id of (input.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean))
    parts.push(document.getElementById(id)?.textContent);
  if (input.id !== '')
    for (const label of Array.from(document.querySelectorAll('label')))
      if (label.htmlFor === input.id) parts.push(label.textContent);
  return squash(parts.filter((part) => typeof part === 'string').join(' '));
}

/** The one input of the main area whose label matches `include` (and not `exclude`). */
export function field(include: RegExp, exclude?: RegExp): HTMLInputElement {
  const found = Array.from(
    mainElement().querySelectorAll<HTMLInputElement>(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
    ),
  ).filter((input) => {
    const label = labelOf(input);
    return include.test(label) && (exclude === undefined || !exclude.test(label));
  });
  expect(found, `one filter field labelled ${String(include)}`).toHaveLength(1);
  return found[0]!;
}

export const INVITEE_FIELD = /被邀请人/;
export const INVITER_FIELD = /邀请人/;
export const STATUS_FIELD = /状态/;
export const FROM_FIELD = /起|开始|从/;
export const TO_FIELD = /止|结束|至/;

export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

export async function typeInvitee(value: string): Promise<void> {
  await typeInto(field(INVITEE_FIELD), value);
}

export async function typeInviter(value: string): Promise<void> {
  await typeInto(field(INVITER_FIELD, INVITEE_FIELD), value);
}

/** Types a calendar day (YYYY-MM-DD) into a date field and confirms it (Enter, then blur). */
export async function typeDay(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    fireEvent.blur(input);
  });
}

export async function typeRange(from: string, to: string): Promise<void> {
  await typeDay(field(FROM_FIELD), from);
  await typeDay(field(TO_FIELD), to);
}

/** Chooses the option whose text matches `option` in the status select (antd Select). */
export async function pickStatus(option: RegExp): Promise<void> {
  const input = field(STATUS_FIELD);
  expect(input.getAttribute('role'), 'the status filter is a select').toBe('combobox');
  await act(async () => {
    fireEvent.mouseDown(input);
  });
  const options = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option')).filter((node) =>
      option.test(node.textContent ?? ''),
    );
  await waitFor(() =>
    expect(options().length, `status option ${String(option)}`).toBeGreaterThan(0),
  );
  await click(options()[0]!);
}

/** Presses 查询 (or 搜索 / 筛选) when the page has one; pages that filter on change need none. */
export async function submitFilters(): Promise<void> {
  const run = within(mainElement()).queryAllByRole('button', { name: /查询|搜索|筛选/ });
  if (run.length > 0) await click(run[0]!);
}

export async function nextPage(): Promise<void> {
  const next = mainElement().querySelector<HTMLElement>(
    '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
  );
  expect(next, 'page-number pagination next control').not.toBeNull();
  await click(next!);
}

/** The 详情 / 查看 control of a row (button or link). */
export function detailControl(row: HTMLElement): HTMLElement {
  const found = ['button', 'link'].flatMap((role) =>
    within(row).queryAllByRole(role, { name: /详情|查看/ }),
  );
  expect(found, 'one 详情 control in the row').toHaveLength(1);
  return found[0]!;
}

/** Open dialogs (antd Drawer or Modal), closed drawers left mounted excluded. */
export function openDialogs(): HTMLElement[] {
  return screen.queryAllByRole('dialog').filter((node) => {
    const drawer = node.closest('.ant-drawer');
    if (drawer !== null && !drawer.classList.contains('ant-drawer-open')) return false;
    const wrap = node.closest<HTMLElement>('.ant-modal-wrap');
    return wrap === null || wrap.style.display !== 'none';
  });
}

export async function detailDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(openDialogs(), 'one open detail drawer').toHaveLength(1));
  return openDialogs()[0]!;
}

export function breadcrumb(): string[] {
  const nav = screen.queryByRole('navigation', { name: '面包屑' });
  expect(nav, 'top-bar breadcrumb').not.toBeNull();
  return within(nav!)
    .queryAllByRole('listitem')
    .map((node) => squash(node.textContent))
    .filter((text) => text !== '' && text !== '/');
}

function sidebar(): HTMLElement {
  const nav = screen.queryByRole('navigation', { name: '主导航' });
  expect(nav, 'sidebar 主导航').not.toBeNull();
  return nav!;
}

export function menuNames(): string[] {
  const links = within(sidebar()).queryAllByRole('link');
  return links.map((node) => squash(node.textContent));
}

/** What a super admin's sidebar lists: the workbench, then the frozen catalogue. */
export function superMenuNames(): string[] {
  return ['工作台', ...MENU.map((entry) => squash(entry[2]))];
}

export function menuLink(name: string): HTMLElement {
  const links = within(sidebar()).queryAllByRole('link', { name });
  expect(links, `menu link ${name}`).toHaveLength(1);
  return links[0]!;
}

export function sidebarLinksTo(path: string): Element[] {
  return Array.from(sidebar().querySelectorAll('a')).filter(
    (node) => node.getAttribute('href') === path,
  );
}

/** Raw enum codes that must never show as such (the page shows their Chinese names). */
export const RAW_CODES = [
  'qualified',
  'deferred',
  'processed',
  'voided',
  'expired',
  'granted',
  'skipped',
  'same_device',
  'risk_restricted',
  'order_clawed_back',
  'landing',
  'register',
  'backfill',
];

export function rawCodesIn(scope: HTMLElement): string[] {
  const text = scope.textContent ?? '';
  return RAW_CODES.filter((code) => text.includes(code));
}
