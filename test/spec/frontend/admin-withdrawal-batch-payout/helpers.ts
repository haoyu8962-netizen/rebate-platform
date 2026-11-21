// F1-08an：提现审核页（审核列表）的【批量自动打款】、【一键组批】与各状态页签计数。
// What the tests of this directory decide (the implementation is free in everything else):
// - The page is reached only through the real shell (createAdminShell, memory router, menu
//   `withdrawals`); no page module is imported, so a missing feature is an assertion failure.
// - 【批量自动打款】 (BR-WDR-12 后台【批量自动打款】, BR-WDR-11): adminCreatePayoutBatch POST
//   /admin/v1/payout-batches, permission point payout.execute (a super admin holds every point),
//   totp-tier step-up (BR-ID-34 动态码档), Idempotency-Key required, body exactly
//   {withdrawal_ids} of the ticked APPROVED withdrawals in list order. A ticked PENDING_REVIEW
//   withdrawal is not reviewed by it: listed as 「未审核」 and never sent. The entry only appears once
//   an APPROVED row is ticked (as 【批量手动打款】, frozen F1-08al).
// - Result unknown (D10-1731 / D10-1739 / D10-2060 / D10-2061, as F1-08ce / F1-08am): no answer,
//   an unreadable answer, an enveloped 5xx or 40901 → 「上次提交结果未知」, only 【重试】 (same key,
//   same bytes, after a new dynamic code) and a 「…核对」 action, nothing sent by itself.
// - 【一键组批】 is pure front end: it ticks the withdrawals that can be executed (APPROVED, without
//   a withdrawal block — the「暂停」mark, blocked_reason, BR-WDR-05) and sends no write.
// - Status tab counts: the `total` of one listAdminWithdrawals read with page_size=1 per tab,
//   never a sum made by the page (D10-2017); a failed count read shows no count and blocks nothing.
// Wording: the frozen texts of 【执行所选】 / 【执行打款】 (admin-payout-execute fixtures), reused as
// independent full-copy expectations, not imports of the implementation's texts.
import { formatYuanAdmin, parseFen } from '@couli/money';
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
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { overview, type Overview } from '../admin-payouts-readonly/fixtures.ts';
import {
  BASE_URL,
  LIST,
  LIST_PARAMS,
  TRACE_ID,
  USER,
  PHONE,
  createServer,
  ok,
  samples,
  type RequestLog,
  type Withdrawal,
} from '../admin-withdrawals/fixtures.ts';

configure({ asyncUtilTimeout: 10_000 });
export { ok };
export type { Overview, RequestLog, Withdrawal };

export type BatchResult = Schema<'AdminPayoutBatchResult'>;
export type LeftReason = Schema<'AdminPayoutBatchLeftItem'>['reason'];
export type RefusedReason = NonNullable<BatchResult['reason']>;

export const BATCHES = '/admin/v1/payout-batches';
export const VERIFY = '/admin/v1/auth/step-up';
export const OVERVIEW = '/admin/v1/payout-overview';
export const OTP = '123456';
export const NEW_BATCH = 'b2000020-0000-4000-8000-000000000020';

/** Entry and dialog buttons (exact accessible names). */
export const NAME = {
  entry: '批量自动打款',
  group: '一键组批',
  submit: '确认执行',
  cancel: '取消',
  close: '关闭',
  retry: '重试',
  verify: '验证并继续',
  approve: '批量通过',
  manual: '批量手动打款',
} as const;

/** Independent full-copy expectations (frozen wording of F1-08bb / F1-08am / F1-08al). */
export const TEXT = {
  unknown: '上次提交结果未知',
  checkTitle: '执行前检查',
  paying: '已发起打款',
  /** BR-WDR-12 细则：勾选中的 PENDING_REVIEW 单结果列显示「未审核」. */
  unreviewed: '未审核',
  again: '动态码凭证已失效，请重新输入动态码',
  forbidden: '无权限执行此操作（需要 payout.execute 权限点）',
  ids: '提现单编号有误，请刷新页面后重试',
} as const;
export const LEFT_TEXT: Readonly<Record<LeftReason, string>> = {
  not_approved: '单据已不是待执行状态（已被处理或状态已变化），本次未执行',
  member_blocked: '会员有提现阻断，本次未执行',
  has_transfer_attempt: '已有转账记录，只能手动成功或驳回，本次未执行',
  channel_disabled: '该单的打款通道未开通或已暂停，本次未执行',
  watermark_stale: '所在通道的余额 W 未录入或已过期，本次未执行',
  watermark_below_forecast: '所在通道的余额 W 低于预计提现 P，本次未执行',
  watermark_usable_exceeded: '所在通道在途与本批合计超过可用余额，本次未执行',
};
/** The notice of a whole batch refused (the alipay channel for a watermark reason). */
export const REFUSED_TEXT: Readonly<Partial<Record<RefusedReason, string>>> = {
  payout_disabled: '整批未执行：打款开关已关闭',
  queue_paused: '整批未执行：打款队列已暂停',
  watermark_below_forecast: '整批未执行：企业支付宝余额 W 低于预计提现 P',
};
/** Statuses as the console dictionary names them (admin_dict.withdrawal_status.*). */
export const STATUS_SHOWN = { APPROVED: '已通过待打款', PAYING: '打款中' } as const;

/** One pre-check item, compared with every space removed (frozen F1-08bb wording). */
export const check = (label: string, value: string, met: boolean): string =>
  `${label}：${value}（${met ? '满足' : '未满足'}）`;

/** An amount in fen as the console shows it (only through @couli/money). */
export function yuan(fen: number): string {
  return formatYuanAdmin(parseFen(fen));
}

// ---- permission snapshots -------------------------------------------------------------------

/** fund.view to read plus payout.execute (totp). */
export const EXECUTOR: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view', 'payout.execute'],
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'payout.execute': { tier: 'totp', operations: {} },
  },
};
export const VIEWER: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view'],
  stepUp: { 'fund.view': { tier: null, operations: {} } },
};
export const REVIEWER: PermissionSnapshot = {
  isSuper: false,
  permissions: ['withdraw.review'],
  stepUp: { 'withdraw.review': { tier: 'totp', operations: {} } },
};
export const RECORDER: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view', 'payout.manual_entry'],
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'payout.manual_entry': { tier: 'totp', operations: {} },
  },
};
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- data -----------------------------------------------------------------------------------

type Status = Withdrawal['status'];
const DISPLAY: Readonly<Record<Status, Withdrawal['display_status']>> = {
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'pending_review',
  REJECTED: 'rejected',
  PAYING: 'paying',
  PAID_API: 'paid_auto_review',
  PAID_MANUAL: 'paid_manual',
  FAILED: 'failed',
};

/** A withdrawal `n` (1-based, newer for a smaller n) in `status` on `channel` with `net` fen. */
export function row(
  n: number,
  status: Status,
  net: number,
  channel: Withdrawal['payout_channel'] = 'alipay',
  changes: Partial<Withdrawal> = {},
): Withdrawal {
  const two = String(n).padStart(2, '0');
  return {
    ...samples()[0]!,
    withdrawal_id: `e30000${two}-0000-4000-8000-000000000020`,
    out_biz_no: `W202611190002${two}`,
    user: n % 2 === 0 ? { user_id: USER.b, phone_masked: PHONE.b } : { ...samples()[0]!.user },
    status,
    display_status: DISPLAY[status],
    review_mode: 'manual',
    payout_channel: channel,
    payout_method: channel,
    amount_fen: net + 200,
    fee_fen: 200,
    tax_fen: 0,
    net_fen: net,
    blocked_reason: null,
    hold_reason: null,
    needs_manual: false,
    risk_flags: [],
    batch_id: null,
    batch: null,
    batch_items: [],
    payout_attempts: [],
    holds: [],
    created_at: `2026-11-19T10:${String(59 - n).padStart(2, '0')}:00+08:00`,
    updated_at: `2026-11-19T11:${String(59 - n).padStart(2, '0')}:00+08:00`,
    ...changes,
  };
}

/** Three APPROVED rows (alipay ¥12,345.67, bank card ¥98.01, alipay ¥500.00), list order. */
export function approvedRows(): Withdrawal[] {
  return [
    row(1, 'APPROVED', 1234567),
    row(2, 'APPROVED', 9801, 'bank_card'),
    row(3, 'APPROVED', 50000),
  ];
}

/**
 * A mixed list (newest first): A, B APPROVED without a block, P PENDING_REVIEW, K APPROVED with
 * the「暂停」mark (blocked_reason), Y PAYING, D PAID_API.
 */
export function mixedRows(): Record<'a' | 'b' | 'p' | 'k' | 'y' | 'd', Withdrawal> {
  return {
    a: row(1, 'APPROVED', 1234567),
    b: row(2, 'APPROVED', 9801, 'bank_card'),
    p: row(3, 'PENDING_REVIEW', 30000),
    k: row(4, 'APPROVED', 7700, 'alipay', { blocked_reason: 'NEGATIVE_BALANCE' }),
    y: row(5, 'PAYING', 4400, 'alipay', { execute_seq: 1 }),
    d: row(6, 'PAID_API', 2000, 'alipay', {
      execute_seq: 1,
      paid_at: '2026-11-19T10:00:00+08:00',
    }),
  };
}
export function listOf(rows: Record<string, Withdrawal>): Withdrawal[] {
  return Object.values(rows);
}

// ---- the status tabs and their counts -------------------------------------------------------

export type CountTab = 'all' | 'pendingReview' | 'rejected' | 'manual' | 'auto';
export const TAB_NAMES: Readonly<Record<CountTab, string>> = {
  all: '全部',
  pendingReview: '待审',
  rejected: '驳回',
  manual: '手动',
  auto: '自动',
};
/** The totals the server answers the page_size=1 count reads with (none equals a row count). */
export const TOTALS: Readonly<Record<CountTab, number>> = {
  all: 128,
  pendingReview: 37,
  rejected: 9,
  manual: 15,
  auto: 52,
};

/** A count read: GET /admin/v1/withdrawals with page_size=1. */
export function isCountRead(request: RequestLog): boolean {
  return request.method === 'GET' && request.path === LIST && request.query['page_size'] === '1';
}
/** A table read: GET /admin/v1/withdrawals with another page size. */
export function isTableRead(request: RequestLog): boolean {
  return request.method === 'GET' && request.path === LIST && request.query['page_size'] !== '1';
}

/** The status tab whose quick filter (and nothing else) a count read carries, else undefined. */
export function tabOfCount(query: Readonly<Record<string, string>>): CountTab | undefined {
  const rest = Object.entries(query).filter(([name]) => name !== 'page' && name !== 'page_size');
  if (rest.length === 0) return 'all';
  if (rest.length !== 1) return undefined;
  const [name, value] = rest[0]!;
  const is = (key: string, wanted: string): boolean => name === key && value === wanted;
  if (is('display_status', 'pending_review')) return 'pendingReview';
  if (is('display_status', 'rejected') || is('status', 'REJECTED')) return 'rejected';
  if (is('display_status', 'paid_manual') || is('status', 'PAID_MANUAL')) return 'manual';
  if (is('status', 'PAID_API')) return 'auto';
  return undefined;
}

// ---- fake server ----------------------------------------------------------------------------

export type CountMode = 'scripted' | 'fail' | 'real';

export interface Setup {
  /** How the page_size=1 count reads are answered (default: the TOTALS). */
  readonly counts?: CountMode;
  readonly overview?: Overview;
}

const FAR = '2099-01-01T00:00:00Z';
const HTTP: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  40901: 409,
  50001: 500,
};
/** An error in the unified envelope with its contract HTTP status. */
export function failure(code: number, data: unknown = {}): Response {
  return Response.json({ code, msg: '', data, trace_id: TRACE_ID }, { status: HTTP[code] ?? 400 });
}
/** The connection drops: no answer at all. */
export function networkDown(): never {
  throw new TypeError('Failed to fetch');
}
/** An answer without the unified envelope. */
export function garbled(): Response {
  return new Response('<html><body>bad gateway</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}
/** A 200 whose body is not JSON. */
export function brokenJson(): Response {
  return new Response('{"code":0,"data":', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The pass handed out by the `n`-th verification (1-based). */
export const passOf = (n: number): string => `auto-pass-${n}`;

/** The withdrawal fake server with the overview, 24 verifications and the raw batch bodies. */
export function serverFor(rows: readonly Withdrawal[], setup: Setup = {}) {
  const server = createServer([...rows], { permissions: ['fund.view'] });
  const view: { current: Overview; counts: CountMode } = {
    current: setup.overview ?? overview(),
    counts: setup.counts ?? 'scripted',
  };
  const raw: string[] = [];
  for (let pass = 1; pass <= 24; pass += 1) {
    const reply = { ['step_up_token']: passOf(pass), tier: 'totp', expire_at: FAR };
    server.once('POST', VERIFY, () => ok(reply));
    server.once('GET', OVERVIEW, () => ok(view.current));
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const given = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const method = given.toUpperCase();
    if (url.pathname === BATCHES && method === 'POST') {
      const body =
        init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      expect(typeof body, 'actual HTTP body').toBe('string');
      raw.push(body as string);
    }
    const response = await server.fetch(input, init);
    const count =
      url.pathname === LIST && method === 'GET' && url.searchParams.get('page_size') === '1';
    if (!count || view.counts === 'real') return response;
    if (view.counts === 'fail') return failure(50001, null);
    const tab = tabOfCount(Object.fromEntries(url.searchParams));
    if (tab === undefined || !response.ok) return response;
    const answer = (await response.json()) as { data: Record<string, unknown> };
    return ok({ ...answer.data, total: TOTALS[tab] });
  };
  return {
    ...server,
    fetch,
    raw,
    view,
    get pending() {
      return server.pending;
    },
  };
}
export type Server = ReturnType<typeof serverFor>;

/** The paying ids move APPROVED → PAYING on the server (W4) onto the new batch. */
export function payOnServer(server: Server, paying: readonly string[]): void {
  for (const id of paying) {
    const item = server.state.find((one) => one.withdrawal_id === id);
    expect(item, `server row ${id}`).toBeDefined();
    item!.status = 'PAYING';
    item!.display_status = 'paying';
    item!.execute_seq += 1;
    item!.batch_id = NEW_BATCH;
    item!.executed_at = '2026-11-19T12:00:00+08:00';
  }
}
export function executed(
  paying: readonly string[],
  left: readonly { withdrawal_id: string; reason: LeftReason }[] = [],
): BatchResult {
  return {
    outcome: 'executed',
    batch_id: NEW_BATCH,
    reason: null,
    channel: null,
    paying: [...paying],
    left: [...left],
  };
}
/** An executed answer that also moves the paying ids on the server. */
export function executedReply(
  server: Server,
  paying: readonly string[],
  left: readonly { withdrawal_id: string; reason: LeftReason }[] = [],
): Response {
  payOnServer(server, paying);
  return ok(executed(paying, left));
}
export function refused(reason: RefusedReason): BatchResult {
  return {
    outcome: 'rejected',
    batch_id: null,
    reason,
    channel: reason.startsWith('watermark_') ? 'alipay' : null,
    paying: [],
    left: [],
  };
}

// ---- mounting -------------------------------------------------------------------------------

type DirectFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
const tracked: { server: Server; direct: DirectFetch | null }[] = [];
const READS: readonly string[] = [LIST, OVERVIEW, '/admin/v1/dict', '/admin/v1/me/permissions'];
const POSTS: readonly string[] = [VERIFY, BATCHES];

/** The only requests allowed: list / overview / common reads, the verification and the batch. */
export function allowed(request: RequestLog): boolean {
  if (request.method === 'GET') return READS.includes(request.path);
  return request.method === 'POST' && POSTS.includes(request.path);
}
/** Checks the requests of `server` after the test (used where the console is mounted elsewhere). */
export function track(server: Server): void {
  tracked.push({ server, direct: null });
}

afterEach(() => {
  const current = tracked.splice(0);
  try {
    for (const { server, direct } of current) {
      if (direct !== null) expect(direct, 'no direct fetch').not.toHaveBeenCalled();
      const stray = server.log
        .filter((request) => !allowed(request))
        .map((request) => `${request.method} ${request.path}`);
      expect(stray, 'no other write (approve, manual paid, export …) or read').toEqual([]);
      for (const read of server.log.filter((request) => request.path === LIST))
        expect(
          Object.keys(read.query).filter((name) => !LIST_PARAMS.includes(name)),
          'only listAdminWithdrawals parameters',
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
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await settle();
}

export function stubMedia(): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
}

/** Mounts the real shell on 资金 / 提现审核 and waits for the first row of the list. */
export async function mount(server: Server, permissions: PermissionSnapshot = EXECUTOR) {
  stubMedia();
  const direct = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', direct);
  tracked.push({ server, direct });
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'withdrawals' },
        permissionsProvider: async () => permissions,
        account: { username: 'finance', displayName: '财务' },
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
  await listed(server, server.state[0]!.out_biz_no);
}

/** The list was read and the row of `number` is on the page. */
export async function listed(server: Server, number: string): Promise<void> {
  await waitFor(() => expect(server.log.some(isTableRead), 'a read of the list').toBe(true));
  await waitFor(() => expect(rowsOf(main(), number)).toHaveLength(1));
  await settled(server);
}

// ---- DOM ------------------------------------------------------------------------------------

export function main(): HTMLElement {
  const area = document.querySelector<HTMLElement>('main');
  expect(area, 'real shell main').not.toBeNull();
  return area!;
}
export function compact(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, '');
}
export function nameOf(node: HTMLElement): string {
  return compact(node.getAttribute('aria-label')) || compact(node.textContent);
}
export function buttons(root: HTMLElement, name: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, a, [role="button"]')).filter(
    (node) =>
      compact(node.textContent) === compact(name) || node.getAttribute('aria-label') === name,
  );
}
export function button(root: HTMLElement, name: string): HTMLElement {
  const found = buttons(root, name);
  expect(found, `one button: ${name}`).toHaveLength(1);
  return found[0]!;
}
export function disabled(node: HTMLElement): boolean {
  return node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true';
}
/** The usable buttons of `root` by name. */
export function usableButtons(root: HTMLElement): string[] {
  return within(root)
    .queryAllByRole('button')
    .filter((node) => !disabled(node))
    .map((node) => nameOf(node));
}
export function shows(root: HTMLElement, text: string): boolean {
  return compact(root.textContent).includes(compact(text));
}
export async function notice(text: string, root: HTMLElement = document.body): Promise<void> {
  await waitFor(() => expect(shows(root, text), text).toBe(true));
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
    fireEvent.blur(node);
  });
}

/** Rows (role=row) of `root` holding the withdrawal number `number` as a whole text. */
export function rowsOf(root: HTMLElement, number: string): HTMLElement[] {
  return within(root)
    .queryAllByRole('row')
    .filter((one) => within(one).queryAllByText(number, { exact: true }).length > 0);
}
export function rowOf(root: HTMLElement, number: string): HTMLElement {
  const found = rowsOf(root, number);
  expect(found, `one row: ${number}`).toHaveLength(1);
  return found[0]!;
}
/** The usable checkboxes of the list row of `item`. */
export function usableBoxes(item: Withdrawal): HTMLInputElement[] {
  return within(rowOf(main(), item.out_biz_no))
    .queryAllByRole('checkbox')
    .filter((node) => !disabled(node)) as HTMLInputElement[];
}
export function checkbox(item: Withdrawal): HTMLInputElement {
  const choices = usableBoxes(item);
  expect(choices, `one usable checkbox: ${item.out_biz_no}`).toHaveLength(1);
  expect(choices[0]).toBeInstanceOf(HTMLInputElement);
  return choices[0]!;
}
export async function select(items: readonly Withdrawal[]): Promise<void> {
  for (const item of items) {
    await click(checkbox(item));
    expect(checkbox(item).checked, `${item.out_biz_no} ticked`).toBe(true);
  }
}
/** The checked checkboxes of the list. */
export function ticked(): HTMLInputElement[] {
  return (within(main()).queryAllByRole('checkbox') as HTMLInputElement[]).filter(
    (node) => node.checked,
  );
}

export function dialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter((node) => {
    for (let parent: HTMLElement | null = node; parent !== null; parent = parent.parentElement)
      if (parent.hidden || parent.style.display === 'none') return false;
    return true;
  });
}
export function stepDialogs(): HTMLElement[] {
  return dialogs().filter(
    (node) => within(node).queryAllByText('二次验证 · 动态码', { exact: true }).length === 1,
  );
}
/** The page's own dialog (not the step-up). */
export function payDialog(): HTMLElement {
  const own = dialogs().filter((node) => !stepDialogs().includes(node));
  expect(own, 'one dialog of the page').toHaveLength(1);
  return own[0]!;
}

/** The withdrawal numbers among `numbers` that have a row in `root`, in document order. */
export function numbersIn(root: HTMLElement, numbers: readonly string[]): string[] {
  return within(root)
    .queryAllByRole('row')
    .flatMap((one) =>
      numbers.filter((number) => within(one).queryAllByText(number, { exact: true }).length > 0),
    );
}

/**
 * Some row holding `number` — in a dialog of the page or in the list's 「原因 / 执行结果」 column —
 * shows `text`.
 */
export async function resultShown(number: string, text: string): Promise<void> {
  await waitFor(() =>
    expect(
      rowsOf(document.body, number).some((one) => shows(one, text)),
      `${number}: ${text}`,
    ).toBe(true),
  );
}
/** No row holding `number` (dialog or list) shows `text`. */
export function resultNotShown(number: string, text: string): void {
  expect(
    rowsOf(document.body, number).filter((one) => shows(one, text)),
    `${number} does not show ${text}`,
  ).toEqual([]);
}

// ---- step-up ----------------------------------------------------------------------------------

export async function step(): Promise<HTMLElement> {
  await waitFor(() => expect(stepDialogs(), 'one totp StepUpModal').toHaveLength(1));
  const verification = stepDialogs()[0]!;
  expect(within(verification).queryAllByLabelText('动态码', { exact: true })).toHaveLength(1);
  expect(within(verification).queryAllByLabelText('验证码', { exact: true })).toEqual([]);
  expect(buttons(verification, '重新发送')).toEqual([]);
  return verification;
}
export async function verify(twice = false): Promise<void> {
  const verification = await step();
  const fields = within(verification).queryAllByLabelText('动态码', { exact: true });
  await fill(fields[0]!, OTP);
  await click(button(verification, NAME.verify), twice);
}

// ---- the flow ---------------------------------------------------------------------------------

export function writes(server: Server): RequestLog[] {
  return server.requests('POST', BATCHES);
}
export function keyOf(request: RequestLog): string | null {
  return request.headers.get('Idempotency-Key');
}

/** Press 【批量自动打款】: the confirmation (no step-up, nothing sent yet). */
export async function openBatch(server: Server): Promise<HTMLElement> {
  const before = writes(server).length;
  const entry = button(main(), NAME.entry);
  expect(disabled(entry), `${NAME.entry} usable`).toBe(false);
  await click(entry);
  await waitFor(() => expect(dialogs(), 'one confirmation dialog').toHaveLength(1));
  await settled(server);
  expect(stepDialogs()).toEqual([]);
  expect(writes(server)).toHaveLength(before);
  return dialogs()[0]!;
}

/** Press 【确认执行】: the totp step-up follows, nothing is sent before it. */
export async function confirm(server: Server, modal: HTMLElement, twice = false): Promise<void> {
  const before = writes(server).length;
  const node = button(modal, NAME.submit);
  expect(disabled(node), `${NAME.submit} usable`).toBe(false);
  await click(node, twice);
  await step();
  expect(writes(server)).toHaveLength(before);
}

/** Ticks `rows`, opens the dialog, confirms and passes the dynamic code; one write follows. */
export async function runBatch(server: Server, rows: readonly Withdrawal[]): Promise<HTMLElement> {
  await select(rows);
  const modal = await openBatch(server);
  await confirm(server, modal);
  const before = writes(server).length;
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(before + 1));
  await settled(server);
  return modal;
}

/** The step-up pass handed out by the last verification before `request`. */
function passBefore(server: Server, request: RequestLog): number {
  const at = server.log.indexOf(request);
  return server.log.filter(
    (one, index) => index < at && one.method === 'POST' && one.path === VERIFY,
  ).length;
}

/** The `index`-th batch request (0-based) is exactly the batch of `ids`, verified just before. */
export function assertBatch(server: Server, index: number, ids: readonly string[]): void {
  const request = writes(server)[index];
  expect(request, `batch request ${index + 1}`).toBeDefined();
  expect(request!.method).toBe('POST');
  expect(request!.path).toBe(BATCHES);
  expect(request!.query).toEqual({});
  expect(request!.body).toEqual({ withdrawal_ids: [...ids] });
  expect(request!.headers.get('Authorization')).toBe('Bearer example-admin-token');
  const pass = passBefore(server, request!);
  expect(pass, 'verified before the write').toBeGreaterThan(0);
  expect(request!.headers.get('X-Step-Up-Token')).toBe(passOf(pass));
  expect(keyOf(request!)).toEqual(expect.stringMatching(/^\S+$/));
  const verifications = server.requests('POST', VERIFY).map((one) => one.body);
  expect(verifications).toEqual(verifications.map(() => ({ tier: 'totp', code: OTP })));
}

/** Every batch write so far is the first one again: one key, the same bytes. */
export function assertSameWrites(server: Server, count: number): void {
  const sent = writes(server);
  expect(sent).toHaveLength(count);
  expect(sent.map(keyOf)).toEqual(sent.map(() => keyOf(sent[0]!)));
  expect(server.raw).toHaveLength(count);
  expect(server.raw).toEqual(server.raw.map(() => server.raw[0]));
}

/**
 * The result-unknown state: the notice, only 【重试】 and a 「…核对」 action usable, Escape and the
 * mask do not close the dialog, no step-up open, nothing sent again by itself.
 */
export async function assertUnknown(server: Server, modal: HTMLElement): Promise<void> {
  await notice(TEXT.unknown, modal);
  await settled(server);
  const count = writes(server).length;
  await waitFor(() => expect(dialogs(), 'only the dialog of the page').toEqual([modal]));
  expect(stepDialogs()).toEqual([]);
  const usable = usableButtons(modal);
  expect(usable, 'only 重试 and the check action').toHaveLength(2);
  expect(usable).toContain(NAME.retry);
  expect(usable.filter((one) => one !== NAME.retry)).toEqual([expect.stringMatching(/核对/)]);
  await act(async () => {
    fireEvent['keyDown'](modal, { ['key']: 'Escape', code: 'Escape' });
  });
  const outside = modal.closest('.ant-modal-wrap');
  if (outside !== null)
    await act(async () => {
      fireEvent.mouseDown(outside);
      fireEvent.mouseUp(outside);
      fireEvent.click(outside);
    });
  await settle();
  expect(dialogs()).toEqual([modal]);
  await settled(server);
  expect(writes(server), 'nothing sent again by itself').toHaveLength(count);
}

/** The 「…核对」 action of the result-unknown state. */
export function checkAction(modal: HTMLElement): HTMLElement {
  const found = within(modal)
    .queryAllByRole('button')
    .filter((node) => !disabled(node) && /核对/.test(nameOf(node)));
  expect(found, 'one check action').toHaveLength(1);
  return found[0]!;
}

/** Press 【重试】 in the result-unknown state: step-up again, then exactly one more write. */
export async function retry(server: Server, modal: HTMLElement): Promise<void> {
  const before = writes(server).length;
  await click(button(modal, NAME.retry));
  await step();
  expect(writes(server)).toHaveLength(before);
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(before + 1));
  await settled(server);
}

/**
 * After a settled refusal: the open dialog when it still offers 【确认执行】, else the dialog
 * opened again through 【批量自动打款】 (the ticks are kept after a refusal).
 */
export async function submitAgainFrom(server: Server): Promise<HTMLElement> {
  const own = (): HTMLElement[] => dialogs().filter((node) => !stepDialogs().includes(node));
  const open = own();
  if (open.length === 1 && buttons(open[0]!, NAME.submit).length === 1) return open[0]!;
  if (open.length === 1 && buttons(open[0]!, NAME.close).length === 1)
    await click(button(open[0]!, NAME.close));
  await waitFor(() => expect(own()).toEqual([]));
  return openBatch(server);
}
