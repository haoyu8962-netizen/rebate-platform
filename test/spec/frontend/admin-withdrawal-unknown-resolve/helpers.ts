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
import {
  BASE_URL,
  EXECUTOR,
  REVIEWER,
  TRACE_ID,
  createServer,
  detailPath,
  detailRoute,
  ok,
  samples,
  type RequestLog,
  type Server,
  type Withdrawal,
} from '../admin-withdrawals/fixtures.ts';

// Only the frozen data / server fixtures are reused: the older mount helpers install afterEach
// guards that forbid these newly contracted writes. Contract: adminQueryPayoutResult
// (POST /admin/v1/withdrawals/{id}/query, no body fields) and adminResolveUnknownPayout
// (POST /admin/v1/withdrawals/{id}/resolve, AdminUnknownPayoutResolveRequest); both
// payout.execute, totp step-up, Idempotency-Key required.
configure({ asyncUtilTimeout: 10_000 });
export { ok };
export type { RequestLog, Server, Withdrawal };

/** The PAYING, needs_manual sample (transfer result unknown past T+24h). */
export const WID = 'e1000008-0000-4000-8000-000000000008';
export const NUMBER = 'W20261112000108';
export const DETAIL = detailPath(WID);
export const QUERY = `${DETAIL}/query`;
export const RESOLVE = `${DETAIL}/resolve`;
export const VERIFY = '/admin/v1/auth/step-up';
export const OTP = '123456';
export const NET_FEN = 9800;
/** The admin amount of net_fen, only through @couli/money. */
export const NET_SHOWN = formatYuanAdmin(parseFen(NET_FEN));

export type ResolveBody = Schema<'AdminUnknownPayoutResolveRequest'>;
export type Resolution = ResolveBody['resolution'];

/** fund.view to read the page plus payout.execute (totp) for the two writes. */
export const EXECUTE: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view', 'payout.execute'],
  stepUp: {
    'fund.view': { tier: null, operations: {} },
    'payout.execute': { tier: 'totp', operations: {} },
  },
};
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

/** Entry and dialog actions (exact accessible names). */
export const NAME = {
  query: '立即查询',
  resolve: '人工处置',
  submit: '确认处置',
  cancel: '取消',
  verify: '验证并继续',
} as const;
/** Labels of the disposal fields (exact accessible names). */
export const FIELD = {
  proof: '凭证',
  orderId: '通道流水号',
  paidAt: '实付时间',
} as const;

/**
 * Independent full-copy expectations, not imports of the implementation's texts. The 20001
 * reason sentences are BR-TEXT-14 表 B 20001.resolve_* (规划/08 12_TEXT, D10-628 / D10-703); the
 * generic ones follow the frozen review / batch-approve wording; the rest are fixed here.
 */
export const TEXT = {
  querySubmitted: '已提交查询，结果稍后记入转账记录；查询不改变提现单状态',
  resolved: '已确认处置：判为已到账，提现单已转为接口打款成功',
  changed: '提现单状态已变化（已被他人处理或状态更新），已刷新为最新状态，请核对后再操作',
  stepAgain: '动态码凭证已失效，请重新输入动态码',
  forbidden: '无权限执行此操作（需要 payout.execute 权限点）',
  missing: '提现单不存在或不属于本应用',
  invalid: '提交内容有误，请检查后重试',
  network: '网络错误，请检查网络后重试；未确认前不会重复提交',
  failed: '提交失败，请稍后重试',
  resolutionEmpty: '请选择处置结论',
  proofEmpty: '请填写凭证（去掉首尾空白后不能为空）',
  proofTooLong: (count: number): string => `凭证最多 4000 字，当前 ${count} 字，请删减后再提交`,
  orderIdInvalid: '通道流水号为 1–64 个字符，不能含空白',
  paidAtInvalid: '实付时间写成 YYYY-MM-DD HH:mm:ss（北京时间）',
  proofField: '凭证不符合要求，请修改后重试',
  orderIdField: '通道流水号不符合要求，请修改后重试',
  paidAtField: '实付时间不符合要求，请修改后重试',
  reason: {
    resolve_query_failed:
      '最近一次查询显示转账失败，对账也没有成功记录，不能判为已到账。请重新查询或等账单核对后再处理。',
    resolve_too_early: '距首次转账还不满 24 小时，不能判为失败。',
    resolve_bill_unverifiable: '还不能确认转账当日与次日的账单都没有这笔单，不能判为失败。',
    resolve_query_unverifiable: '最近一次查询还不能确认「订单不存在」，不能判为失败。',
    resolve_paid_at_invalid: '到账时间不对：不能晚于现在，也不能早于首次转账时间。',
    resolve_order_id_taken: '这个通道单号已用在另一笔提现上，请核对后再提交。',
    resolve_identity_missing: '该会员没有已核验的实名，暂不能判为已到账，请转技术处理。',
    resolve_order_id_other_order:
      '这个通道单号在对账里属于另一笔提现，不能用来判这笔为已到账。请核对凭证后再提交。',
    resolve_order_id_mismatch: '填写的通道单号与这笔提现已有的成功记录不一致，请核对后再提交。',
    resolve_amount_mismatch: '账单里这笔的金额与实发金额不一致，不能判为已到账，请转技术处理。',
  },
} as const;

/** Sample inputs: the pasted query answer, the serial number and the paid time (Beijing). */
export const PROOF =
  '查询返回：{"code":"10000","order_id":"20261113220014001","status":"SUCCESS","pay_date":"2026-11-13 10:05:00"}';
export const FAILED_PROOF = '查询返回订单不存在；当日与次日账单都没有本单号';
export const ORDER_ID = '20261113220014001';
export const PAID_AT_TYPED = '2026-11-13 10:05:00';
/** What the page sends for PAID_AT_TYPED (ISO 8601 with +08:00). */
export const PAID_AT_SENT = '2026-11-13T10:05:00+08:00';

/** Statuses as the page's dictionary names them (admin_dict.withdrawal_status.*). */
export const STATUS_SHOWN = {
  PAYING: '打款中',
  PAID_API: '接口打款成功',
  PAID_MANUAL: '线下打款成功',
  FAILED: '打款失败',
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

/** A PAYING alipay withdrawal whose transfer stayed unknown; needs_manual by default. */
export function unknownPayout(
  status: Withdrawal['status'] = 'PAYING',
  needsManual = true,
): Withdrawal {
  return {
    ...samples()[0]!,
    withdrawal_id: WID,
    out_biz_no: NUMBER,
    status,
    display_status: DISPLAY[status],
    review_mode: 'manual',
    payout_channel: 'alipay',
    payout_method: 'alipay',
    amount_fen: 10000,
    fee_fen: 200,
    tax_fen: 0,
    net_fen: NET_FEN,
    blocked_reason: null,
    needs_manual: needsManual,
    reviewer_id: REVIEWER,
    reviewed_at: '2026-11-12T09:30:00+08:00',
    review_deadline: '2026-11-13T09:00:00+08:00',
    executor_id: EXECUTOR,
    executed_at: '2026-11-12T10:00:00+08:00',
    execute_seq: 1,
    created_at: '2026-11-12T09:00:00+08:00',
    updated_at: '2026-11-13T10:00:05+08:00',
    row_version: 6,
    payout_attempts: [
      {
        attempt_id: 'a2000008-0000-4000-8000-000000000001',
        kind: 'transfer',
        result: 'unknown',
        resp_code: null,
        resp_sub_code: null,
        at: '2026-11-12T10:00:05+08:00',
      },
      {
        attempt_id: 'a2000008-0000-4000-8000-000000000002',
        kind: 'query',
        result: 'unknown',
        resp_code: 'SYSTEM_ERROR',
        resp_sub_code: null,
        at: '2026-11-13T10:00:05+08:00',
      },
    ],
  };
}

const FAR = '2099-01-01T00:00:00Z';

export function serverFor(item: Withdrawal = unknownPayout()): Server {
  const server = createServer([item]);
  for (let pass = 1; pass <= 16; pass += 1) {
    const reply = { ['step_up_token']: `unknown-pass-${pass}`, tier: 'totp', expire_at: FAR };
    server.once('POST', VERIFY, () => ok(reply));
  }
  return server;
}

// HTTP statuses as in contracts/error-codes.yaml.
const HTTP: Readonly<Record<number, number>> = {
  10003: 403,
  10403: 403,
  20901: 409,
  20902: 409,
  40901: 409,
};

export function failure(code: number, data: unknown): Response {
  const status = HTTP[code] ?? 400;
  return Response.json({ code, msg: '', data, trace_id: TRACE_ID }, { status });
}

/** A 20001 refusal of adminResolveUnknownPayout (data.fields, and data.reason when given). */
export function refusal(fields: readonly string[], reason?: string): Response {
  return failure(20001, reason === undefined ? { fields } : { fields, reason });
}

/** The query job queued (the status never moves, BR-WDR-14). */
export function querySubmitted(): Response {
  const data: Schema<'AdminPayoutQuerySubmitted'> = { withdrawal_id: WID, result: 'submitted' };
  return ok(data);
}

/** W10 to PAID_API with the given serial number and paid time. */
export function resolvedPaid(server: Server, request: RequestLog): Response {
  const body = request.body as ResolveBody;
  const item = server.state[0]!;
  item.status = 'PAID_API';
  item.display_status = 'paid_auto_review';
  item.manual_resolution = 'paid';
  item.resolver_ids = [EXECUTOR];
  item.channel_order_id = body.channel_order_id ?? null;
  item.paid_at = body.paid_at ?? null;
  item.updated_at = '2026-11-14T10:00:00+08:00';
  item.row_version += 1;
  const data: Schema<'AdminUnknownPayoutResolved'> = {
    withdrawal_id: WID,
    status: 'PAID_API',
    manual_resolution: 'paid',
    channel_order_id: body.channel_order_id ?? '',
    paid_at: body.paid_at ?? '',
  };
  return ok(data);
}

/** Another request ended the withdrawal meanwhile (the answer of 20902 cases). */
export function endedElsewhere(server: Server): void {
  const item = server.state[0]!;
  item.status = 'PAID_API';
  item.display_status = 'paid_auto_review';
  item.manual_resolution = 'paid';
  item.channel_order_id = ORDER_ID;
  item.paid_at = PAID_AT_SENT;
  item.row_version += 1;
}

const mounted: { server: Server; direct: ReturnType<typeof vi.fn<typeof globalThis.fetch>> }[] = [];
const READS: readonly string[] = [DETAIL, '/admin/v1/dict', '/admin/v1/me/permissions'];
const POSTS: readonly string[] = [VERIFY, QUERY, RESOLVE];

/** The only requests allowed: detail and common reads, verification, query, resolve. */
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
      expect(stray, 'no transfer, payout, manual paid, cancellation or upload').toEqual([]);
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

export async function mount(
  server: Server,
  permissions: PermissionSnapshot = EXECUTE,
): Promise<void> {
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

export function main(): HTMLElement {
  const area = document.querySelector<HTMLElement>('main');
  expect(area, 'real shell main').not.toBeNull();
  return area!;
}

export function compact(value: string | null): string {
  return (value ?? '').replace(/\s+/g, '');
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

/** Both entries are shown and usable on the detail. */
export function assertEntries(): void {
  expect(disabled(button(main(), NAME.query))).toBe(false);
  expect(disabled(button(main(), NAME.resolve))).toBe(false);
}

/** Neither entry is on the page (hidden, not greyed out). */
export function assertNoEntries(label: string): void {
  expect(buttons(main(), NAME.query), `${label}: no 【立即查询】`).toEqual([]);
  expect(buttons(main(), NAME.resolve), `${label}: no 【人工处置】`).toEqual([]);
}

const OUT_OF_SCOPE = [
  '执行打款',
  '手动成功',
  '撤销微信转账',
  '重新计算',
  '上传',
  '上传凭证',
  '上传文件',
  '重新打款',
];

/** Out of scope: no payout, manual paid, wechat cancellation, recalculation or upload. */
export function assertNoOtherActions(): void {
  for (const name of OUT_OF_SCOPE)
    expect(buttons(document.body, name), `out-of-scope action: ${name}`).toEqual([]);
  expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
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
  expect(fields).toHaveLength(1);
  await fill(fields[0]!, OTP);
  await click(button(verification, NAME.verify), twice);
}

export function queries(server: Server): RequestLog[] {
  return server.requests('POST', QUERY);
}
export function resolves(server: Server): RequestLog[] {
  return server.requests('POST', RESOLVE);
}
export function writes(server: Server): RequestLog[] {
  return server.log.filter(
    (request) => request.method === 'POST' && [QUERY, RESOLVE].includes(request.path),
  );
}

/** Press 【立即查询】: the totp StepUpModal follows at once and nothing is sent before it. */
export async function startQuery(server: Server, twice = false): Promise<HTMLElement> {
  const before = writes(server).length;
  const entry = button(main(), NAME.query);
  expect(disabled(entry)).toBe(false);
  entry.focus();
  await click(entry, twice);
  await step();
  expect(dialogs(), 'only the step-up dialog').toEqual(stepDialogs());
  expect(writes(server)).toHaveLength(before);
  return entry;
}

/** Press 【人工处置】 and return the disposal dialog (no step-up yet). */
export async function openResolve(): Promise<HTMLElement> {
  const entry = button(main(), NAME.resolve);
  expect(disabled(entry)).toBe(false);
  entry.focus();
  await click(entry);
  await waitFor(() => expect(dialogs(), 'one disposal dialog').toHaveLength(1));
  expect(stepDialogs()).toEqual([]);
  return dialogs()[0]!;
}

export function radio(dialog: HTMLElement, resolution: Resolution): HTMLInputElement {
  const found = within(dialog)
    .queryAllByRole('radio')
    .filter((node) => node instanceof HTMLInputElement && node.value === resolution);
  expect(found, `one radio ${resolution}`).toHaveLength(1);
  return found[0] as HTMLInputElement;
}

export async function choose(dialog: HTMLElement, resolution: Resolution): Promise<void> {
  await click(radio(dialog, resolution));
  expect(radio(dialog, resolution).checked).toBe(true);
}

export function field(dialog: HTMLElement, name: string): HTMLInputElement | HTMLTextAreaElement {
  const found = within(dialog).queryAllByRole('textbox', { name });
  expect(found, `one labelled field ${name}`).toHaveLength(1);
  const node = found[0]!;
  expect(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement).toBe(true);
  return node as HTMLInputElement | HTMLTextAreaElement;
}

/** Fill the fields of a `paid` disposal with the samples. */
export async function fillPaid(dialog: HTMLElement): Promise<void> {
  await choose(dialog, 'paid');
  await fill(field(dialog, FIELD.proof), PROOF);
  await fill(field(dialog, FIELD.orderId), ORDER_ID);
  await fill(field(dialog, FIELD.paidAt), PAID_AT_TYPED);
}

/** Fill the fields of a `failed` disposal with the samples. */
export async function fillFailed(dialog: HTMLElement): Promise<void> {
  await choose(dialog, 'failed');
  await fill(field(dialog, FIELD.proof), FAILED_PROOF);
}

export const PAID_BODY: ResolveBody = {
  resolution: 'paid',
  proof_text: PROOF,
  channel_order_id: ORDER_ID,
  paid_at: PAID_AT_SENT,
};
export const FAILED_BODY: ResolveBody = { resolution: 'failed', proof_text: FAILED_PROOF };

/** 【确认处置】 opens the totp StepUpModal; nothing is sent before verification. */
export async function confirm(server: Server, dialog: HTMLElement, twice = false): Promise<void> {
  const before = writes(server).length;
  await click(button(dialog, NAME.submit), twice);
  await step();
  expect(writes(server)).toHaveLength(before);
}

/** 【确认处置】 refused locally: no step-up, no request, the dialog stays. */
export async function refusedLocally(server: Server, dialog: HTMLElement): Promise<void> {
  const before = writes(server).length;
  const verifications = server.requests('POST', VERIFY).length;
  await click(button(dialog, NAME.submit));
  expect(stepDialogs()).toEqual([]);
  expect(writes(server)).toHaveLength(before);
  expect(server.requests('POST', VERIFY)).toHaveLength(verifications);
  expect(dialogs()).toContain(dialog);
}

/**
 * Submit the disposal again after a refusal; the page may reuse the still valid step-up or ask
 * for a new dynamic code. Waits for the `count`-th resolve request.
 */
export async function resubmit(server: Server, dialog: HTMLElement, count: number): Promise<void> {
  await click(button(dialog, NAME.submit));
  await waitFor(() =>
    expect(resolves(server).length === count || stepDialogs().length === 1).toBe(true),
  );
  if (stepDialogs().length === 1) await verify();
  await waitFor(() => expect(resolves(server)).toHaveLength(count));
  await settled(server);
}

/** The step-up pass the page was handed by the last verification before `request`. */
function passBefore(server: Server, request: RequestLog): number {
  const at = server.log.indexOf(request);
  const verifications = server.log.filter(
    (read, index) => index < at && read.method === 'POST' && read.path === VERIFY,
  );
  return verifications.length;
}

/** One write exactly as contracted: path, no query, the whole body and the three headers. */
export function assertWrite(
  server: Server,
  request: RequestLog,
  path: string,
  body: unknown,
): void {
  expect(request.method).toBe('POST');
  expect(request.path).toBe(path);
  expect(request.query).toEqual({});
  expect(request.body).toEqual(body);
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  const pass = passBefore(server, request);
  expect(pass, 'verified before the write').toBeGreaterThan(0);
  expect(request.headers.get('X-Step-Up-Token')).toBe(`unknown-pass-${pass}`);
  expect(request.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
  const verifications = server.requests('POST', VERIFY).map((read) => read.body);
  expect(verifications).toEqual(verifications.map(() => ({ tier: 'totp', code: OTP })));
}

/** The Idempotency-Key header of a write. */
export function idemOf(request: RequestLog): string | null {
  return request.headers.get('Idempotency-Key');
}

export async function notice(text: string): Promise<void> {
  await waitFor(() =>
    expect(within(document.body).queryAllByText(text, { exact: true }).length).toBeGreaterThan(0),
  );
}

export function absent(text: string): void {
  expect(within(document.body).queryAllByText(text, { exact: true }), text).toEqual([]);
}

export function shown(root: HTMLElement, text: string): number {
  return within(root).queryAllByText(text, { exact: true }).length;
}

/** Wait for a detail read after `before` reads and for the page to settle on it. */
export async function refreshed(server: Server, before: number): Promise<void> {
  await waitFor(() => expect(server.detailReads(WID).length).toBeGreaterThan(before));
  await settled(server);
}

/** The detail still shows the withdrawal as PAYING, nothing as paid or failed, no success. */
export function assertStillPaying(): void {
  expect(shown(main(), STATUS_SHOWN.PAYING)).toBeGreaterThan(0);
  expect(shown(main(), STATUS_SHOWN.PAID_API)).toBe(0);
  expect(shown(main(), STATUS_SHOWN.PAID_MANUAL)).toBe(0);
  expect(shown(main(), STATUS_SHOWN.FAILED)).toBe(0);
  for (const text of ['已成功', '已失败', TEXT.resolved])
    expect(outsideDialogs(text), `no notice: ${text}`).toEqual([]);
}

/** Elements showing exactly `text` on the page or in a notice, not inside a dialog's own copy. */
export function outsideDialogs(text: string): HTMLElement[] {
  return within(document.body)
    .queryAllByText(text, { exact: true })
    .filter((node) => node.closest('[role="dialog"]') === null);
}
