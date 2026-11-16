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
  createPayoutServer,
  type PayoutServer,
} from '../admin-payouts-readonly/fixtures.ts';
import {
  COLUMN,
  TAB,
  gridWith,
  isShown,
  labelled,
  listed,
  main,
  openTab,
  rowIn,
  squash,
  textOf,
  values,
  writeEntries,
} from '../admin-payouts-readonly/helpers.ts';
import {
  BATCHES,
  CANCEL,
  CHECK_TITLE,
  CODE,
  ENTRY,
  EXECUTOR,
  STEP_FIELD,
  STEP_SUBMIT,
  STEP_TITLE,
  SUBMIT,
  VERIFY,
  VIEW_EXECUTE,
  allowedHereToo,
  allRows,
  executeSamples,
  ok,
  passOf,
  postOf,
  verified,
  type BatchRequest,
  type BatchResult,
  type Grants,
  type Overview,
  type RequestLog,
  type Withdrawal,
} from './fixtures.ts';

// 【执行所选】 is reached only through the real shell (createAdminShell, menu `withdrawals`, tab
// 打款队列): no page module is imported, so a missing entry is an assertion failure. Only frozen pure
// helpers of the read-only suites are reused; their mount helpers are not (their request guards
// forbid the batch POST of this task). The guard here allows the read-only tab's reads, the
// dynamic-code verification and POST /admin/v1/payout-batches, nothing else.
configure({ asyncUtilTimeout: 10_000 });
export { isShown, main, squash, textOf, writeEntries };

/** Per-test timeout of a flow with one mount (antd's first render of a file is slow in jsdom). */
export const FLOW_TIMEOUT = 60_000;
/** Per-test timeout of a flow that mounts the page several times. */
export const MULTI_TIMEOUT = 150_000;

const mounted: {
  readonly server: PayoutServer;
  readonly direct: { readonly mock: { readonly calls: readonly unknown[] } };
}[] = [];

afterEach(() => {
  const current = mounted.splice(0);
  try {
    for (const { server, direct } of current) {
      expect(direct.mock.calls.length, 'no direct fetch').toBe(0);
      const others = server.log.filter((request) => !allowedHereToo(request));
      expect(
        others.map((r) => `${r.method} ${r.path}`),
        'only the queue reads, the dynamic-code verification and POST /admin/v1/payout-batches',
      ).toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

export interface Setup {
  readonly withdrawals?: readonly Withdrawal[];
  readonly overview?: Overview;
  /** Permission points the server checks; defaults to fund.view + payout.execute. */
  readonly permissions?: Grants;
  /** How many verified dynamic codes the server answers (passes 1…n); defaults to 3. */
  readonly passes?: number;
}

/** The payout server over executeSamples() with `passes` scripted verifications. */
export function serverFor(setup: Setup = {}): PayoutServer {
  const server = createPayoutServer({
    withdrawals: setup.withdrawals ?? executeSamples(),
    ...(setup.overview === undefined ? {} : { overview: setup.overview }),
    permissions: setup.permissions ?? VIEW_EXECUTE,
  });
  for (let n = 1; n <= (setup.passes ?? 3); n += 1)
    server.onceWhere(postOf(VERIFY), () => verified(n));
  return server;
}

export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

export async function settled(server: PayoutServer): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await settle();
}

export async function click(node: HTMLElement, twice = false): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
    if (twice) fireEvent.click(node);
  });
  await settle();
}

export async function fill(node: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(node, { target: { value } });
  });
}

/** Mounts the real shell on /withdrawals over `server` for `permissions`. */
export async function mount(
  server: PayoutServer,
  permissions: PermissionSnapshot = EXECUTOR,
): Promise<void> {
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

/** Mounts, opens 打款队列 (全部) and waits for its rows and the overview. */
export async function openQueue(
  server: PayoutServer,
  permissions: PermissionSnapshot = EXECUTOR,
  rows: readonly string[] = allRows(),
): Promise<HTMLElement> {
  await mount(server, permissions);
  const panel = await openTab(TAB.queue);
  await listed(panel, rows);
  await waitFor(() => expect(server.overviewReads().length).toBeGreaterThan(0));
  await settled(server);
  return panel;
}

// ---- the queue table, its checkboxes and the selection bar ----------------------------------

/** The queue table row of `number` inside the 打款队列 panel. */
export function queueRow(panel: HTMLElement, number: string): HTMLElement {
  return rowIn(gridWith(panel, COLUMN.net), number);
}

export function disabled(node: HTMLElement): boolean {
  return node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true';
}

/** The usable checkboxes of a queue row. */
export function choicesOf(row: HTMLElement): HTMLInputElement[] {
  return within(row)
    .queryAllByRole('checkbox')
    .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
    .filter((node) => !disabled(node));
}

/** The one usable checkbox of the queue row of `number`. */
export function checkbox(panel: HTMLElement, number: string): HTMLInputElement {
  const found = choicesOf(queueRow(panel, number));
  expect(found, `the row ${number} has one usable checkbox`).toHaveLength(1);
  return found[0]!;
}

/** Ticks the rows of `numbers` in that order. */
export async function select(panel: HTMLElement, numbers: readonly string[]): Promise<void> {
  for (const number of numbers) {
    await click(checkbox(panel, number));
    expect(checkbox(panel, number).checked, `${number} ticked`).toBe(true);
  }
}

/** The ticked checkboxes of the panel. */
export function ticked(panel: HTMLElement): HTMLInputElement[] {
  const boxes = panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  return Array.from(boxes).filter((node) => node.checked);
}

/** Texts of the polite / assertive live regions of `root`. */
export function liveTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[aria-live]'))
    .filter((node) => ['polite', 'assertive'].includes(node.getAttribute('aria-live') ?? ''))
    .map((node) => node.textContent ?? '');
}

/** Buttons and links of `root` named exactly `name` (spaces ignored), shown or not. */
export function buttons(root: HTMLElement, name: string): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]');
  const wanted = squash(name);
  const named = (node: HTMLElement): boolean =>
    squash(node.textContent) === wanted || squash(node.getAttribute('aria-label')) === wanted;
  return Array.from(nodes).filter(named);
}

/** The one shown button `name` of `root`. */
export function button(root: HTMLElement, name: string): HTMLElement {
  const found = buttons(root, name).filter(isShown);
  expect(found, `one button ${name}`).toHaveLength(1);
  return found[0]!;
}

// ---- dialogs ---------------------------------------------------------------------------------

export function dialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter((node) => {
    for (let parent: HTMLElement | null = node; parent !== null; parent = parent.parentElement)
      if (parent.hidden || parent.style.display === 'none') return false;
    return true;
  });
}

export function stepDialogs(): HTMLElement[] {
  return dialogs().filter(
    (node) => within(node).queryAllByText(STEP_TITLE, { exact: true }).length === 1,
  );
}

export async function step(): Promise<HTMLElement> {
  await waitFor(() => expect(stepDialogs(), 'one totp StepUpModal').toHaveLength(1));
  return stepDialogs()[0]!;
}

/** Presses 【执行所选】 and returns the one confirmation dialog (no step-up yet, nothing sent). */
export async function open(server: PayoutServer, panel: HTMLElement): Promise<HTMLElement> {
  const writes = server.writes().length;
  const entry = button(panel, ENTRY);
  expect(disabled(entry), `${ENTRY} usable`).toBe(false);
  entry.focus();
  await click(entry);
  await waitFor(() => expect(dialogs(), 'one confirmation dialog').toHaveLength(1));
  expect(stepDialogs(), 'no step-up before the confirmation').toEqual([]);
  expect(server.writes(), 'nothing sent on opening').toHaveLength(writes);
  return dialogs()[0]!;
}

/** Presses 【确认执行】: the totp StepUpModal opens and nothing is sent yet. */
export async function confirm(
  server: PayoutServer,
  modal: HTMLElement,
  twice = false,
): Promise<void> {
  const writes = server.writes().length;
  await click(button(modal, SUBMIT), twice);
  const verification = await step();
  expect(within(verification).queryAllByLabelText(STEP_FIELD, { exact: true })).toHaveLength(1);
  expect(server.writes(), 'nothing sent before the dynamic code').toHaveLength(writes);
}

/** Types the dynamic code and presses 【验证并继续】. */
export async function verify(twice = false): Promise<void> {
  const modal = await step();
  const fields = within(modal).queryAllByLabelText(STEP_FIELD, { exact: true });
  expect(fields).toHaveLength(1);
  await fill(fields[0]!, CODE);
  await click(button(modal, STEP_SUBMIT), twice);
}

/**
 * Presses 【确认执行】 of `modal` again: the page may reuse a still valid pass or ask for another
 * dynamic code (then it is entered); waits for one more batch POST.
 */
export async function submitAgain(server: PayoutServer, modal: HTMLElement): Promise<void> {
  const before = posts(server).length;
  await click(button(modal, SUBMIT));
  await waitFor(() =>
    expect(posts(server).length === before + 1 || stepDialogs().length === 1).toBe(true),
  );
  if (stepDialogs().length === 1) await verify();
  await waitFor(() => expect(posts(server)).toHaveLength(before + 1));
  await settled(server);
}

/** Cancels the confirmation dialog (or closes a result) with 【取消】 or Escape. */
export async function dismiss(): Promise<void> {
  for (const modal of dialogs()) {
    const cancel = buttons(modal, CANCEL).filter((node) => isShown(node) && !disabled(node));
    if (cancel.length === 1) await click(cancel[0]!);
    else
      await act(async () => {
        fireEvent.keyDown(modal, { ['key']: 'Escape', code: 'Escape', ['keyCode']: 27 });
      });
  }
  await waitFor(() => expect(dialogs()).toEqual([]));
}

/** The pre-check items of `modal` (spaces removed), in order. */
export function checkItems(modal: HTMLElement): string[] {
  const nodes = Array.from(modal.querySelectorAll<HTMLElement>('*'));
  const titled = (node: Element): boolean => squash(node.textContent) === CHECK_TITLE;
  const titles = nodes.filter((node) => titled(node) && !Array.from(node.children).some(titled));
  expect(titles, `one heading ${CHECK_TITLE}`).toHaveLength(1);
  const all = modal.querySelectorAll<HTMLElement>('li, [role="listitem"]');
  const items = Array.from(all).filter(isShown);
  return items
    .filter((item) => !items.some((other) => other !== item && item.contains(other)))
    .map((item) => squash(item.textContent));
}

// ---- the batch POST ----------------------------------------------------------------------

export function posts(server: PayoutServer): RequestLog[] {
  return server.log.filter(postOf(BATCHES));
}
export function verifications(server: PayoutServer): RequestLog[] {
  return server.log.filter(postOf(VERIFY));
}

/** The idempotency header of a request (non-empty, no whitespace). */
export function onceHeader(request: RequestLog): string {
  const value = request.headers.get('Idempotency-Key');
  expect(value, 'Idempotency-Key').toEqual(expect.stringMatching(/^\S+$/));
  return value!;
}

/**
 * The `count`-th POST /admin/v1/payout-batches (1-based) is the whole contract request: no query,
 * the body only `withdrawal_ids` (`ids`, in list order), the admin bearer, the step-up pass `pass`
 * and an Idempotency-Key; it follows the verification that issued that pass.
 */
export function assertPost(
  server: PayoutServer,
  ids: readonly string[],
  count: number,
  pass: number,
): RequestLog {
  const sent = posts(server);
  expect(sent, 'batch POSTs').toHaveLength(count);
  const request = sent[count - 1]!;
  expect(request.method).toBe('POST');
  expect(request.path).toBe(BATCHES);
  expect(request.query).toEqual({});
  const body: BatchRequest = { withdrawal_ids: [...ids] };
  expect(request.body, 'the whole body').toEqual(body);
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(passOf(pass));
  onceHeader(request);
  const checks = verifications(server);
  expect(checks.length, 'verifications so far').toBeGreaterThanOrEqual(pass);
  for (const one of checks) expect(one.body).toEqual({ tier: 'totp', code: CODE });
  expect(server.log.indexOf(request)).toBeGreaterThan(server.log.indexOf(checks[pass - 1]!));
  return request;
}

/** Answers the next batch POST with `result`, after moving the paying rows to PAYING. */
export function answerWith(server: PayoutServer, result: BatchResult): void {
  server.onceWhere(postOf(BATCHES), () => {
    for (const id of result.paying) {
      const row = server.state.find((item) => item.withdrawal_id === id);
      if (row === undefined) continue;
      row.status = 'PAYING';
      row.display_status = 'paying';
      row.batch_id = result.batch_id;
    }
    return ok(result);
  });
}

/** Holds the next batch POST until the returned release is called, then answers `result`. */
export function holdWith(server: PayoutServer, result: BatchResult): () => void {
  const gate = Promise.withResolvers<void>();
  server.onceWhere(postOf(BATCHES), async () => {
    await gate.promise;
    return ok(result);
  });
  return () => gate.resolve();
}

// ---- what is shown after an answer -------------------------------------------------------

/** Waits until `text` is shown somewhere on the page (exact text). */
export async function notice(text: string): Promise<void> {
  await waitFor(() =>
    expect(within(document.body).queryAllByText(text, { exact: true }).length).toBeGreaterThan(0),
  );
}

/** Rows (anywhere on the page) holding `number` and the exact text `text`. */
export function resultRows(number: string, text: string): HTMLElement[] {
  return within(document.body)
    .queryAllByRole('row')
    .filter(
      (row) =>
        within(row).queryAllByText(number, { exact: true }).length > 0 &&
        within(row).queryAllByText(text, { exact: true }).length === 1,
    );
}

/** Each of `numbers` has exactly one row with its text, in that order on the page. */
export async function assertResults(
  numbers: readonly string[],
  texts: readonly string[],
): Promise<void> {
  const found: HTMLElement[] = [];
  for (const [index, number] of numbers.entries()) {
    const text = texts[index]!;
    await notice(text);
    const rows = resultRows(number, text);
    expect(rows, `${number}: ${text}`).toHaveLength(1);
    found.push(rows[0]!);
  }
  for (let index = 1; index < found.length; index += 1)
    expect(
      found[index - 1]!.compareDocumentPosition(found[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'results in list order',
    ).not.toBe(0);
}

const BATCH_LABEL = labelled('新批次号|批次号');

/** The values of the new-batch field (labelled 新批次号 / 批次号) on the page. */
export function batchShown(): string[] {
  return values(document.body, BATCH_LABEL);
}
/** Whether any element of the page is labelled 新批次号 / 批次号. */
export function batchLabels(): HTMLElement[] {
  const nodes = Array.from(document.body.querySelectorAll<HTMLElement>('*'));
  return nodes.filter((node) => BATCH_LABEL.test(squash(node.textContent)));
}

/** Index in the log of the request (for before / after comparisons). */
export function at(server: PayoutServer, request: RequestLog): number {
  return server.log.indexOf(request);
}
