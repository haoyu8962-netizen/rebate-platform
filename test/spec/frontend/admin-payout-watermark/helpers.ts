import { act, cleanup, configure, fireEvent, render, waitFor } from '@testing-library/react';
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
  CHANNEL_TITLE,
  FIELD,
  TAB,
  card,
  isShown,
  labelled,
  main,
  openTab,
  squash,
  values,
} from '../admin-payouts-readonly/helpers.ts';
import {
  button,
  buttons,
  click,
  dialogs,
  disabled,
  fill,
  notice,
  settle,
  settled,
  step,
  stepDialogs,
  verify,
} from '../admin-payout-execute/helpers.ts';
import { textbox } from '../admin-withdrawals/helpers.ts';
import {
  CASHIER,
  CASHIER_GRANTS,
  CODE,
  DIALOG_FIELD,
  INPUT,
  OVERVIEW,
  SUBMIT,
  VERIFY,
  WATERMARKS,
  allowedHereToo,
  getOf,
  ok,
  overview,
  overviewAfter,
  passOf,
  postOf,
  rowOf,
  verified,
  type Grants,
  type Overview,
  type RequestLog,
  type WatermarkRequest,
} from './fixtures.ts';

// 【录入企业支付宝余额】 / 【录入运营账户余额】 are reached only through the real shell (createAdminShell,
// menu `withdrawals`, tab 打款队列): no page module is imported, so a missing entry is an assertion
// failure. Only frozen pure helpers of the earlier payout suites are reused; their mount helpers
// are not (their request guards forbid the watermark POST of this task). The guard here allows the
// read-only tab's reads, the dynamic-code verification and POST /admin/v1/payout-watermarks.
//
// The dialog is the one open dialog that is not the StepUpModal. Its inputs are found by their
// label (or placeholder): 可用余额 (yuan, a text field), 取数时间 (a text field taking Beijing time
// YYYY-MM-DD HH:mm:ss; a change event sets it, no picker confirmation), 备注. A field message is
// the text the field points at (aria-errormessage, or aria-describedby while aria-invalid is true,
// as antd Form.Item does) or the error under its form item.
configure({ asyncUtilTimeout: 10_000 });
export { button, buttons, click, dialogs, disabled, isShown, main, notice, settle, settled };
export { squash, step, stepDialogs, verify };

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
        'only the queue reads, the dynamic-code verification and POST /admin/v1/payout-watermarks',
      ).toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

// ---- the server --------------------------------------------------------------------------------

/** The overview each server answers now (replaced when an entry succeeds). */
const views = new WeakMap<PayoutServer, { current: Overview }>();

export interface Setup {
  readonly overview?: Overview;
  /** Permission points the server checks; defaults to fund.view + fund.cash_entry. */
  readonly permissions?: Grants;
  /** How many verified dynamic codes the server answers (passes 1…n); defaults to 3. */
  readonly passes?: number;
}

/**
 * The frozen payout server whose overview read answers the current overview (the sample, or
 * `setup.overview`; after a successful entry, the overview holding the new row), with `passes`
 * scripted verifications.
 */
export function serverFor(setup: Setup = {}): PayoutServer {
  const server = createPayoutServer({ permissions: setup.permissions ?? CASHIER_GRANTS });
  const view = { current: structuredClone(setup.overview ?? overview()) };
  views.set(server, view);
  const answer = (): Response => {
    server.onceWhere(getOf(OVERVIEW), answer);
    return ok(structuredClone(view.current));
  };
  server.onceWhere(getOf(OVERVIEW), answer);
  for (let n = 1; n <= (setup.passes ?? 3); n += 1)
    server.onceWhere(postOf(VERIFY), () => verified(n));
  return server;
}

/** Answers `request` with its new row; the overview read after it shows that row. */
function entered(server: PayoutServer, request: RequestLog): Response {
  const row = rowOf(request.body as WatermarkRequest);
  const view = views.get(server);
  if (view !== undefined) view.current = overviewAfter(row);
  return ok({ watermark: row });
}

/** Answers the next watermark POST as entered. */
export function answerWith(server: PayoutServer): void {
  server.onceWhere(postOf(WATERMARKS), (request) => entered(server, request));
}

/** Holds the next watermark POST until the returned release is called, then answers it entered. */
export function holdWith(server: PayoutServer): () => void {
  const gate = Promise.withResolvers<void>();
  server.onceWhere(postOf(WATERMARKS), async (request) => {
    await gate.promise;
    return entered(server, request);
  });
  return () => gate.resolve();
}

// ---- mounting ----------------------------------------------------------------------------------

/** Mounts the real shell on /withdrawals over `server` for `permissions`. */
export async function mount(
  server: PayoutServer,
  permissions: PermissionSnapshot = CASHIER,
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

/** Mounts, opens 打款队列 and waits until the overview cards show (the 打款开关 field). */
export async function openPanel(
  server: PayoutServer,
  permissions: PermissionSnapshot = CASHIER,
): Promise<HTMLElement> {
  await mount(server, permissions);
  const panel = await openTab(TAB.queue);
  await waitFor(() => expect(server.overviewReads().length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(values(panel, FIELD.payout)).toHaveLength(1));
  return panel;
}

// ---- entries -----------------------------------------------------------------------------------

/** Names (spaces removed) of every button or link of the document starting with 录入, shown or not. */
export function entryNames(): string[] {
  const nodes = document.body.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], [role="link"], [role="menuitem"]',
  );
  return Array.from(nodes)
    .map((node) => squash(node.textContent) || squash(node.getAttribute('aria-label')))
    .filter((name) => name.startsWith('录入'));
}

/** The one shown, usable entry `name` of the main area. */
export function entryOf(name: string): HTMLElement {
  const found = buttons(main(), name).filter(isShown);
  expect(found, `one entry ${name}`).toHaveLength(1);
  expect(disabled(found[0]!), `${name} usable`).toBe(false);
  return found[0]!;
}

type Channel = keyof typeof CHANNEL_TITLE;

/** The channel card titled like the payout channel `channel` inside `panel`. */
export function channelCard(panel: HTMLElement, channel: Channel): HTMLElement {
  return card(panel, CHANNEL_TITLE[channel]);
}

// ---- the dialog --------------------------------------------------------------------------------

/** The open dialogs that are not the StepUpModal. */
export function entryDialogs(): HTMLElement[] {
  const steps = stepDialogs();
  return dialogs().filter((node) => !steps.includes(node));
}

/** Presses the entry `name` and returns the one entry dialog (no step-up yet, nothing sent). */
export async function openEntry(server: PayoutServer, name: string): Promise<HTMLElement> {
  const writes = server.writes().length;
  const entry = entryOf(name);
  entry.focus();
  await click(entry);
  await waitFor(() => expect(entryDialogs(), 'one entry dialog').toHaveLength(1));
  expect(stepDialogs(), 'no step-up on opening').toEqual([]);
  expect(server.writes(), 'nothing sent on opening').toHaveLength(writes);
  return entryDialogs()[0]!;
}

/** The value (spaces removed) of the one read-only field `label` (DIALOG_FIELD) of `modal`. */
export function shown(modal: HTMLElement, label: string): string {
  const found = values(modal, labelled(label));
  expect(found, `one field ${label}`).toHaveLength(1);
  return found[0]!;
}

export interface Inputs {
  readonly available: HTMLInputElement | HTMLTextAreaElement;
  readonly measuredAt: HTMLInputElement | HTMLTextAreaElement;
  readonly note: HTMLInputElement | HTMLTextAreaElement;
}

/** The three inputs of `modal`. */
export function inputsOf(modal: HTMLElement): Inputs {
  return {
    available: textbox(modal, INPUT.available),
    measuredAt: textbox(modal, INPUT.measuredAt),
    note: textbox(modal, INPUT.note),
  };
}

export interface Form {
  /** Yuan as typed. */
  readonly available: string;
  /** Beijing time as typed (YYYY-MM-DD HH:mm:ss). */
  readonly measuredAt: string;
  /** As typed; '' leaves the note empty. */
  readonly note: string;
}

async function typeInto(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.focus(node);
  });
  await fill(node, value);
  await act(async () => {
    fireEvent.blur(node);
  });
}

/** Types `form` into the inputs of `modal`. */
export async function fillIn(modal: HTMLElement, form: Form): Promise<void> {
  await typeInto(inputsOf(modal).available, form.available);
  await typeInto(inputsOf(modal).measuredAt, form.measuredAt);
  await typeInto(inputsOf(modal).note, form.note);
  await settle();
}

/** The input values of `modal`, as typed. */
export function typed(modal: HTMLElement): Form {
  const inputs = inputsOf(modal);
  return {
    available: inputs.available.value,
    measuredAt: inputs.measuredAt.value,
    note: inputs.note.value,
  };
}

/** Presses 【确认录入】: the totp StepUpModal opens and nothing is sent yet. */
export async function confirm(
  server: PayoutServer,
  modal: HTMLElement,
  twice = false,
): Promise<void> {
  const writes = server.writes().length;
  await click(button(modal, SUBMIT), twice);
  await step();
  expect(server.writes(), 'nothing sent before the dynamic code').toHaveLength(writes);
}

/** Fills `form`, confirms and enters the dynamic code; waits for one more watermark POST. */
export async function enter(server: PayoutServer, modal: HTMLElement, form: Form): Promise<void> {
  const before = posts(server).length;
  await fillIn(modal, form);
  await confirm(server, modal);
  await verify();
  await waitFor(() => expect(posts(server)).toHaveLength(before + 1));
  await settled(server);
}

/**
 * Presses 【确认录入】 of `modal` again: the page may reuse a still valid pass or ask for another
 * dynamic code (then it is entered); waits for one more watermark POST.
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

/** Presses 【确认录入】 with something invalid: no StepUpModal, nothing sent. */
export async function refusedLocally(server: PayoutServer, modal: HTMLElement): Promise<void> {
  const writes = server.writes().length;
  await click(button(modal, SUBMIT));
  await settle();
  expect(stepDialogs(), 'no step-up for an invalid form').toEqual([]);
  expect(server.writes(), 'nothing sent for an invalid form').toHaveLength(writes);
  expect(entryDialogs(), 'the dialog stays').toEqual([modal]);
}

// ---- field messages ----------------------------------------------------------------------------

const EXPLAIN = '.ant-form-item-explain-error';

function referenced(input: HTMLElement, attribute: string): HTMLElement[] {
  return (input.getAttribute(attribute) ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((id) => {
      const node = document.getElementById(id);
      return node === null ? [] : [node];
    });
}

/** The messages (spaces removed, one per element) shown for `input`. */
export function messagesOf(input: HTMLElement): string[] {
  const nodes = referenced(input, 'aria-errormessage');
  const item = input.closest('.ant-form-item');
  // Inside an antd form item only its errors count (its help may also describe a standing extra).
  if (item !== null) nodes.push(...Array.from(item.querySelectorAll<HTMLElement>(EXPLAIN)));
  else if (input.getAttribute('aria-invalid') === 'true')
    nodes.push(...referenced(input, 'aria-describedby'));
  const unique = [...new Set(nodes)].filter((node) => isShown(node));
  const inner = unique.filter(
    (node) => !unique.some((other) => other !== node && node.contains(other)),
  );
  return [...new Set(inner.map((node) => squash(node.textContent)).filter(Boolean))];
}

/** The messages of the three inputs of `modal`, spaces removed. */
export function messages(modal: HTMLElement): Record<keyof Inputs, string[]> {
  const inputs = inputsOf(modal);
  return {
    available: messagesOf(inputs.available),
    measuredAt: messagesOf(inputs.measuredAt),
    note: messagesOf(inputs.note),
  };
}

/** `text` as messages() returns it. */
export const message = (text: string): string[] => [squash(text)];

// ---- the watermark POST ------------------------------------------------------------------------

export function posts(server: PayoutServer): RequestLog[] {
  return server.log.filter(postOf(WATERMARKS));
}
export function verifications(server: PayoutServer): RequestLog[] {
  return server.log.filter(postOf(VERIFY));
}
export function overviewReads(server: PayoutServer): RequestLog[] {
  return server.overviewReads();
}

/** The idempotency header of a request (the contract's IdempotencyKey: 8–64 of [A-Za-z0-9_-]). */
export function onceHeader(request: RequestLog): string {
  const value = request.headers.get('Idempotency-Key');
  expect(value, 'Idempotency-Key').toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/));
  return value!;
}

/**
 * The `count`-th POST /admin/v1/payout-watermarks (1-based) is the whole contract request: no
 * query, exactly `body` (no other member, no empty note), the admin bearer, the step-up pass `pass`
 * and an Idempotency-Key; it follows the verification that issued that pass.
 */
export function assertPost(
  server: PayoutServer,
  body: WatermarkRequest,
  count: number,
  pass: number,
): RequestLog {
  const sent = posts(server);
  expect(sent, 'watermark POSTs').toHaveLength(count);
  const request = sent[count - 1]!;
  expect(request.method).toBe('POST');
  expect(request.path).toBe(WATERMARKS);
  expect(request.query).toEqual({});
  expect(request.body, 'the whole body').toStrictEqual(body);
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(passOf(pass));
  onceHeader(request);
  const checks = verifications(server);
  expect(checks.length, 'verifications so far').toBeGreaterThanOrEqual(pass);
  for (const one of checks) expect(one.body).toEqual({ tier: 'totp', code: CODE });
  expect(server.log.indexOf(request)).toBeGreaterThan(server.log.indexOf(checks[pass - 1]!));
  return request;
}

/** The pass the latest verification issued (1-based). */
export function latestPass(server: PayoutServer): number {
  return verifications(server).length;
}

// ---- what is shown on the page -----------------------------------------------------------------

/** W and t_W of the 企业支付宝可用余额 card (spaces removed). */
export function alipayCard(panel: HTMLElement): string[] {
  return [...values(panel, FIELD.available), ...values(panel, FIELD.measuredAt)];
}

/** 账户, 当前 W and 当前取数时间 of `modal` (spaces removed). */
export function current(modal: HTMLElement): string[] {
  return [
    shown(modal, DIALOG_FIELD.account),
    shown(modal, DIALOG_FIELD.current),
    shown(modal, DIALOG_FIELD.currentAt),
  ];
}

/** Waits until the entry dialog is closed. */
export async function closed(): Promise<void> {
  await waitFor(() => expect(entryDialogs(), 'the entry dialog is closed').toEqual([]));
  await waitFor(() => expect(stepDialogs()).toEqual([]));
}
