import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import {
  button,
  buttons,
  choose,
  click,
  compact,
  fill,
  hasText,
  isDisabled,
  main,
  mount as mountShell,
  norm,
  panel,
  rowWith,
  settle,
  settled,
  textbox,
  usable,
} from '../admin-adjustments-readonly/helpers.ts';
import {
  ADJUSTER,
  COLUMN,
  LABEL,
  OTP,
  REF_TYPE_NAME,
  TEXT,
  type RequestLog,
  type WriteServer,
} from './fixtures.ts';

// The page is reached only through the real shell (the frozen F1-08ca mount, menu id
// `adjustments`), so a missing entry is an assertion failure, not an import error. What this task
// decides about the page (texts in fixtures.ts TEXT / LABEL / SUMMARY / ERROR):
// - 【新建调账】 in the title row of the page, only with fund.adjust (super admins included); it
//   opens one drawer titled 「新建调账」 with the one-step notice, the controls labelled as LABEL
//   (direction a radio group 调增 / 调减; 原因码, 单据类型, 对方科目, 平台 selects), the linked
//   documents table (单据类型 / 单据号) filled with 【添加单据】, the preview line, 【取消】 and
//   【提交并短信验证】.
// - 【红冲】 on every APPROVED row and detail that is not a reversal and not reversed yet; it opens
//   one dialog titled 「红冲调账单」 with the read-only SUMMARY items and the 红冲原因 input only.
// - Submitting sends POST /admin/v1/auth/step-up/sms-codes, opens the StepUpModal (sms tier,
//   「二次验证 · 短信」, input 「验证码」, 【验证并继续】 → POST /admin/v1/auth/step-up) and then sends
//   one POST /admin/v1/adjustments with the X-Step-Up-Token of that verification.
// Every compared text has its whitespace collapsed and trimmed (the frozen helpers).
export * from '../admin-adjustments-readonly/helpers.ts';
export type { WriteServer };

/** Mounts the real shell on 资金 / 调账与核销 over the write server (fund.adjust, sms tier). */
export async function mount(server: WriteServer, snapshot: PermissionSnapshot = ADJUSTER) {
  return mountShell(server, { snapshot });
}

// ---- dialogs -------------------------------------------------------------------------------

function shown(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.style.display === 'none' || node.hidden)) return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
  }
  return true;
}
function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(shown);
}
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
/** Open dialogs and drawers titled exactly `title`. */
export function dialogsTitled(title: string): HTMLElement[] {
  return innermost(openDialogs().filter((node) => titlesOf(node).includes(title)));
}
function only(title: string): HTMLElement {
  const found = dialogsTitled(title);
  expect(found, `one open dialog titled ${title}`).toHaveLength(1);
  return found[0]!;
}
/** The one open drawer 「新建调账」. */
export function createDrawer(): HTMLElement {
  return only(TEXT.createTitle);
}
/** The one open dialog 「红冲调账单」. */
export function reverseDialog(): HTMLElement {
  return only(TEXT.reverseTitle);
}

const SMS_TITLE = '二次验证 · 短信';
const ANY_STEP_UP = /二次验证|动态码|短信验证/;
/** Open step-up dialogs (any tier). */
export function stepUpDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => titlesOf(node).some((title) => ANY_STEP_UP.test(title)));
}

// ---- entries -------------------------------------------------------------------------------

/** Opens 【新建调账】 (focused first, as a keyboard user would) and returns the drawer. */
export async function openCreate(): Promise<HTMLElement> {
  const entry = button(main(), TEXT.createEntry);
  entry.focus();
  await click(entry);
  await settle();
  await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toHaveLength(1));
  return createDrawer();
}
/** The 【红冲】 buttons of the list row `adjustId`. */
export function rowReverse(adjustId: string): HTMLElement[] {
  return buttons(rowWith(panel(), COLUMN.id, adjustId).element, TEXT.reverseEntry);
}
/** Opens 【红冲】 of `root` (a list row or the detail drawer) and returns the dialog. */
export async function openReverse(root: HTMLElement): Promise<HTMLElement> {
  const entry = button(root, TEXT.reverseEntry);
  entry.focus();
  await click(entry);
  await settle();
  await waitFor(() => expect(dialogsTitled(TEXT.reverseTitle)).toHaveLength(1));
  return reverseDialog();
}

// ---- controls of the drawer ----------------------------------------------------------------

/** Chooses the radio named exactly `name` inside `root`. */
export async function pickRadio(root: HTMLElement, name: string): Promise<void> {
  const radios = within(root).queryAllByRole('radio', { name });
  expect(radios, `one radio ${name}`).toHaveLength(1);
  await click(radios[0]!);
  await settle();
}
/** Types `value` into the input labelled `label` inside `root`. */
export async function typeInto(root: HTMLElement, label: string, value: string): Promise<void> {
  await fill(textbox(root, label), value);
  await settle();
}
/** The current value of the input labelled `label` inside `root`. */
export function valueOf(root: HTMLElement, label: string): string {
  return textbox(root, label).value;
}
/** Selects labelled `label` inside `root` (antd Select or native). */
export function selectsLabelled(root: HTMLElement, label: string): HTMLElement[] {
  return within(root).queryAllByRole('combobox', { name: label });
}
export type RefType = Schema<'AdminAdjustmentRefType'>;
/** Adds one linked document with 单据类型 / 单据号 / 【添加单据】. */
export async function addRef(root: HTMLElement, refType: RefType, refId: string): Promise<void> {
  await choose(root, LABEL.refType, REF_TYPE_NAME[refType]);
  await typeInto(root, LABEL.refId, refId);
  await click(button(root, TEXT.addRef));
  await settle();
}

export interface NewForm {
  readonly user?: string;
  readonly direction?: '调增' | '调减';
  readonly amount?: string;
  readonly reason?: string;
  readonly refs?: readonly (readonly [RefType, string])[];
  readonly note?: string;
  readonly subject?: string;
  readonly platform?: string;
}
/** Fills the drawer in the order a person would (only the parts given). */
export async function fillForm(root: HTMLElement, form: NewForm): Promise<void> {
  if (form.user !== undefined) await typeInto(root, LABEL.user, form.user);
  if (form.direction !== undefined) await pickRadio(root, form.direction);
  if (form.amount !== undefined) await typeInto(root, LABEL.amount, form.amount);
  if (form.reason !== undefined) await choose(root, LABEL.reason, form.reason);
  for (const [refType, refId] of form.refs ?? []) await addRef(root, refType, refId);
  if (form.note !== undefined) await typeInto(root, LABEL.note, form.note);
  if (form.subject !== undefined) await choose(root, LABEL.subject, form.subject);
  if (form.platform !== undefined) await choose(root, LABEL.platform, form.platform);
}

// ---- submitting ----------------------------------------------------------------------------

/** The one sms-tier step-up dialog. */
export async function smsDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(dialogsTitled(SMS_TITLE)).toHaveLength(1));
  return dialogsTitled(SMS_TITLE)[0]!;
}
/**
 * Types the SMS code into the open StepUpModal, presses 【验证并继续】 and waits for the
 * verification request (not for the write after it, which a test may hold).
 */
export async function verifySms(server: WriteServer): Promise<void> {
  const checks = server.verifications().length;
  const dialog = await smsDialog();
  const inputs = within(dialog).queryAllByLabelText('验证码', { exact: true });
  expect(inputs, 'the sms code input').toHaveLength(1);
  await fill(inputs[0]!, OTP);
  await click(button(dialog, '验证并继续'));
  await waitFor(() => expect(server.verifications()).toHaveLength(checks + 1));
  await settle();
}
/** Presses 【提交并短信验证】 of `root` only (no verification). */
export async function pressSubmit(root: HTMLElement): Promise<void> {
  await click(button(root, TEXT.submit));
  await settle();
}
/**
 * Presses 【提交并短信验证】 of `root`, checks that a code was sent and nothing written before
 * the verification, verifies and waits for the one write that follows.
 */
export async function submitWithSms(server: WriteServer, root: HTMLElement): Promise<RequestLog> {
  const writes = server.writes().length;
  const sends = server.codeSends().length;
  const checks = server.verifications().length;
  await pressSubmit(root);
  await smsDialog();
  await waitFor(() => expect(server.codeSends()).toHaveLength(sends + 1));
  expect(server.verifications()).toHaveLength(checks);
  expect(server.writes(), 'nothing written before the verification').toHaveLength(writes);
  await verifySms(server);
  await waitFor(() => expect(server.writes()).toHaveLength(writes + 1));
  await settled(server);
  await waitFor(() => expect(stepUpDialogs()).toEqual([]));
  return server.writes().at(-1)!;
}

/** The Idempotency-Key of a write (asserted non-empty). */
export function idemOf(request: RequestLog): string {
  const value = request.headers.get('Idempotency-Key');
  expect(value).toEqual(expect.stringMatching(/\S/));
  return value!;
}
/**
 * One write as the contract wants it: POST /admin/v1/adjustments without a query, exactly
 * `body`, the admin bearer, the step-up pass `pass` and an Idempotency-Key; right before it the
 * sms-tier verification with the typed code, and before that a code sent.
 */
export function assertWrite(
  server: WriteServer,
  request: RequestLog,
  body: unknown,
  pass: string,
): void {
  expect(request.method).toBe('POST');
  expect(request.query).toEqual({});
  expect(request.body).toEqual(body);
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(pass);
  idemOf(request);
  const at = (one: RequestLog): number => server.log.indexOf(one);
  const check = server
    .verifications()
    .filter((one) => at(one) < at(request))
    .at(-1);
  expect(check?.body).toEqual({ tier: 'sms', code: OTP });
  const sends = server.codeSends().filter((one) => at(one) < at(check!));
  expect(sends.length, 'a code was sent before the verification').toBeGreaterThan(0);
}

/** A visible element of the page (drawer, dialog, message) reads exactly `text`. */
export function shows(text: string): boolean {
  return hasText(document.body, text);
}
/** The requests other than GET logged after the first `since`. */
export function nonReadsSince(server: WriteServer, since = 0): RequestLog[] {
  return server.log.slice(since).filter((r) => r.method !== 'GET');
}
/** One 【提交并短信验证】 shown in `root` and none usable: the submission is in flight. */
export function submitLocked(root: HTMLElement): boolean {
  return buttons(root, TEXT.submit).length === 1 && usable(root, TEXT.submit).length === 0;
}

// ---- prompts and the result-unknown state ----------------------------------------------------

/**
 * One element of the page reads exactly `lines` one after another (whitespace aside), each line
 * a visible element of its own whose whole text is that line: the whole of a success prompt.
 */
export function prompted(lines: readonly string[]): boolean {
  const whole = compact(lines.join(''));
  return Array.from(document.body.querySelectorAll<HTMLElement>('*')).some(
    (node) =>
      shown(node) &&
      compact(node.textContent) === whole &&
      lines.every((line) => hasText(node, line)),
  );
}

const CONTROLS = 'input, textarea, select, [role="combobox"], [role="radio"], [contenteditable]';
/** A control a person can still change: not disabled, and a text field not read-only. */
function changeable(node: HTMLElement): boolean {
  if (node instanceof HTMLInputElement && node.type === 'hidden') return false;
  if (!shown(node) || isDisabled(node)) return false;
  if (node.getAttribute('contenteditable') === 'false') return false;
  const combo = node.getAttribute('role') === 'combobox' || node instanceof HTMLSelectElement;
  if (combo || (node instanceof HTMLInputElement && ['radio', 'checkbox'].includes(node.type)))
    return true;
  const fixed =
    node.getAttribute('aria-readonly') === 'true' ||
    ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.readOnly);
  return !fixed;
}
/** The controls of `root` a person can still change (none while the result is unknown). */
export function changeableControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CONTROLS)).filter(changeable);
}
/** Names of the visible, usable buttons and links of `root` (text without spaces, or aria-label). */
export function usableNames(root: HTMLElement): string[] {
  const all = root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]');
  return Array.from(all)
    .filter((node) => shown(node) && !isDisabled(node))
    .map((node) => compact(node.textContent) || norm(node.getAttribute('aria-label')))
    .sort(byCode);
}
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** The two operations of the result-unknown state, as usableNames lists them. */
export const UNKNOWN_OPERATIONS: readonly string[] = [TEXT.check, TEXT.retry].sort(byCode);

/**
 * `root` is in the result-unknown state: the notice shown, no control changeable, the submit
 * button gone and only 【重试】 and 【去列表核对】 usable.
 */
export function assertUnknown(root: HTMLElement): void {
  expect(hasText(root, TEXT.unknown), 'the result-unknown notice').toBe(true);
  expect(changeableControls(root), 'every input locked').toEqual([]);
  expect(buttons(root, TEXT.submit), 'no submit button').toEqual([]);
  expect(usableNames(root)).toEqual(UNKNOWN_OPERATIONS);
}

/** Presses Escape inside `root` (a dialog or drawer that closes on Escape would close). */
export async function pressEscape(root: HTMLElement): Promise<void> {
  const active = document.activeElement;
  const target = active !== null && root.contains(active) ? active : root;
  await act(async () => {
    fireEvent.keyDown(target, { key: 'Escape', code: 'Escape', keyCode: 27 });
  });
  await settle();
}

/** Passes each sms verification the page asks for (at most three) until `done()` holds. */
export async function verifyUntil(server: WriteServer, done: () => boolean): Promise<void> {
  const asked = (): boolean => done() || dialogsTitled(SMS_TITLE).length === 1;
  for (let round = 0; round < 3; round += 1) {
    await waitFor(() => expect(asked(), 'done, or the sms step-up asked for').toBe(true));
    if (done()) return;
    await verifySms(server);
  }
  await waitFor(() => expect(done()).toBe(true));
}

/**
 * Presses 【重试】 of `root` and passes each sms verification asked for (the page may first send
 * the spent step-up pass and get 10003, or verify first) until a write passes the step-up
 * checks; returns that write once everything has settled.
 */
export async function retryWithSms(server: WriteServer, root: HTMLElement): Promise<RequestLog> {
  const since = server.writes().length;
  await click(button(root, TEXT.retry));
  await settle();
  const passed = (): RequestLog | undefined =>
    server.writes().find((one, index) => index >= since && server.admitted(one));
  await verifyUntil(server, () => passed() !== undefined);
  await settled(server);
  await waitFor(() => expect(stepUpDialogs()).toEqual([]));
  const found = passed();
  expect(found, 'the retried write passed the step-up').toBeDefined();
  return found!;
}

/**
 * Every write of `server` is the first one again, byte for byte: the same body text, the same
 * body, the same Idempotency-Key, POST /admin/v1/adjustments with the admin bearer.
 */
export function assertSameWrites(server: WriteServer, body: unknown): void {
  const all = server.writes();
  expect(all.length).toBeGreaterThan(0);
  const first = all[0]!;
  const text = server.rawOf(first);
  expect(text).toEqual(expect.stringMatching(/\S/));
  for (const one of all) {
    expect(one.method).toBe('POST');
    expect(one.query).toEqual({});
    expect(one.body).toEqual(body);
    expect(server.rawOf(one)).toBe(text);
    expect(one.headers.get('Authorization')).toBe('Bearer example-admin-token');
    expect(idemOf(one)).toBe(idemOf(first));
  }
}
