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
import { BASE_URL } from '../admin-payouts-readonly/fixtures.ts';
import {
  isShown,
  main,
  panelOf,
  selectTab,
  squash,
  tabsIn,
  textOf,
  values,
} from '../admin-payouts-readonly/helpers.ts';
import { handlersWithoutRole } from '../admin-unknown-relogin-marker/helpers.ts';
import { choose, textFields } from '../admin-withdrawals/helpers.ts';
import {
  BATCH,
  CODE,
  ITEMS,
  LABEL,
  SAVE,
  STEP_FIELD,
  STEP_SUBMIT,
  STEP_TITLE,
  SWITCHES,
  SUPER,
  TAB,
  VERIFY,
  allowedHereToo,
  getOf,
  passOf,
  postOf,
  type BatchEntry,
  type PayoutServer,
  type RequestLog,
} from './fixtures.ts';

// The 「自动到账设置」 tab is reached only through the real shell (createAdminShell, menu
// `withdrawals`): no page module is imported, so a missing tab or field is an assertion failure, not
// an import error. Only frozen pure helpers of earlier suites are reused; their mount helpers are not
// (their request guards forbid the config reads and the batch POST of this task). The guard here
// allows the frozen withdrawals / payout reads, GET /admin/v1/config-items, GET
// /admin/v1/kill-switches, the dynamic-code verification and POST /admin/v1/config-items/batch —
// no kill-switch write, no other config write.
//
// What these tests decide about the form (the implementation is free in everything else): each
// setting is one control labelled as fixtures LABEL gives it (a text / number input for the amounts
// in yuan and the counts, a select or radio group for window_start / window_end, a switch, checkbox,
// radio group or select for the two booleans); risk_block_flags is one checkbox per BR-WDR-29 label
// named by its admin_dict name; the master switch is a read-only field; ⑤ ⑥ read 「不自动到账」.
configure({ asyncUtilTimeout: 10_000 });
export { handlersWithoutRole, isShown, main, squash, tabsIn, textOf, values };

export const FLOW_TIMEOUT = 60_000;
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
        'only the frozen reads, the two lists, the verification and the config batch',
      ).toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

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
export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
  await settle();
}
export async function fill(node: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(node);
    fireEvent.change(node, { target: { value } });
  });
  await act(async () => {
    fireEvent.blur(node);
  });
  await settle();
}

/** Mounts the real shell on /withdrawals over `server` for `permissions`. */
export async function mount(
  server: PayoutServer,
  permissions: PermissionSnapshot = SUPER,
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

/** The names of the page's own tabs (the tab list holding 「审核列表」). */
export function pageTabNames(): string[] {
  const review = tabsIn(main(), TAB.review);
  expect(review, `one tab ${TAB.review}`).toHaveLength(1);
  const list = review[0]!.closest<HTMLElement>('[role="tablist"]');
  expect(list, 'the tab list of the page').not.toBeNull();
  return within(list!)
    .queryAllByRole('tab', { hidden: true })
    .map((tab) => squash(tab.textContent));
}

/** Mounts and opens 「自动到账设置」; waits until the amount input shows. */
export async function openSettings(
  server: PayoutServer,
  permissions: PermissionSnapshot = SUPER,
): Promise<HTMLElement> {
  await mount(server, permissions);
  const panel = await panelOf(await selectTab(main(), TAB.auto));
  await waitFor(() => expect(itemReads(server).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(textFields(panel, LABEL.maxAmount)).toHaveLength(1));
  return panel;
}

// ---- requests ----------------------------------------------------------------------------------

export function itemReads(server: PayoutServer): RequestLog[] {
  return server.log.filter(getOf(ITEMS));
}
export function switchReads(server: PayoutServer): RequestLog[] {
  return server.log.filter(getOf(SWITCHES));
}
export function batches(server: PayoutServer): RequestLog[] {
  return server.log.filter(postOf(BATCH));
}
export function verifications(server: PayoutServer): RequestLog[] {
  return server.log.filter(postOf(VERIFY));
}
/** Every config-item or switch read, and every write (the tab's own traffic). */
export function settingsTraffic(server: PayoutServer): RequestLog[] {
  const own = [getOf(ITEMS), getOf(SWITCHES), postOf(BATCH)];
  return server.log.filter((request) => own.some((match) => match(request)));
}

/** The entries of `body`, ordered by key (the page's order is free). */
export function byKey(entries: readonly BatchEntry[]): BatchEntry[] {
  return [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The `count`-th batch POST (1-based) is the whole contract request: no query, members only
 * `items` (exactly `entries`, in any order) and an optional reason of 1–200 code points, the admin
 * bearer, the step-up pass `pass`, no Idempotency-Key; it follows the verification of that pass.
 */
export function assertBatch(
  server: PayoutServer,
  entries: readonly BatchEntry[],
  count: number,
  pass: number,
): RequestLog {
  const sent = batches(server);
  expect(sent, 'config batch POSTs').toHaveLength(count);
  const request = sent[count - 1]!;
  expect(request.query).toEqual({});
  const body = request.body as Record<string, unknown>;
  expect(typeof body, 'a JSON object').toBe('object');
  const members = Object.keys(body).filter((name) => name !== 'reason');
  expect(members, 'only items (and an optional reason)').toEqual(['items']);
  if ('reason' in body) {
    const reason: unknown = body['reason'];
    expect(typeof reason, 'the reason is text').toBe('string');
    const length = Array.from(reason as string).length;
    expect(length >= 1 && length <= 200, 'the reason has 1–200 code points').toBe(true);
  }
  const items = body['items'] as BatchEntry[];
  const wanted = ['expected_version', 'key', 'value'];
  for (const entry of items) expect(Object.keys(entry).sort(), 'entry members').toEqual(wanted);
  const sortValue = (entry: BatchEntry): BatchEntry => {
    const value: unknown = entry.value;
    return Array.isArray(value) ? { ...entry, value: [...(value as string[])].sort() } : entry;
  };
  expect(byKey(items).map(sortValue), 'exactly the changed keys').toStrictEqual(
    byKey(entries).map(sortValue),
  );
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(passOf(pass));
  expect(request.headers.has('Idempotency-Key'), 'no Idempotency-Key').toBe(false);
  const checks = verifications(server);
  expect(checks.length, 'verifications so far').toBeGreaterThanOrEqual(pass);
  for (const one of checks) expect(one.body).toEqual({ tier: 'totp', code: CODE });
  expect(server.log.indexOf(request)).toBeGreaterThan(server.log.indexOf(checks[pass - 1]!));
  return request;
}

// ---- controls ------------------------------------------------------------------------------------

export function disabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('fieldset[disabled]') !== null ||
    node.closest('.ant-select-disabled, .ant-input-number-disabled') !== null
  );
}

/** Buttons and links of `root` named exactly `name` (spaces ignored), shown or not. */
export function buttons(root: HTMLElement, name: string): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]');
  const wanted = squash(name);
  return Array.from(nodes).filter(
    (node) =>
      squash(node.textContent) === wanted || squash(node.getAttribute('aria-label')) === wanted,
  );
}
/** The one shown button `name` of `root`. */
export function button(root: HTMLElement, name: string): HTMLElement {
  const found = buttons(root, name).filter(isShown);
  expect(found, `one button ${name}`).toHaveLength(1);
  return found[0]!;
}
/** The one shown, usable button `name` of `root`. */
export function usable(root: HTMLElement, name: string): HTMLElement {
  const found = button(root, name);
  expect(disabled(found), `${name} usable`).toBe(false);
  return found;
}

/** The one text input of `root` labelled `label`. */
export function input(root: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const found = textFields(root, label).filter(isShown);
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}
/** Types `text` into the input labelled `label`. */
export async function typeInto(root: HTMLElement, label: RegExp, text: string): Promise<void> {
  await fill(input(root, label), text);
}

/** Chooses the option whose text is `option` in the select / radio group labelled `label`. */
export async function pick(root: HTMLElement, label: RegExp, option: string): Promise<void> {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await choose(root, label, new RegExp(`^${escaped}$`));
  await settle();
}

const ON = /^(?:开启|已开启|开|是|on)$/i;
const OFF = /^(?:关闭|已关闭|关|否|off)$/i;

function flagControl(root: HTMLElement, label: RegExp): HTMLElement | undefined {
  const named = [
    ...within(root).queryAllByRole('switch', { name: label }),
    ...within(root).queryAllByRole('checkbox', { name: label }),
  ].filter(isShown);
  expect(named.length, `at most one switch or checkbox ${String(label)}`).toBeLessThanOrEqual(1);
  return named[0];
}
/** Sets the boolean labelled `label` to `on` (a switch / checkbox, else a radio group or select). */
export async function setFlag(root: HTMLElement, label: RegExp, on: boolean): Promise<void> {
  const control = flagControl(root, label);
  if (control !== undefined) {
    const checked =
      control.getAttribute('aria-checked') === 'true' ||
      (control instanceof HTMLInputElement && control.checked);
    if (checked !== on) await click(control);
    return;
  }
  await choose(root, label, on ? ON : OFF);
  await settle();
}

/** The checkbox of the risk flag named `name` (exact accessible name). */
export function flagBox(root: HTMLElement, name: string): HTMLInputElement {
  const found = within(root)
    .queryAllByRole('checkbox', { name })
    .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement);
  expect(found, `one checkbox ${name}`).toHaveLength(1);
  return found[0]!;
}

/** Inputs of `root` that the user could still type into or choose in. */
export function editable(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'input, textarea, select, [role="switch"], [role="combobox"]',
  );
  return Array.from(nodes)
    .filter(isShown)
    .filter((node) => !(node instanceof HTMLInputElement && node.type === 'hidden'))
    .filter((node) => !disabled(node) && !(node as HTMLInputElement).readOnly);
}

/** Inputs of `root` marked invalid, and the shown field messages. */
export function invalidMarks(root: HTMLElement): string[] {
  const marked = Array.from(root.querySelectorAll<HTMLElement>('[aria-invalid="true"]'))
    .filter(isShown)
    .map((node) => node.getAttribute('id') ?? node.localName);
  const messages = Array.from(root.querySelectorAll<HTMLElement>('.ant-form-item-explain-error'))
    .filter(isShown)
    .map((node) => squash(node.textContent))
    .filter((text) => text !== '');
  return [...marked, ...messages];
}

/** Whether the input labelled `label` is marked invalid (aria-invalid or its form item's error). */
export function markedInvalid(root: HTMLElement, label: RegExp): boolean {
  const node = input(root, label);
  if (node.getAttribute('aria-invalid') === 'true') return true;
  const holder = node.closest('.ant-form-item');
  return holder !== null && holder.classList.contains('ant-form-item-has-error');
}

// ---- dialogs -------------------------------------------------------------------------------------

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
/** Types the dynamic code into the one StepUpModal and presses 【验证并继续】. */
export async function verify(): Promise<void> {
  await waitFor(() => expect(stepDialogs(), 'one totp StepUpModal').toHaveLength(1));
  const modal = stepDialogs()[0]!;
  const fields = within(modal).queryAllByLabelText(STEP_FIELD, { exact: true });
  expect(fields).toHaveLength(1);
  await act(async () => {
    fireEvent.change(fields[0]!, { target: { value: CODE } });
  });
  await click(button(modal, STEP_SUBMIT));
}

/**
 * Presses 【保存】 of `panel` (and a confirmation's 【保存】 or 【确认】 when the page asks for one),
 * enters the dynamic code and waits for one more batch POST.
 */
export async function save(server: PayoutServer, panel: HTMLElement): Promise<void> {
  const before = batches(server).length;
  await click(usable(panel, SAVE));
  await passUntilSent(server, before);
}

/** Answers what the page asks (a confirmation, a dynamic code) until a batch POST after `before`. */
export async function passUntilSent(server: PayoutServer, before: number): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const asked = (): boolean => stepDialogs().length === 1 || confirmations().length > 0;
    await waitFor(() =>
      expect(
        batches(server).length > before || asked(),
        'a batch POST, a dynamic code or a confirmation',
      ).toBe(true),
    );
    if (batches(server).length > before) break;
    if (stepDialogs().length === 1) await verify();
    else await click(confirmButton(confirmations()[0]!));
  }
  await waitFor(() => expect(batches(server)).toHaveLength(before + 1));
  await settled(server);
}

function confirmations(): HTMLElement[] {
  return dialogs().filter((node) => !stepDialogs().includes(node));
}
function confirmButton(modal: HTMLElement): HTMLElement {
  const found = ['保存', '确认保存', '确认', '确定']
    .flatMap((name) => buttons(modal, name))
    .filter((node) => isShown(node) && !disabled(node));
  expect(found.length, 'a confirm button in the dialog').toBeGreaterThan(0);
  return found[0]!;
}

/** Presses 【保存】 and checks nothing was sent and no dynamic code was asked for. */
export async function saveRefused(server: PayoutServer, panel: HTMLElement): Promise<void> {
  const before = server.log.length;
  const entry = buttons(panel, SAVE).filter(isShown);
  expect(entry, `one button ${SAVE}`).toHaveLength(1);
  if (!disabled(entry[0]!)) await click(entry[0]!);
  await settled(server);
  expect(stepDialogs(), 'no dynamic code asked for').toEqual([]);
  expect(
    server.log.slice(before).filter((request) => request.method !== 'GET'),
    'nothing sent',
  ).toEqual([]);
}

/** Text (spaces removed) of `root` and of the page's messages / notifications. */
export function shownText(root: HTMLElement): string {
  const toasts = Array.from(
    document.querySelectorAll<HTMLElement>('.ant-message, .ant-notification, [role="alert"]'),
  ).map((node) => textOf(node));
  return squash([textOf(root), ...toasts].join(' '));
}
/** Waits until `pattern` shows in `root` or in a message. */
export async function shows(root: HTMLElement, pattern: RegExp): Promise<void> {
  await waitFor(() => expect(shownText(root)).toMatch(pattern));
}
