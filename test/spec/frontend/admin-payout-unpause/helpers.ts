import { act, cleanup, configure, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  BASE_URL,
  createPayoutServer,
  denied,
  failure,
  type PayoutServer,
} from '../admin-payouts-readonly/fixtures.ts';
import {
  CHANNEL_TITLE,
  FIELD,
  TAB,
  card,
  exactTexts,
  isShown,
  main,
  openTab,
  squash,
  values,
} from '../admin-payouts-readonly/helpers.ts';
import {
  button,
  buttons,
  click,
  disabled,
  fill,
  notice,
  settle,
  settled,
  step,
  stepDialogs,
  verify,
} from '../admin-payout-execute/helpers.ts';
import { closed, entryDialogs, messagesOf } from '../admin-payout-watermark/helpers.ts';
import { textbox } from '../admin-withdrawals/helpers.ts';
import {
  CODE,
  OVERVIEW,
  REASON_LABEL,
  SWITCHER,
  SWITCHER_GRANTS,
  SWITCHES,
  VERIFY,
  allowedHereToo,
  codePoints,
  failedWith,
  getOf,
  ok,
  overview,
  pausedOf,
  passOf,
  postOf,
  switchPath,
  switchesFor,
  verified,
  type Action,
  type Grants,
  type Overview,
  type PayoutChannel,
  type RequestLog,
  type Switch,
  type SwitchUpdate,
} from './fixtures.ts';

// 【暂停队列】 / 【解除暂停】 / 【解除通道暂停】 are reached only through the real shell
// (createAdminShell, menu `withdrawals`, tab 打款队列): no page module is imported, so a missing
// entry is an assertion failure. Only frozen pure helpers of the earlier payout suites are reused;
// their mount helpers are not (their request guards forbid the switch reads and writes of this
// task). The guard here allows the read-only tab's reads, the dynamic-code verification, GET
// /admin/v1/kill-switches and PUT /admin/v1/kill-switches/{key} of the queue and channel pauses.
//
// The fake server keeps the switch registry (fixtures switchesFor) and the overview in step: a
// change of payout.queue_paused or payout.channel_paused.<channel> shows in the next overview read.
// The list is read only when the page needs a version: opening the tab never reads it (a super
// admin opens the frozen read-only suites without that read).
configure({ asyncUtilTimeout: 10_000 });
export { button, buttons, click, closed, disabled, isShown, main, notice, settle, settled };
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
        'only the queue reads, the verification, the switch list and the pause PUTs',
      ).toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

// ---- the server --------------------------------------------------------------------------------

type Reply = (request: RequestLog) => Response | Promise<Response>;

interface State {
  readonly view: Overview;
  readonly switches: Switch[];
  readonly permissions: Grants;
  /** Scripted answers of the next PUTs, in order (then the normal answer). */
  readonly writes: Reply[];
  /** Scripted answers of the next overview reads, in order. */
  readonly reads: Reply[];
}
const states = new WeakMap<PayoutServer, State>();

function stateOf(server: PayoutServer): State {
  const state = states.get(server);
  expect(state, 'a server of serverFor').toBeDefined();
  return state!;
}

export interface Setup {
  readonly overview?: Overview;
  /** Permission points the server checks; defaults to fund.view + switch.payout. */
  readonly permissions?: Grants;
  /** Versions of the payout switches on top of fixtures VERSIONS (0 = never written). */
  readonly versions?: Readonly<Record<string, number>>;
  /** How many verified dynamic codes the server answers (passes 1…n); defaults to 3. */
  readonly passes?: number;
}

const isPut = (request: RequestLog): boolean =>
  request.method === 'PUT' && request.path.startsWith(`${SWITCHES}/`);
const signedIn = (request: RequestLog): boolean =>
  request.headers.get('Authorization') === 'Bearer example-admin-token';
const POSITIVE = /^[1-9][0-9]*$/;
const MEMBERS: readonly string[] = ['value', 'expected_version', 'reason'];

function holds(state: State, point: string): boolean {
  return (state.permissions as readonly string[]).includes(point);
}

/** The switch `name` shows `value`: the overview follows (queue and channel pauses). */
function showIn(view: Overview, name: string, value: unknown): void {
  if (typeof value !== 'boolean') return;
  if (name === 'payout.queue_paused') view.queue_paused = value;
  for (const channel of view.channels)
    if (name === pausedOf(channel.channel)) channel.paused = value;
}

function listPage(state: State, request: RequestLog): Response {
  if (!signedIn(request)) return failure(10001, undefined, '未登录');
  if (!['switch.all', 'switch.payout', 'switch.pay'].some((point) => holds(state, point)))
    return denied();
  const page = request.query['page'];
  const size = request.query['page_size'];
  const invalid = [
    ...(page === undefined || POSITIVE.test(page) ? [] : ['page']),
    ...(size === undefined || (POSITIVE.test(size) && Number(size) <= 200) ? [] : ['page_size']),
  ];
  if (invalid.length > 0) return failedWith(20001, { fields: invalid });
  const pageNo = page === undefined ? 1 : Number(page);
  const pageSize = size === undefined ? 20 : Number(size);
  const items = state.switches.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return ok({
    items: structuredClone(items),
    page: pageNo,
    page_size: pageSize,
    total: state.switches.length,
  });
}

/** The passes the server has issued so far (one per verification answered). */
function issued(server: PayoutServer): string[] {
  const count = server.log.filter(postOf(VERIFY)).length;
  return Array.from({ length: count }, (_, index) => passOf(index + 1));
}

/** adminUpdateKillSwitch as the contract describes it (CAS on expected_version). */
function update(server: PayoutServer, state: State, request: RequestLog): Response {
  if (!signedIn(request)) return failure(10001, undefined, '未登录');
  const name = decodeURIComponent(request.path.slice(SWITCHES.length + 1));
  const found = state.switches.find((item) => item['key'] === name);
  if (found === undefined || !found.admin_editable) return failedWith(20001, { fields: ['key'] });
  if (!found.permissions.some((point) => holds(state, point)))
    return failedWith(10403, { reason: 'admin_permission_denied' });
  if (!issued(server).includes(request.headers.get('X-Step-Up-Token') ?? ''))
    return failedWith(10003, { tier: 'totp' });
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return failedWith(20001, { fields: [] });
  const members = Object.entries(body as Record<string, unknown>);
  const extra = members.flatMap(([member]) => (MEMBERS.includes(member) ? [] : [member]));
  if (extra.length > 0) return failedWith(20001, { fields: extra });
  const sent = body as Partial<SwitchUpdate>;
  if (typeof sent.value !== 'boolean') return failedWith(20001, { fields: ['value'] });
  const expected = sent.expected_version;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)
    return failedWith(20001, { fields: ['expected_version'] });
  const reason: unknown = sent.reason;
  const reasonOk =
    reason === undefined ||
    (typeof reason === 'string' && codePoints(reason) >= 1 && codePoints(reason) <= 200);
  if (!reasonOk) return failedWith(20001, { fields: ['reason'] });
  if (expected !== found.version)
    return failedWith(20902, { resource: 'kill_switch' }, '状态已变化，请刷新后重试');
  if (sent.value !== (found.value ?? found.default)) {
    found.value = sent.value;
    found.version += 1;
    found.updated_by = 'fin-yi';
    found.updated_at = '2026-11-14T10:05:00+08:00';
    showIn(state.view, name, sent.value);
  }
  return ok(structuredClone(found));
}

/**
 * The frozen payout server whose overview read answers the current overview (the sample, or
 * `setup.overview`, as the switches change it), with the switch list and the switch PUT of the
 * contract and `passes` scripted verifications.
 */
export function serverFor(setup: Setup = {}): PayoutServer {
  const permissions = setup.permissions ?? SWITCHER_GRANTS;
  const server = createPayoutServer({ permissions });
  const view = structuredClone(setup.overview ?? overview());
  const state: State = {
    view,
    switches: switchesFor(view, setup.versions),
    permissions,
    writes: [],
    reads: [],
  };
  states.set(server, state);
  const answerRead: Reply = async (request) => {
    server.onceWhere(getOf(OVERVIEW), answerRead);
    const scripted = state.reads.shift();
    if (scripted !== undefined) return scripted(request);
    if (!signedIn(request)) return failure(10001, undefined, '未登录');
    if (!holds(state, 'fund.view') && !holds(state, 'payout.execute')) return denied();
    return ok(structuredClone(state.view));
  };
  const answerList: Reply = (request) => {
    server.onceWhere(getOf(SWITCHES), answerList);
    return listPage(state, request);
  };
  const answerWrite: Reply = async (request) => {
    server.onceWhere(isPut, answerWrite);
    const scripted = state.writes.shift();
    if (scripted !== undefined) return scripted(request);
    return update(server, state, request);
  };
  server.onceWhere(getOf(OVERVIEW), answerRead);
  server.onceWhere(getOf(SWITCHES), answerList);
  server.onceWhere(isPut, answerWrite);
  for (let n = 1; n <= (setup.passes ?? 3); n += 1)
    server.onceWhere(postOf(VERIFY), () => verified(n));
  return server;
}

/** The next PUT gets `reply` (it may call answerNormally for the contract's answer). */
export function scriptPut(server: PayoutServer, reply: Reply): void {
  stateOf(server).writes.push(reply);
}

/** The contract's answer to `request` on the current state. */
export function answerNormally(server: PayoutServer, request: RequestLog): Response {
  return update(server, stateOf(server), request);
}

/** Holds the next PUT until the returned release is called, then answers it normally. */
export function holdPut(server: PayoutServer): () => void {
  const gate = Promise.withResolvers<void>();
  scriptPut(server, async (request) => {
    await gate.promise;
    return answerNormally(server, request);
  });
  return () => gate.resolve();
}

/** The next overview read gets `reply`. */
export function scriptRead(server: PayoutServer, reply: Reply): void {
  stateOf(server).reads.push(reply);
}

/**
 * Another admin (or the system) changes the switch `name` to `value`, `writes` times (the version
 * moves on by `writes` even when the value ends where it was).
 */
export function changedElsewhere(
  server: PayoutServer,
  name: string,
  value: boolean,
  writes = 1,
): void {
  const state = stateOf(server);
  const found = state.switches.find((item) => item['key'] === name);
  expect(found, `the switch ${name}`).toBeDefined();
  found!.value = value;
  found!.version += writes;
  found!.updated_by = 'ops-er';
  found!.updated_at = '2026-11-14T10:04:00+08:00';
  showIn(state.view, name, value);
}

/** The version the server holds for the switch `name` now. */
export function versionOf(server: PayoutServer, name: string): number {
  const found = stateOf(server).switches.find((item) => item['key'] === name);
  expect(found, `the switch ${name}`).toBeDefined();
  return found!.version;
}

// ---- mounting ----------------------------------------------------------------------------------

/** Mounts the real shell on /withdrawals over `server` for `permissions`. */
export async function mount(
  server: PayoutServer,
  permissions: PermissionSnapshot = SWITCHER,
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
  permissions: PermissionSnapshot = SWITCHER,
): Promise<HTMLElement> {
  await mount(server, permissions);
  const panel = await openTab(TAB.queue);
  await waitFor(() => expect(server.overviewReads().length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(values(panel, FIELD.payout)).toHaveLength(1));
  return panel;
}

// ---- entries -----------------------------------------------------------------------------------

const PRESSABLE = 'button, a, [role="button"], [role="link"], [role="menuitem"]';

function nameOf(node: HTMLElement): string {
  return squash(node.textContent) || squash(node.getAttribute('aria-label'));
}

/** Names of every button or link of `root` (shown or not, usable or not), in document order. */
export function pressables(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(PRESSABLE)).map(nameOf);
}

/** The names (spaces removed) of the main area's buttons and links holding 暂停, sorted. */
export function pauseNames(): string[] {
  return pressables(main())
    .filter((name) => name.includes('暂停'))
    .sort();
}

/** The channel card titled like the payout channel `channel` inside `panel`. */
export function channelCard(panel: HTMLElement, channel: PayoutChannel): HTMLElement {
  return card(panel, CHANNEL_TITLE[channel]);
}

/** Whether `node` sits on one of the three channel cards of `panel`. */
export function onChannelCard(panel: HTMLElement, node: HTMLElement): boolean {
  const channels: readonly PayoutChannel[] = ['alipay', 'bank_card', 'wechat'];
  return channels.some((channel) => channelCard(panel, channel).contains(node));
}

/**
 * The one shown, usable entry of `action`: in the 打款队列 panel `panel` off the channel cards (the
 * title row), or on its channel card.
 */
export function entryFor(panel: HTMLElement, action: Action): HTMLElement {
  const root = action.channel === undefined ? panel : channelCard(panel, action.channel);
  const found = buttons(root, action.entry).filter(isShown);
  const where = action.channel === undefined ? 'the queue tab' : `the ${action.channel} card`;
  expect(found, `one entry ${action.entry} on ${where}`).toHaveLength(1);
  expect(disabled(found[0]!), `${action.entry} usable`).toBe(false);
  if (action.channel === undefined)
    expect(onChannelCard(panel, found[0]!), `${action.entry} is not on a channel card`).toBe(false);
  return found[0]!;
}

// ---- the dialog --------------------------------------------------------------------------------

/** The open dialogs that are not the StepUpModal. */
export function switchDialogs(): HTMLElement[] {
  return entryDialogs();
}

export interface Opened {
  readonly modal: HTMLElement;
  /** The entry pressed (the focus returns to it). */
  readonly trigger: HTMLElement;
  /** The length of the server log when the entry was pressed. */
  readonly mark: number;
}

/** Presses the entry of `action` and returns its one dialog (no step-up yet, no PUT). */
export async function openAction(
  server: PayoutServer,
  panel: HTMLElement,
  action: Action,
): Promise<Opened> {
  const sent = puts(server).length;
  const trigger = entryFor(panel, action);
  trigger.focus();
  const mark = server.log.length;
  await click(trigger);
  await waitFor(() => expect(switchDialogs(), 'one confirmation dialog').toHaveLength(1));
  expect(stepDialogs(), 'no step-up on opening').toEqual([]);
  expect(puts(server), 'no PUT on opening').toHaveLength(sent);
  return { modal: switchDialogs()[0]!, trigger, mark };
}

/** The title of `modal` (its aria-labelledby, else aria-label), spaces removed. */
export function titleOf(modal: HTMLElement): string {
  const ids = (modal.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const named = ids.map((id) => squash(document.getElementById(id)?.textContent));
  return named.join('') || squash(modal.getAttribute('aria-label'));
}

/** The elements of `modal` whose whole text (spaces removed) is `text`. */
export function paragraphs(modal: HTMLElement, text: string): string[] {
  return exactTexts(modal, [squash(text)]);
}

/** The reason input of `modal`. */
export function reasonInput(modal: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  return textbox(modal, REASON_LABEL);
}

/** The messages (spaces removed) shown for the reason input of `modal`. */
export function reasonMessages(modal: HTMLElement): string[] {
  return messagesOf(reasonInput(modal));
}

/** Types `text` into the reason input of `modal` ('' empties it). */
export async function typeReason(modal: HTMLElement, text: string): Promise<void> {
  const input = reasonInput(modal);
  await act(async () => {
    fireEvent.focus(input);
  });
  await fill(input, text);
  await act(async () => {
    fireEvent.blur(input);
  });
  await settle();
}

/** Presses the confirm button of `modal`: the totp StepUpModal opens and no PUT is sent yet. */
export async function confirm(
  server: PayoutServer,
  modal: HTMLElement,
  action: Action,
  twice = false,
): Promise<void> {
  const sent = puts(server).length;
  await click(button(modal, action.submit), twice);
  await step();
  expect(puts(server), 'no PUT before the dynamic code').toHaveLength(sent);
}

/** Confirms `modal`, enters the dynamic code and waits for one more PUT. */
export async function submit(server: PayoutServer, modal: HTMLElement, action: Action) {
  const before = puts(server).length;
  await confirm(server, modal, action);
  await verify();
  await waitFor(() => expect(puts(server)).toHaveLength(before + 1));
  await settled(server);
}

/**
 * Tries `action` again: presses the confirm button of its dialog when it is still open, else its
 * entry and then the confirm button; the page may reuse a still valid pass or ask for another
 * dynamic code (then it is entered). Waits for one more PUT. Returns the log length at the press.
 */
export async function tryAgain(
  server: PayoutServer,
  panel: HTMLElement,
  action: Action,
): Promise<number> {
  const before = puts(server).length;
  const mark = server.log.length;
  const open = switchDialogs();
  const modal = open.length === 1 ? open[0]! : (await openAction(server, panel, action)).modal;
  await click(button(modal, action.submit));
  await waitFor(() =>
    expect(puts(server).length === before + 1 || stepDialogs().length === 1).toBe(true),
  );
  if (stepDialogs().length === 1) await verify();
  await waitFor(() => expect(puts(server)).toHaveLength(before + 1));
  await settled(server);
  return mark;
}

// ---- the requests ------------------------------------------------------------------------------

export function puts(server: PayoutServer): RequestLog[] {
  return server.log.filter(isPut);
}
export function listReads(server: PayoutServer): RequestLog[] {
  return server.log.filter(getOf(SWITCHES));
}
export function verifications(server: PayoutServer): RequestLog[] {
  return server.log.filter(postOf(VERIFY));
}
export function overviewReads(server: PayoutServer): RequestLog[] {
  return server.overviewReads();
}
/** The pass the latest verification issued (1-based). */
export function latestPass(server: PayoutServer): number {
  return verifications(server).length;
}

/**
 * The `count`-th PUT (1-based) is the whole contract request for `action`: PUT
 * /admin/v1/kill-switches/<its switch>, no query, exactly `body`, the admin bearer, the step-up pass
 * `pass` and no Idempotency-Key; it follows the verification that issued that pass and a read of the
 * switch list made after the log length `since` (the version comes from that read).
 */
export function assertPut(
  server: PayoutServer,
  action: Action,
  body: SwitchUpdate,
  count: number,
  pass: number,
  since: number,
): RequestLog {
  const sent = puts(server);
  expect(sent, 'switch PUTs').toHaveLength(count);
  const request = sent[count - 1]!;
  expect(request.method).toBe('PUT');
  expect(request.path).toBe(switchPath(action.name));
  expect(request.query).toEqual({});
  expect(request.body, 'the whole body').toStrictEqual(body);
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(passOf(pass));
  expect(request.headers.has('Idempotency-Key'), 'no Idempotency-Key').toBe(false);
  const checks = verifications(server);
  expect(checks.length, 'verifications so far').toBeGreaterThanOrEqual(pass);
  for (const one of checks) expect(one.body).toEqual({ tier: 'totp', code: CODE });
  const at = server.log.indexOf(request);
  expect(at).toBeGreaterThan(server.log.indexOf(checks[pass - 1]!));
  const reads = listReads(server).map((read) => server.log.indexOf(read));
  expect(
    reads.some((index) => index >= since && index < at),
    'the switch list was read for this PUT (after the press, before the PUT)',
  ).toBe(true);
  return request;
}

/** The overview was read again after `request`. */
export async function rereadAfter(server: PayoutServer, request: RequestLog): Promise<void> {
  const at = server.log.indexOf(request);
  await waitFor(() =>
    expect(
      overviewReads(server).some((read) => server.log.indexOf(read) > at),
      'the overview read after the PUT',
    ).toBe(true),
  );
  await settled(server);
}

/** The values (spaces removed) of the 暂停状态 field of the `channel` card. */
export function pausedShown(panel: HTMLElement, channel: PayoutChannel): string[] {
  return values(channelCard(panel, channel), FIELD.paused);
}
/** The values (spaces removed) of the 队列运行状态 field. */
export function queueShown(panel: HTMLElement): string[] {
  return values(panel, FIELD.queue);
}
