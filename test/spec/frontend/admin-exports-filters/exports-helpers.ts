// F1-08fd harness: mounts the real admin shell (browser router, signed in) at /exports over the
// fake server of ./exports-fixtures.ts and reads the page by roles, labels and visible text only.
// Every wait is a bounded loop on real time, so a missing behaviour fails an assertion instead of
// hanging. With `fakeTimers` the page's setTimeout / setInterval (and Date) are faked before the
// page renders and only move when the test advances them (tick / nextRead / quietFor); the
// interval of the rereads is the page's own constant, measured here, never assumed.
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL } from '../admin-audit-logs/audit-fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { COPY, EXPORTER, EXPORTS, NOW, type Server } from './exports-fixtures.ts';

/** Taken before any test fakes timers: the bounded waits below always run on real time. */
const realTimeout = globalThis.setTimeout;

/** Fake-time step while waiting for a reread, and the longest wait for one. */
export const STEP_MS = 250;
export const CAP_MS = 60_000;
const ROUNDS = 1000;

const sessions: AdminAuthProvider[] = [];

/** Unmounts the shell, signs out and puts the real timers back. */
export function unmount(): void {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
}

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

export interface MountOptions {
  readonly permissions?: PermissionSnapshot;
  /** Fakes setTimeout / setInterval too (Date is always fixed at NOW). */
  readonly fakeTimers?: boolean;
}

export async function mount(server: Server, options: MountOptions = {}): Promise<void> {
  installMediaQuery();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('direct fetch forbidden'))),
  );
  const auth = harness().create();
  sessions.push(auth);
  await signIn(auth);
  vi.useFakeTimers({
    toFake:
      options.fakeTimers === true
        ? ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
        : ['Date'],
  });
  vi.setSystemTime(new Date(NOW));
  window.history.replaceState(null, '', '/exports');
  const permissions = options.permissions ?? EXPORTER;
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: auth,
        permissionsProvider: async () => permissions,
        account: { username: 'ops-yi', displayName: '运营甲' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
      }),
    );
  });
  await settled(server);
}

// ---- waits ----------------------------------------------------------------------------------

export async function pause(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      realTimeout(() => resolve(), 10);
    });
  });
}

/** Waits (real time, bounded) until `check` holds, then asserts it. */
export async function until(check: () => boolean, label: string): Promise<void> {
  for (let round = 0; round < ROUNDS && !check(); round += 1) await pause();
  expect(check(), label).toBe(true);
}

/** No request in flight and React has flushed what followed. */
export async function settled(server: Server): Promise<void> {
  await until(() => server.pending === 0, 'no request in flight');
  for (let round = 0; round < 3; round += 1) await pause();
}

/** Queries of GET /admin/v1/exports, in order. */
export function reads(server: Server): Record<string, string>[] {
  return server.requests('GET', EXPORTS).map((request) => request.query);
}

/** Waits until exactly `count` list reads were sent and answered. */
export async function readsDone(server: Server, count: number): Promise<void> {
  await until(
    () => reads(server).length >= count && server.pending === 0,
    `list read #${count} sent and answered`,
  );
  for (let round = 0; round < 3; round += 1) await pause();
  expect(reads(server)).toHaveLength(count);
}

/** Advances the faked timers by `ms`. */
export async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Advances fake time in steps until the page reads the list again (at most CAP_MS); asserts
 * exactly one new read, lets it be answered, and returns the fake time it took.
 */
export async function nextRead(server: Server): Promise<number> {
  const before = reads(server).length;
  let elapsed = 0;
  while (elapsed < CAP_MS && reads(server).length === before) {
    await tick(STEP_MS);
    elapsed += STEP_MS;
  }
  expect(reads(server).length, `the list is read again within ${CAP_MS} ms`).toBe(before + 1);
  await settled(server);
  expect(reads(server).length, 'one reread at a time').toBe(before + 1);
  return elapsed;
}

/** Advances fake time by `ms` and asserts no list read was sent meanwhile. */
export async function quietFor(server: Server, ms: number): Promise<void> {
  const before = reads(server).length;
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) await tick(STEP_MS);
  await settled(server);
  expect(reads(server).length, `no list read during ${ms} ms`).toBe(before);
}

// ---- texts and controls ---------------------------------------------------------------------

export function main(): HTMLElement {
  const found = document.querySelector<HTMLElement>('main');
  expect(found, 'the shell renders its main landmark').not.toBeNull();
  return found!;
}

function trimmed(node: Element | undefined): string {
  return (node?.textContent ?? '').trim();
}

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

/** Texts of the elements without element children (icons without text left out). */
export function leafTexts(scope: Element): string[] {
  return Array.from(scope.querySelectorAll('*'))
    .filter((node) => node.children.length === 0)
    .map((node) => trimmed(node))
    .filter((text) => text !== '');
}

function nameOf(node: HTMLElement): string {
  const label = node.getAttribute('aria-label');
  return label !== null && label.trim() !== '' ? squash(label) : squash(node.textContent);
}

function controls(scope: Element): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]'),
  );
}

/** Names of the buttons and links of `scope` (spaces ignored). */
export function controlNames(scope: Element): string[] {
  return controls(scope).map(nameOf);
}

export function control(scope: Element, name: string): HTMLElement {
  const found = controls(scope).filter((node) => nameOf(node) === squash(name));
  expect(found, `one control named ${name}`).toHaveLength(1);
  return found[0]!;
}

export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
}

/** No 【重新导出】 anywhere on the page: no control and no text of that name. */
export function expectNoReexport(): void {
  expect(controlNames(main()).filter((name) => name.includes(COPY.reexport))).toEqual([]);
  expect(leafTexts(main()).filter((text) => text.includes(COPY.reexport))).toEqual([]);
}

/** No error toast, no error alert or result on the page. */
export function expectNoError(): void {
  expect(document.querySelectorAll('.ant-message-notice, .ant-notification-notice')).toHaveLength(
    0,
  );
  expect(main().querySelectorAll('[role="alert"], .ant-alert, .ant-result')).toHaveLength(0);
  expect(leafTexts(main()).filter((text) => text === COPY.loadFailed)).toEqual([]);
}

// ---- table ------------------------------------------------------------------------------------

export function tableTitles(): string[] {
  const area = document.querySelector('main');
  if (area === null) return [];
  return Array.from(area.querySelectorAll('thead th'))
    .filter((cell) => !cell.classList.contains('ant-table-cell-scrollbar'))
    .map((cell) => trimmed(cell));
}

function bodyRows(): HTMLElement[] {
  const area = document.querySelector('main');
  if (area === null) return [];
  return Array.from(area.querySelectorAll<HTMLElement>('tbody > tr')).filter(
    (row) =>
      row.getAttribute('aria-hidden') !== 'true' &&
      !row.classList.contains('ant-table-measure-row') &&
      !row.classList.contains('ant-table-placeholder'),
  );
}

function cellOf(row: HTMLElement, title: string): Element | undefined {
  const index = tableTitles().indexOf(title);
  return index < 0 ? undefined : row.children[index];
}

/** 任务编号 of the rows shown, in order. */
export function rowIds(): string[] {
  return bodyRows().map((row) => trimmed(cellOf(row, '任务编号')));
}

/** Waits until the rows shown are exactly `expected`, then asserts it. */
export async function rowsAre(expected: readonly string[]): Promise<void> {
  await until(
    () => JSON.stringify(rowIds()) === JSON.stringify(expected),
    `rows ${expected.join(', ')}`,
  );
  expect(rowIds()).toEqual(expected);
}

function rowOf(id: string): HTMLElement {
  const found = bodyRows().filter((row) => trimmed(cellOf(row, '任务编号')) === id);
  expect(found, `one row ${id}`).toHaveLength(1);
  return found[0]!;
}

function cell(id: string, title: string): Element {
  const found = cellOf(rowOf(id), title);
  expect(found, `column ${title} of row ${id}`).toBeDefined();
  return found!;
}

/** Texts of the 状态 cell of row `id` (status name, then progress / rows / failure). */
export function statusOf(id: string): string[] {
  return leafTexts(cell(id, '状态'));
}

/** Whole text of the 资源 cell of row `id`. */
export function resourceOf(id: string): string {
  return trimmed(cell(id, '资源'));
}

/** Names of the controls of row `id` (every cell). */
export function actionsOf(id: string): string[] {
  return controlNames(rowOf(id));
}

const NEXT =
  '.ant-pagination [title="Next Page"], .ant-pagination [title="下一页"], .ant-pagination [aria-label="Next Page"], .ant-pagination [aria-label="下一页"]';

export async function nextPage(server: Server): Promise<void> {
  const count = reads(server).length;
  const next = main().querySelector<HTMLElement>(NEXT);
  expect(next, 'pagination 「下一页」').not.toBeNull();
  await click(next!);
  await readsDone(server, count + 1);
}

// ---- status tabs ------------------------------------------------------------------------------

function tabNodes(): HTMLElement[] {
  return within(main()).queryAllByRole('tab');
}

export function tabNames(): string[] {
  return tabNodes().map((node) => squash(node.textContent));
}

export function selectedTabs(): string[] {
  return tabNodes()
    .filter((node) => node.getAttribute('aria-selected') === 'true')
    .map((node) => squash(node.textContent));
}

export function tab(name: string): HTMLElement {
  const found = tabNodes().filter((node) => squash(node.textContent) === name);
  expect(found, `one tab named ${name}`).toHaveLength(1);
  return found[0]!;
}

/** Clicks the status tab `name` and waits for its one list read. */
export async function chooseTab(server: Server, name: string): Promise<void> {
  const count = reads(server).length;
  await click(tab(name));
  await readsDone(server, count + 1);
}

/** No count next to a status: no Badge / ScrollNumber anywhere on the page. */
export function expectNoCounts(): void {
  expect(main().querySelectorAll('.ant-badge, .ant-badge-count, .ant-scroll-number')).toHaveLength(
    0,
  );
}

// ---- 来源页面 ---------------------------------------------------------------------------------

export function sourceSelect(): HTMLElement {
  const found = within(main()).queryAllByRole('combobox', { name: COPY.source });
  expect(found, `one select labelled ${COPY.source}`).toHaveLength(1);
  return found[0]!;
}

/** The value shown in 来源页面. */
export function sourceShown(): string {
  const select = sourceSelect().closest('.ant-select');
  return trimmed(select?.querySelector('.ant-select-selection-item') ?? undefined);
}

function openOptions(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    ),
  );
}

async function openSource(): Promise<void> {
  const combo = sourceSelect();
  if (combo.getAttribute('aria-expanded') !== 'true')
    await act(async () => {
      fireEvent.mouseDown(combo);
    });
  await until(() => openOptions().length > 0, `the ${COPY.source} options are shown`);
}

/** Opens 来源页面 and returns its option names, in order. */
export async function sourceOptions(): Promise<string[]> {
  await openSource();
  return openOptions().map((node) => trimmed(node));
}

/** Picks `name` in 来源页面 (no request is expected from this alone). */
export async function chooseSource(name: string): Promise<void> {
  await openSource();
  const option = openOptions().find((node) => trimmed(node) === name);
  expect(option, `option ${name} of ${COPY.source}`).toBeDefined();
  await click(option!);
  await pause();
}

// ---- 发起时间 ---------------------------------------------------------------------------------

/** The start and end inputs of 发起时间 (one form item, two inputs). */
export function timeInputs(): HTMLInputElement[] {
  const labels = Array.from(main().querySelectorAll('label')).filter(
    (node) => trimmed(node) === COPY.time,
  );
  expect(labels, `one label ${COPY.time}`).toHaveLength(1);
  const item = labels[0]!.closest('.ant-form-item');
  expect(item, `${COPY.time} sits in a form item`).not.toBeNull();
  const inputs = Array.from(item!.querySelectorAll('input')).filter(
    (input) => input.type !== 'hidden',
  );
  expect(inputs, `${COPY.time} has a start and an end input`).toHaveLength(2);
  return inputs;
}

/** Types a day (YYYY-MM-DD) into one 发起时间 input and confirms it with Enter. */
export async function typeDay(input: HTMLInputElement, day: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    input.focus();
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: day } });
  });
  await pause();
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
  });
  await pause();
}

/** Leaves the 发起时间 field (focus goes away), so what was typed is kept. */
export async function leaveTime(): Promise<void> {
  await act(async () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      fireEvent.blur(active);
      active.blur();
    }
  });
  for (let round = 0; round < 5; round += 1) await pause();
}

/** Presses 【查询】 and waits for its one list read. */
export async function query(server: Server): Promise<void> {
  const count = reads(server).length;
  await click(control(main(), COPY.query));
  await readsDone(server, count + 1);
}
