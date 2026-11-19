import { formatFen, formatYuanAdmin, parseFen } from '@couli/money';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { overview } from '../admin-payouts-readonly/fixtures.ts';
import {
  BASE_URL,
  EXECUTOR,
  LIST,
  REVIEWER,
  TRACE_ID,
  createServer,
  detailPath,
  detailRoute,
  ok,
  samples,
  type RequestLog,
  type Withdrawal,
} from '../admin-withdrawals/fixtures.ts';

// F1-08am: the 【执行打款】 and 【手动成功】 of one withdrawal's detail page. One withdrawal is a
// batch of one (contracts/openapi.yaml): adminCreatePayoutBatch POST /admin/v1/payout-batches
// (payout.execute, body {withdrawal_ids: [id]}) and adminBatchManualPaid POST
// /admin/v1/withdrawals/batch-manual-paid (payout.manual_entry, body {items: [one item]}); both
// totp-tier step-up (BR-ID-34) and Idempotency-Key required. Writes follow the F1-08ce
// result-unknown handling (D10-1731 / D10-1739 / D10-2060 / D10-2061).
//
// The shell does not forward a clock to the detail page yet: only that dependency is injected
// (as the frozen F1-08al helper does for the list); the ORIGINAL page is always rendered with its
// real permissions, UI and network behaviour. Values are not re-exported from other fixtures
// (a re-exported binding is not callable under the hoisted vi.mock).
const injected = vi.hoisted(() => ({ clock: undefined as { now(): number } | undefined }));
vi.mock(
  '../../../../apps/admin/src/pages/withdrawals/WithdrawalDetailPage.tsx',
  async (original) => {
    const actual =
      await original<
        typeof import('../../../../apps/admin/src/pages/withdrawals/WithdrawalDetailPage.tsx')
      >();
    return {
      ...actual,
      WithdrawalDetailPage: (props: Parameters<typeof actual.WithdrawalDetailPage>[0]) => {
        const supplied = {
          ...props,
          ...(injected.clock === undefined ? {} : { clock: injected.clock }),
        };
        return createElement(actual.WithdrawalDetailPage, supplied);
      },
    };
  },
);

configure({ asyncUtilTimeout: 10_000 });
export type { RequestLog, Withdrawal };

export type BatchResult = Schema<'AdminPayoutBatchResult'>;
export type LeftReason = Schema<'AdminPayoutBatchLeftItem'>['reason'];
export type ManualPayload = Schema<'AdminWithdrawalBatchManualPaidRequest'>;
export type ManualItem = Schema<'AdminWithdrawalBatchManualPaidItem'>;
export type SkipReason = NonNullable<ManualItem['reason']>;
type AttemptResult = Withdrawal['payout_attempts'][number]['result'];

/** The APPROVED alipay withdrawal of these tests (no transfer attempt, on no batch). */
export const WID = 'e1000010-0000-4000-8000-000000000010';
export const NUMBER = 'W20261117000110';
export const NET_FEN = 9800;
/** The amount due as the console shows it (only through @couli/money). */
export const NET_SHOWN = formatYuanAdmin(parseFen(NET_FEN));
/** The amount due as a person types it in yuan (only through @couli/money). */
export const NET_TYPED = formatFen(parseFen(NET_FEN));

export const DETAIL = detailPath(WID);
export const BATCHES = '/admin/v1/payout-batches';
export const MANUAL = '/admin/v1/withdrawals/batch-manual-paid';
export const VERIFY = '/admin/v1/auth/step-up';
export const OVERVIEW = '/admin/v1/payout-overview';
export const OTP = '123456';
export const NEW_BATCH = 'b2000010-0000-4000-8000-000000000010';

/** The injected clock's now, a paid time before it and one second after it. */
export const NOW = '2026-11-18T04:00:00.000Z';
export const WHEN = '2026-11-18T03:30:00.000Z';
export const LATER = '2026-11-18T04:00:01.000Z';
export const SERIAL = 'Serial-0110-Aa';

/** Entry and dialog buttons (exact accessible names). */
export const NAME = {
  execute: '执行打款',
  manual: '手动成功',
  executeSubmit: '确认执行',
  manualSubmit: '确认录入',
  cancel: '取消',
  close: '关闭',
  retry: '重试',
  verify: '验证并继续',
} as const;
/** Labels of the three entry fields (F1-08al dialog, exact accessible names). */
export const FIELD = {
  serial: '通道流水号',
  paidAt: '实付时间',
  amount: '实付金额（元）',
} as const;

/**
 * Independent full-copy expectations (frozen wording of F1-08al / F1-08bb / F1-08as), not imports
 * of the implementation's texts.
 */
export const TEXT = {
  unknown: '上次提交结果未知',
  checkTitle: '执行前检查',
  paying: '已发起打款',
  left: {
    member_blocked: '会员有提现阻断，本次未执行',
    channel_disabled: '该单的打款通道未开通或已暂停，本次未执行',
    has_transfer_attempt: '已有转账记录，只能手动成功或驳回，本次未执行',
  } as Readonly<Partial<Record<LeftReason, string>>>,
  refusedBelow: '整批未执行：企业支付宝余额 W 低于预计提现 P',
  refusedPayoutOff: '整批未执行：打款开关已关闭',
  again: '动态码凭证已失效，请重新输入动态码',
  executeForbidden: '无权限执行此操作（需要 payout.execute 权限点）',
  manualForbidden: '无权限执行此操作（需要 payout.manual_entry 权限点）',
  paid: '已录入',
  skipped: {
    member_blocked: '会员存在提现阻断，本次未录入',
    has_transfer_attempt: '存在处理中、成功或结果未知的转账尝试，请先核对打款结果，本次未录入',
    channel_order_id_taken: '通道流水号已被其他提现单使用，本次未录入',
  } as Readonly<Partial<Record<SkipReason, string>>>,
  amountMismatch: '实付金额必须等于应付金额',
  future: '实付时间不能晚于当前时间',
} as const;

/** Statuses as the page's dictionary names them (admin_dict.withdrawal_status.*). */
export const STATUS_SHOWN = {
  APPROVED: '已通过待打款',
  PAYING: '打款中',
  PAID_MANUAL: '线下打款成功',
} as const;

const DISPLAY: Readonly<Record<Withdrawal['status'], Withdrawal['display_status']>> = {
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'pending_review',
  REJECTED: 'rejected',
  PAYING: 'paying',
  PAID_API: 'paid_auto_review',
  PAID_MANUAL: 'paid_manual',
  FAILED: 'failed',
};

// ---- permission snapshots -------------------------------------------------------------------

/** fund.view to read plus payout.execute (totp). */
export const EXECUTE: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view', 'payout.execute'],
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'payout.execute': { tier: 'totp', operations: {} },
  },
};
/** fund.view to read plus payout.manual_entry (totp). */
export const MANUAL_ENTRY: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view', 'payout.manual_entry'],
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'payout.manual_entry': { tier: 'totp', operations: {} },
  },
};
export const VIEWER: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view'],
  stepUp: { 'fund.view': { tier: null, operations: {} } },
};
export const REVIEWER_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: ['withdraw.review', 'fund.view'],
  stepUp: {
    'withdraw.review': { tier: 'totp', operations: {} },
    'fund.view': { tier: null, operations: {} },
  },
};
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

// ---- data -----------------------------------------------------------------------------------

/** The APPROVED alipay sample with `changes` applied. */
export function approved(changes: Partial<Withdrawal> = {}): Withdrawal {
  return {
    ...samples()[0]!,
    withdrawal_id: WID,
    out_biz_no: NUMBER,
    status: 'APPROVED',
    display_status: 'pending_review',
    review_mode: 'manual',
    payout_channel: 'alipay',
    payout_method: 'alipay',
    amount_fen: 10000,
    fee_fen: 200,
    tax_fen: 0,
    net_fen: NET_FEN,
    blocked_reason: null,
    hold_reason: null,
    hold_at: null,
    needs_manual: false,
    reviewer_id: REVIEWER,
    reviewed_at: '2026-11-17T09:30:00+08:00',
    review_deadline: '2026-11-18T09:00:00+08:00',
    executor_id: null,
    executed_at: null,
    execute_seq: 0,
    risk_flags: [],
    created_at: '2026-11-17T09:00:00+08:00',
    updated_at: '2026-11-17T09:30:00+08:00',
    row_version: 2,
    batch_id: null,
    batch: null,
    batch_items: [],
    payout_attempts: [],
    holds: [],
    ...changes,
  };
}

/** The sample in another status (display status to match). */
export function inStatus(status: Withdrawal['status']): Withdrawal {
  return approved({ status, display_status: DISPLAY[status] });
}

/** One kind=transfer attempt with `result`. */
export function transfer(result: AttemptResult): Withdrawal['payout_attempts'][number] {
  return {
    attempt_id: 'a2000010-0000-4000-8000-000000000001',
    kind: 'transfer',
    result,
    resp_code: result === 'fail' ? 'PAYER_BALANCE_NOT_ENOUGH' : null,
    resp_sub_code: null,
    at: '2026-11-17T10:00:05+08:00',
  };
}

// ---- fake server ----------------------------------------------------------------------------

/** The fake withdrawal server with 16 verifications, the overview and the raw write bodies. */
export function serverFor(item: Withdrawal = approved()) {
  const server = createServer([item], { permissions: ['fund.view'] });
  const raw: { path: string; body: string }[] = [];
  for (let pass = 1; pass <= 16; pass += 1) {
    const reply = { ['step_up_token']: `detail-pass-${pass}`, tier: 'totp', expire_at: FAR };
    server.once('POST', VERIFY, () => ok(reply));
    server.once('GET', OVERVIEW, () => ok(overview()));
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === BATCHES || url.pathname === MANUAL) {
      const body =
        init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      expect(typeof body, 'actual HTTP body').toBe('string');
      raw.push({ path: url.pathname, body: body as string });
    }
    return server.fetch(input, init);
  };
  return {
    ...server,
    fetch,
    raw,
    get pending() {
      return server.pending;
    },
  };
}
export type Server = ReturnType<typeof serverFor>;

const FAR = '2099-01-01T00:00:00Z';

const HTTP: Readonly<Record<number, number>> = {
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
/** An answer that cannot be read (no unified envelope). */
export function garbled(): Response {
  return new Response('<html><body>bad gateway</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}
/** A 5xx in the unified envelope. */
export function serverError(): Response {
  return failure(50001, null);
}
export const STEP_AGAIN = (): Response => failure(10003, { tier: 'totp' });
export const PHONE_MISSING = (): Response =>
  failure(10003, { tier: 'sms', reason: 'verify_phone_missing' });
export const FORBIDDEN = (): Response => failure(10403, { reason: 'admin_permission_denied' });

/** The withdrawal moves APPROVED → PAYING on the server (W4) and the batch answers executed. */
export function executeOnServer(server: Server): void {
  const item = server.state[0]!;
  item.status = 'PAYING';
  item.display_status = 'paying';
  item.executor_id = EXECUTOR;
  item.executed_at = '2026-11-18T11:40:00+08:00';
  item.execute_seq += 1;
  item.batch_id = NEW_BATCH;
  item.batch = { batch_id: NEW_BATCH, kind: 'manual', created_at: '2026-11-18T11:40:00+08:00' };
  item.batch_items = [
    {
      batch_id: NEW_BATCH,
      result: 'paying',
      reason: null,
      moved_to_batch_id: null,
      at: '2026-11-18T11:40:00+08:00',
    },
  ];
  item.updated_at = '2026-11-18T11:40:00+08:00';
  item.row_version += 1;
}
export function executedPaying(): BatchResult {
  return {
    outcome: 'executed',
    batch_id: NEW_BATCH,
    reason: null,
    channel: null,
    paying: [WID],
    left: [],
  };
}
export function executedLeft(reason: LeftReason): BatchResult {
  return {
    outcome: 'executed',
    batch_id: NEW_BATCH,
    reason: null,
    channel: null,
    paying: [],
    left: [{ withdrawal_id: WID, reason }],
  };
}
export function refusedBatch(reason: NonNullable<BatchResult['reason']>): BatchResult {
  return {
    outcome: 'rejected',
    batch_id: null,
    reason,
    channel: reason.startsWith('watermark_') ? 'alipay' : null,
    paying: [],
    left: [],
  };
}
/** Reply of an executed batch that moved the withdrawal (state changed first). */
export function payingReply(server: Server): Response {
  executeOnServer(server);
  return ok(executedPaying());
}

/** The withdrawal moves APPROVED → PAID_MANUAL on the server (W8) with the sent serial. */
export function payOnServer(server: Server, request?: RequestLog): void {
  const body = request?.body as ManualPayload | undefined;
  const item = server.state[0]!;
  item.status = 'PAID_MANUAL';
  item.display_status = 'paid_manual';
  item.channel_order_id = body?.items[0]?.channel_order_id ?? SERIAL;
  item.paid_at = body?.items[0]?.paid_at ?? WHEN;
  item.manual_entry_by = EXECUTOR;
  item.manual_confirm_by = EXECUTOR;
  item.updated_at = '2026-11-18T12:00:00+08:00';
  item.row_version += 1;
}
export function paidReply(server: Server, request?: RequestLog): Response {
  payOnServer(server, request);
  const data: Schema<'AdminWithdrawalBatchManualPaid'> = {
    items: [{ withdrawal_id: WID, result: 'paid', reason: null }],
  };
  return ok(data);
}
export function skippedReply(reason: SkipReason): Response {
  const data: Schema<'AdminWithdrawalBatchManualPaid'> = {
    items: [{ withdrawal_id: WID, result: 'skipped', reason }],
  };
  return ok(data);
}

/** The body the page must send for SERIAL, WHEN and the amount due. */
export const MANUAL_BODY: ManualPayload = {
  items: [{ withdrawal_id: WID, channel_order_id: SERIAL, paid_at: WHEN, paid_fen: NET_FEN }],
};
export const EXECUTE_BODY = { withdrawal_ids: [WID] } as const;

// ---- mounting -------------------------------------------------------------------------------

const mounted: { server: Server; direct: ReturnType<typeof vi.fn<typeof globalThis.fetch>> }[] = [];
const READS: readonly string[] = [
  DETAIL,
  LIST,
  OVERVIEW,
  '/admin/v1/dict',
  '/admin/v1/me/permissions',
];
const POSTS: readonly string[] = [VERIFY, BATCHES, MANUAL];

/** The only requests allowed: the detail and common reads, verification and the two writes. */
function allowed(request: RequestLog): boolean {
  if (request.method === 'GET') return READS.includes(request.path);
  return request.method === 'POST' && POSTS.includes(request.path);
}

afterEach(() => {
  const current = mounted.splice(0);
  try {
    for (const { server, direct } of current) {
      expect(direct).not.toHaveBeenCalled();
      const stray = server.log
        .filter((request) => !allowed(request))
        .map((request) => `${request.method} ${request.path}`);
      expect(stray, 'no other write, reveal, cancellation or recalculation').toEqual([]);
    }
  } finally {
    cleanup();
    injected.clock = undefined;
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

export async function mount(
  server: Server,
  permissions: PermissionSnapshot = EXECUTE,
  clock: { now(): number } = { now: () => Date.parse(NOW) },
): Promise<void> {
  injected.clock = clock;
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
  const direct = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', direct);
  mounted.push({ server, direct });
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: detailRoute(WID) },
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
  await waitFor(() => expect(server.detailReads(WID).length).toBeGreaterThan(0));
  await waitFor(() => expect(main().textContent).toContain(NUMBER));
  await settled(server);
}

// ---- DOM ------------------------------------------------------------------------------------

export function main(): HTMLElement {
  const area = document.querySelector<HTMLElement>('main');
  expect(area, 'real shell main').not.toBeNull();
  return area!;
}

export function compact(value: string | null): string {
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

export function shows(root: HTMLElement, text: string): boolean {
  return compact(root.textContent).includes(compact(text));
}

export async function notice(text: string, root: HTMLElement = document.body): Promise<void> {
  await waitFor(() => expect(shows(root, text), text).toBe(true));
}

/** Both entries are on the page, usable, or neither (hidden, not greyed out). */
export function entries(): { execute: boolean; manual: boolean } {
  const usable = (name: string) => {
    const found = buttons(main(), name);
    expect(found.length, `at most one ${name}`).toBeLessThanOrEqual(1);
    if (found.length === 1) expect(disabled(found[0]!), `${name} usable when shown`).toBe(false);
    return found.length === 1;
  };
  return { execute: usable(NAME.execute), manual: usable(NAME.manual) };
}

/** Out of scope here: wechat cancellation (hidden, D10-2017), recalculation, upload. */
export function assertNoOtherActions(): void {
  for (const name of ['撤销微信转账', '重新计算', '上传', '上传凭证', '重新打款'])
    expect(buttons(document.body, name), `out-of-scope action: ${name}`).toEqual([]);
  expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
}

// ---- step-up --------------------------------------------------------------------------------

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

// ---- writes ---------------------------------------------------------------------------------

export function executes(server: Server): RequestLog[] {
  return server.requests('POST', BATCHES);
}
export function manuals(server: Server): RequestLog[] {
  return server.requests('POST', MANUAL);
}
export function writes(server: Server): RequestLog[] {
  return server.log.filter(
    (request) => request.method === 'POST' && [BATCHES, MANUAL].includes(request.path),
  );
}
export function keyOf(request: RequestLog): string | null {
  return request.headers.get('Idempotency-Key');
}

/** The step-up pass handed out by the last verification before `request`. */
function passBefore(server: Server, request: RequestLog): number {
  const at = server.log.indexOf(request);
  return server.log.filter(
    (read, index) => index < at && read.method === 'POST' && read.path === VERIFY,
  ).length;
}

/** The common shape of a write: path, no query, the three headers, verified just before. */
function assertHeaders(server: Server, request: RequestLog, path: string): void {
  expect(request.method).toBe('POST');
  expect(request.path).toBe(path);
  expect(request.query).toEqual({});
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  const pass = passBefore(server, request);
  expect(pass, 'verified before the write').toBeGreaterThan(0);
  expect(request.headers.get('X-Step-Up-Token')).toBe(`detail-pass-${pass}`);
  expect(keyOf(request)).toEqual(expect.stringMatching(/^\S+$/));
  const verifications = server.requests('POST', VERIFY).map((read) => read.body);
  expect(verifications).toEqual(verifications.map(() => ({ tier: 'totp', code: OTP })));
}

/** The `index`-th execute request (0-based) is exactly the batch of this one withdrawal. */
export function assertExecute(server: Server, index: number): void {
  const request = executes(server)[index];
  expect(request, `execute request ${index + 1}`).toBeDefined();
  assertHeaders(server, request!, BATCHES);
  expect(request!.body).toEqual(EXECUTE_BODY);
}

/** The `index`-th manual request (0-based) is `body` (paid_at compared as an instant). */
export function assertManual(
  server: Server,
  index: number,
  body: ManualPayload = MANUAL_BODY,
): void {
  const request = manuals(server)[index];
  expect(request, `manual paid request ${index + 1}`).toBeDefined();
  assertHeaders(server, request!, MANUAL);
  const sent = request!.body as ManualPayload;
  expect(Object.keys(sent)).toEqual(['items']);
  expect(sent.items).toHaveLength(body.items.length);
  sent.items.forEach((item, at) => {
    const expected = body.items[at]!;
    // Everything but paid_at exactly; paid_at any ISO 8601 form (Z or an offset) of the instant.
    expect({ ...item, paid_at: 'instant' }).toEqual({ ...expected, paid_at: 'instant' });
    expect(item.paid_at).toEqual(expect.stringMatching(ISO_INSTANT));
    expect(Date.parse(item.paid_at)).toBe(Date.parse(expected.paid_at));
  });
}
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Every write to `path` so far is the first one again: one key, the same bytes. */
export function assertSameWrites(server: Server, path: string, count: number): void {
  const sent = server.requests('POST', path);
  expect(sent).toHaveLength(count);
  expect(sent.map(keyOf)).toEqual(sent.map(() => keyOf(sent[0]!)));
  const bodies = server.raw.filter((entry) => entry.path === path).map((entry) => entry.body);
  expect(bodies).toEqual(bodies.map(() => bodies[0]));
  expect(bodies).toHaveLength(count);
}

// ---- dialogs of this page -------------------------------------------------------------------

/** The page's own dialog (not the step-up). */
export function payDialog(): HTMLElement {
  const own = dialogs().filter((node) => !stepDialogs().includes(node));
  expect(own, 'one dialog of the page').toHaveLength(1);
  return own[0]!;
}

/** Wait until a dialog of the page (not the step-up) shows `text`. */
export async function inDialog(text: string): Promise<void> {
  await waitFor(() =>
    expect(
      dialogs()
        .filter((node) => !stepDialogs().includes(node))
        .some((node) => shows(node, text)),
      text,
    ).toBe(true),
  );
}

/**
 * After a settled refusal: the open dialog when it still offers `submitName`, else the dialog
 * opened again through the page's `entryName`.
 */
export async function submitAgainFrom(
  server: Server,
  submitName: string,
  entryName: string,
): Promise<HTMLElement> {
  const own = dialogs().filter((node) => !stepDialogs().includes(node));
  if (own.length === 1 && buttons(own[0]!, submitName).length === 1) return own[0]!;
  await click(button(main(), entryName));
  await waitFor(() => expect(dialogs(), 'one dialog again').toHaveLength(1));
  await settled(server);
  return dialogs()[0]!;
}

/** Press 【执行打款】: the confirmation (no step-up, nothing sent yet). */
export async function openExecute(server: Server): Promise<HTMLElement> {
  const before = writes(server).length;
  await click(button(main(), NAME.execute));
  await waitFor(() => expect(dialogs(), 'one confirmation dialog').toHaveLength(1));
  await settled(server);
  expect(stepDialogs()).toEqual([]);
  expect(writes(server)).toHaveLength(before);
  return dialogs()[0]!;
}

/** Press 【手动成功】: the entry dialog (no step-up, nothing sent yet). */
export async function openManual(server: Server): Promise<HTMLElement> {
  const before = writes(server).length;
  await click(button(main(), NAME.manual));
  await waitFor(() => expect(dialogs(), 'one entry dialog').toHaveLength(1));
  await settled(server);
  expect(stepDialogs()).toEqual([]);
  expect(writes(server)).toHaveLength(before);
  return dialogs()[0]!;
}

/** Press the dialog's submit: the totp step-up follows, nothing is sent before it. */
export async function submit(server: Server, modal: HTMLElement, name: string, twice = false) {
  const before = writes(server).length;
  const node = button(modal, name);
  expect(disabled(node), `${name} usable`).toBe(false);
  await click(node, twice);
  await step();
  expect(writes(server)).toHaveLength(before);
}

export function field(root: HTMLElement, label: string): HTMLInputElement {
  const found = within(root).queryAllByLabelText(label, { exact: true });
  expect(found, `one input: ${label}`).toHaveLength(1);
  expect(found[0]).toBeInstanceOf(HTMLInputElement);
  return found[0] as HTMLInputElement;
}

/** What to type into the paid time input for the instant `iso` (a datetime-local takes local). */
export function timeTyped(node: HTMLInputElement, iso: string): string {
  if (node.type !== 'datetime-local') return iso;
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Fill the three fields with SERIAL (with surrounding blanks), `at` and `amount`. */
export async function fillEntry(
  modal: HTMLElement,
  at: string = WHEN,
  amount: string = NET_TYPED,
): Promise<string[]> {
  const serial = `  ${SERIAL}  `;
  await fill(field(modal, FIELD.serial), serial);
  const time = field(modal, FIELD.paidAt);
  const typed = timeTyped(time, at);
  await fill(time, typed);
  await fill(field(modal, FIELD.amount), amount);
  await settle();
  return [serial, typed, amount];
}

export function values(modal: HTMLElement): string[] {
  return [FIELD.serial, FIELD.paidAt, FIELD.amount].map((label) => field(modal, label).value);
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
 * The result-unknown state: the notice, only 【重试】 and a 「…核对」 action usable, Escape and the
 * mask do not close the dialog, no step-up open, nothing sent again by itself, every input locked.
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
  expect(usable.filter((name) => name !== NAME.retry)).toEqual([expect.stringMatching(/核对/)]);
  for (const input of Array.from(modal.querySelectorAll('input')))
    expect(disabled(input), 'inputs locked').toBe(true);
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

/** Wait for a detail read after `before` reads and for the page to settle on it. */
export async function refreshed(server: Server, before: number): Promise<void> {
  await waitFor(() => expect(server.detailReads(WID).length).toBeGreaterThan(before));
  await settled(server);
}

/** The status tag text shown on the page (outside dialogs). */
export function statusShown(text: string): boolean {
  return within(main()).queryAllByText(text, { exact: true }).length > 0;
}
