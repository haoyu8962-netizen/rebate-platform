// F1-08fa harness: mounts the real admin shell (frozen admin-planned kit: browser router, signed-in
// guard) at /ledger over the fake server of ./fixtures.ts, and reads what the page shows by visible
// text, roles and labels only. No page module is imported, so a missing page is an assertion
// failure, not an import error.
//
// Page layout the tests pin (task 依据摘录 第 2–5 条):
// - a UID form (one input labelled 「用户 UID」 and its own 【查询】) is all there is before a query;
// - after a user was read: the fund summary (label / value items) and, in a second form, the filters
//   (流水类型, 子类型, 子户, 会计日起, 会计日止, 业务单号) with their own 【查询】【重置】, above one
//   ledger table with pagination;
// - 【导出记录】 (a link or button) is always there and only navigates to /exports.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { click, mainElement, mount, settled } from '../admin-planned/kit.ts';
import { COPY, FILTER_LABEL, FUND_VIEW, ROUTE, type Server } from './fixtures.ts';

export { click, settled };

export async function mountLedger(
  server: Server,
  snapshot: PermissionSnapshot = FUND_VIEW,
  route: string = ROUTE,
): Promise<void> {
  await mount({ route, fetch: server.fetch, snapshot });
  await settle();
}

export function main(): HTMLElement {
  return mainElement();
}

export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
function trimmed(node: Element): string {
  return (node.textContent ?? '').trim();
}

/**
 * The texts the page shows as a whole: for every element, its trimmed text when none of its
 * element children carries that same text.
 */
export function ownTexts(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('*')).flatMap((node) => {
    const text = trimmed(node);
    if (text === '') return [];
    if (Array.from(node.children).some((child) => trimmed(child) === text)) return [];
    return [text];
  });
}
/** `scope` has an element whose whole text is exactly `text`. */
export function shows(scope: HTMLElement, text: string): boolean {
  return ownTexts(scope).includes(text);
}

// ---- controls ------------------------------------------------------------------------------

function nameOf(node: HTMLElement): string {
  const label = node.getAttribute('aria-label');
  return label !== null && label.trim() !== '' ? squash(label) : squash(node.textContent);
}
/** Buttons and links of `scope`, by name (text, or aria-label when given; spaces ignored). */
export function controls(scope: HTMLElement): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]'),
  );
}
export function controlNames(scope: HTMLElement): string[] {
  return controls(scope).map(nameOf);
}
export function controlsNamed(scope: HTMLElement, name: string): HTMLElement[] {
  return controls(scope).filter((node) => nameOf(node) === squash(name));
}
export function control(scope: HTMLElement, name: string): HTMLElement {
  const found = controlsNamed(scope, name);
  expect(found, `one control named ${name}`).toHaveLength(1);
  return found[0]!;
}
export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('[aria-disabled="true"], fieldset[disabled]') !== null
  );
}

// ---- fields --------------------------------------------------------------------------------

function isInput(node: HTMLElement): node is HTMLInputElement {
  return node instanceof HTMLInputElement && !['hidden', 'checkbox', 'radio'].includes(node.type);
}
/** The inputs of `scope` labelled exactly `label` (label element, aria-label or aria-labelledby). */
export function inputsLabelled(scope: HTMLElement, label: string): HTMLInputElement[] {
  return within(scope).queryAllByLabelText(label, { exact: true }).filter(isInput);
}
export function inputLabelled(scope: HTMLElement, label: string): HTMLInputElement {
  const found = inputsLabelled(scope, label);
  expect(found, `one input labelled ${label}`).toHaveLength(1);
  return found[0]!;
}

export function uidInput(): HTMLInputElement {
  return inputLabelled(main(), COPY.uidLabel);
}
function formOf(input: HTMLElement): HTMLElement {
  const form = input.closest<HTMLElement>('form');
  expect(form, 'the field sits in a form').not.toBeNull();
  return form!;
}
export function uidForm(): HTMLElement {
  return formOf(uidInput());
}
/** The filter form (holds 流水类型); a different form than the UID one. */
export function filterForm(): HTMLElement {
  const form = formOf(inputLabelled(main(), FILTER_LABEL.ledgerType));
  expect(form === uidForm(), 'the filters have a form of their own').toBe(false);
  return form;
}
export function filterField(label: string): HTMLInputElement {
  return inputLabelled(filterForm(), label);
}

export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}
/** Types a day (YYYY-MM-DD) into a plain input or an antd DatePicker input and confirms it. */
export async function fillDay(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    fireEvent.blur(input);
  });
  await settle();
}

/** Errors shown with `input`: its form item's explain text, or its error / description ids. */
export function fieldErrors(input: HTMLElement): string[] {
  const ids = [input.getAttribute('aria-errormessage') ?? ''];
  if (input.getAttribute('aria-invalid') === 'true')
    ids.push(input.getAttribute('aria-describedby') ?? '');
  const texts = ids
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '');
  const item = input.closest('.ant-form-item');
  if (item !== null)
    for (const node of Array.from(item.querySelectorAll('.ant-form-item-explain-error')))
      texts.push(node.textContent ?? '');
  return [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
}

function dropdownOptions(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
    ),
  );
}
/** Picks the option whose text is exactly `option` in the select labelled `label` in `scope`. */
export async function choose(scope: HTMLElement, label: string, option: string): Promise<void> {
  const combo = inputLabelled(scope, label);
  expect(combo.getAttribute('role'), `${label} is a select`).toBe('combobox');
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  let target: HTMLElement | undefined;
  await waitFor(() => {
    target = dropdownOptions().find((node) => trimmed(node) === option);
    expect(target, `option ${option} of ${label}`).toBeDefined();
  });
  await click(target!);
  await settle();
}

// ---- flows ---------------------------------------------------------------------------------

/** Types `userId` into 「用户 UID」 and presses the UID form's 【查询】. */
export async function queryUser(server: Server, userId: string): Promise<void> {
  await typeInto(uidInput(), userId);
  await click(control(uidForm(), COPY.query));
  await settled(server);
  await settle();
}
/** Presses the filter form's 【查询】. */
export async function applyFilters(server: Server): Promise<void> {
  await click(control(filterForm(), COPY.query));
  await settled(server);
  await settle();
}
export async function resetFilters(server: Server): Promise<void> {
  await click(control(filterForm(), COPY.reset));
  await settled(server);
  await settle();
}

const NEXT =
  '.ant-pagination [title="Next Page"], .ant-pagination [title="下一页"], .ant-pagination [aria-label="Next Page"], .ant-pagination [aria-label="下一页"]';
export async function nextPage(server: Server): Promise<void> {
  const next = main().querySelector<HTMLElement>(NEXT);
  expect(next, 'pagination 「下一页」').not.toBeNull();
  await click(next!);
  await settled(server);
  await settle();
}

// ---- summary -------------------------------------------------------------------------------

const LABEL_SELECTOR = '.ant-descriptions-item-label, dt';
/** The label / value items of the main area (antd Descriptions, or dt / dd), in order. */
export function summaryPairs(): [string, string][] {
  return Array.from(main().querySelectorAll<HTMLElement>(LABEL_SELECTOR)).flatMap(
    (label): [string, string][] => {
      const content = label.nextElementSibling;
      if (content === null || content.matches(LABEL_SELECTOR)) return [];
      return [[trimmed(label), trimmed(content)]];
    },
  );
}

// ---- table ---------------------------------------------------------------------------------

/** Column titles of the main area's table header. */
export function tableTitles(): string[] {
  return Array.from(main().querySelectorAll<HTMLElement>('thead th'))
    .filter((cell) => !cell.classList.contains('ant-table-cell-scrollbar'))
    .map(trimmed);
}
/** Body rows of the main area's tables (antd measure and placeholder rows aside). */
export function dataRows(): HTMLElement[] {
  return Array.from(main().querySelectorAll<HTMLElement>('tbody > tr')).filter(
    (row) =>
      row.getAttribute('aria-hidden') !== 'true' &&
      !row.classList.contains('ant-table-measure-row') &&
      !row.classList.contains('ant-table-placeholder'),
  );
}
/** Every body row as its cells' texts. */
export function tableRows(): string[][] {
  return dataRows().map((row) => Array.from(row.children).map(trimmed));
}
export function tableCount(): number {
  return main().querySelectorAll('table').length;
}

/** Something in the main area says it is loading. */
export function busy(): boolean {
  const area = main();
  return (
    area.querySelector('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') !== null ||
    /加载/.test(area.textContent ?? '')
  );
}

// ---- shell ---------------------------------------------------------------------------------

export function breadcrumb(): string[] {
  const nav = screen.queryByRole('navigation', { name: '面包屑' });
  expect(nav, 'top-bar breadcrumb').not.toBeNull();
  return within(nav!)
    .queryAllByRole('listitem')
    .map((node) => squash(node.textContent))
    .filter((text) => text !== '' && text !== '/');
}
export function sidebarLinks(name: string): HTMLElement[] {
  const nav = screen.queryByRole('navigation', { name: '主导航' });
  expect(nav, 'sidebar 主导航').not.toBeNull();
  return within(nav!).queryAllByRole('link', { name });
}
/** The page title (first h4 of the main area, as the shell's pages render it). */
export function pageTitle(): string {
  return trimmed(main().querySelector('h4') ?? document.createElement('h4'));
}
