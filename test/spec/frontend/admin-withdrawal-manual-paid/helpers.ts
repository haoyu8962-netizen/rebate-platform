import { fenToJsonNumber, formatFen, parseFen, yuanStrToFen } from '@couli/money';
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
import {
  BASE_URL,
  LIST,
  TRACE_ID,
  createServer,
  ok,
  samples,
  type Withdrawal,
} from '../admin-withdrawals/fixtures.ts';

// The shell does not yet forward its clock to this page. Only inject that dependency;
// always render the ORIGINAL page, with its real permissions, UI and network behavior.
// This needs neither changes outside the task paths nor new test-package dependencies.
const injected = vi.hoisted(() => ({ clock: undefined as { now(): number } | undefined }));
vi.mock('../../../../apps/admin/src/pages/withdrawals/WithdrawalsPage.tsx', async (original) => {
  const actual =
    await original<
      typeof import('../../../../apps/admin/src/pages/withdrawals/WithdrawalsPage.tsx')
    >();
  return {
    ...actual,
    WithdrawalsPage: (props: Parameters<typeof actual.WithdrawalsPage>[0]) => {
      const supplied = {
        ...props,
        ...(injected.clock === undefined ? {} : { clock: injected.clock }),
      };
      return createElement(actual.WithdrawalsPage, supplied);
    },
  };
});

// The frozen batch-approve helper registers afterEach that forbids manual-paid writes.
configure({ asyncUtilTimeout: 10_000 });
export { LIST, ok, samples };
export type { Withdrawal };
export type Payload = Schema<'AdminWithdrawalBatchManualPaidRequest'>;
export type ResultItem = Schema<'AdminWithdrawalBatchManualPaidItem'>;
export const MANUAL = '/admin/v1/withdrawals/batch-manual-paid';
export const VERIFY = '/admin/v1/auth/step-up';
export const NOW = '2026-11-18T04:00:00.000Z';
export const WHEN = '2026-11-18T03:30:00.000Z';
export const GRANTS: PermissionSnapshot = {
  isSuper: false,
  permissions: ['fund.view', 'payout.manual_entry'],
  stepUp: { 'payout.manual_entry': { tier: 'totp', operations: {} } },
};
export const REASONS = {
  not_found: '未找到该提现单（不存在或不属于本应用），本次未录入',
  not_approved: '提现单不再是待执行状态，本次未录入',
  channel_not_allowed: '微信零钱单不支持线下打款，本次未录入',
  amount_mismatch: '实付金额与应付金额不一致，本次未录入',
  paid_at_invalid: '实付时间早于申请时间或超过服务端允许的未来时间，本次未录入',
  has_transfer_attempt: '存在处理中、成功或结果未知的转账尝试，请先核对打款结果，本次未录入',
  query_required: '需先查询并确认原转账未成功，本次未录入',
  query_success: '查询确认原转账已成功，请走已成功处理，本次未录入',
  member_blocked: '会员存在提现阻断，本次未录入',
  channel_order_id_taken: '通道流水号已被其他提现单使用，本次未录入',
  identity_missing: '会员缺少已验证的实名信息，需人工处理，本次未录入',
} as const;
export const INVALID = {
  serialRequired: '请输入通道流水号',
  serial: '通道流水号须为 1–64 个字符，不能包含空白或 NUL',
  timeRequired: '请输入实付时间',
  future: '实付时间不能晚于当前时间',
  amountRequired: '请输入实付金额',
  amount: '实付金额必须等于应付金额',
};

export function approvedRows(count = 3): Withdrawal[] {
  return Array.from({ length: count }, (_, index) => ({
    ...samples()[0]!,
    withdrawal_id: `e30000${String(index + 1).padStart(2, '0')}-0000-4000-8000-000000000001`,
    out_biz_no: `W2026111800${String(index + 1).padStart(4, '0')}`,
    status: 'APPROVED',
    display_status: 'pending_review',
    payout_channel: index % 2 === 0 ? 'alipay' : 'bank_card',
    payout_method: index % 2 === 0 ? 'alipay' : 'bank_card',
    amount_fen: fenToJsonNumber(yuanStrToFen(index % 2 === 0 ? '13000.00' : '100.00')),
    net_fen: fenToJsonNumber(yuanStrToFen(index % 2 === 0 ? '12345.67' : '98.01')),
    fee_fen: fenToJsonNumber(yuanStrToFen(index % 2 === 0 ? '0.00' : '1.99')),
    tax_fen: fenToJsonNumber(yuanStrToFen(index % 2 === 0 ? '654.33' : '0.00')),
    blocked_reason: null,
    risk_flags: [],
    created_at: `2026-11-17T03:${String(59 - index).padStart(2, '0')}:00.000Z`,
  }));
}
export function serverFor(rows = approvedRows()) {
  const server = createServer(rows);
  const rawBodies: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === MANUAL) {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      expect(typeof raw, 'actual HTTP body, not reserialized JSON').toBe('string');
      rawBodies.push(raw as string);
    }
    return server.fetch(input, init);
  };
  for (let count = 1; count <= 8; count += 1)
    server.once('POST', VERIFY, () =>
      ok({
        ['step_up_token']: `manual-pass-${count}`,
        tier: 'totp',
        expire_at: '2099-01-01T00:00:00Z',
      }),
    );
  return {
    ...server,
    fetch,
    rawBodies,
    get pending() {
      return server.pending;
    },
  };
}
export type Server = ReturnType<typeof serverFor>;
const mounted: { server: Server; direct: ReturnType<typeof vi.fn<typeof globalThis.fetch>> }[] = [];
afterEach(() => {
  try {
    for (const { server, direct } of mounted.splice(0)) {
      expect(direct).not.toHaveBeenCalled();
      expect(
        server.log.filter(
          (r) =>
            !(
              (r.method === 'GET' &&
                [LIST, '/admin/v1/dict', '/admin/v1/me/permissions'].includes(r.path)) ||
              (r.method === 'POST' && [MANUAL, VERIFY].includes(r.path))
            ),
        ),
      ).toEqual([]);
    }
  } finally {
    cleanup();
    injected.clock = undefined;
    vi.unstubAllGlobals();
  }
});
export async function mount(
  server: Server,
  permissions: PermissionSnapshot = GRANTS,
  clock?: { now(): number },
): Promise<void> {
  injected.clock = clock ?? { now: () => Date.parse(NOW) };
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
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    ['getToken']: () => 'example-admin-token',
    onError: vi.fn(),
  });
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'withdrawals' },
        permissionsProvider: async () => permissions,
        account: { username: 'finance', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider,
      }),
    );
  });
  await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
  await waitFor(() => expect(rowsOf(main(), server.state[0]!.out_biz_no)).toHaveLength(1));
  await settled(server);
}
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
export function main(): HTMLElement {
  const area = document.querySelector<HTMLElement>('main');
  expect(area).not.toBeNull();
  return area!;
}
export function buttons(root: HTMLElement, name: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, a, [role="button"]')).filter(
    (node) =>
      (node.textContent ?? '').replace(/\s+/g, '') === name.replace(/\s+/g, '') ||
      node.getAttribute('aria-label') === name,
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
export function rowsOf(root: HTMLElement, number: string): HTMLElement[] {
  return within(root)
    .queryAllByRole('row')
    .filter((row) => within(row).queryAllByText(number, { exact: true }).length > 0);
}
export function rowOf(root: HTMLElement, number: string): HTMLElement {
  const rows = rowsOf(root, number);
  expect(rows, `one row: ${number}`).toHaveLength(1);
  return rows[0]!;
}
export function checkbox(item: Withdrawal): HTMLInputElement {
  const choices = within(rowOf(main(), item.out_biz_no)).queryAllByRole('checkbox');
  expect(choices, `selectable row: ${item.out_biz_no}`).toHaveLength(1);
  expect(choices[0]).toBeInstanceOf(HTMLInputElement);
  expect(disabled(choices[0]!)).toBe(false);
  return choices[0] as HTMLInputElement;
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
export async function select(rows: readonly Withdrawal[]): Promise<void> {
  for (const row of rows) {
    await click(checkbox(row));
    expect(checkbox(row).checked).toBe(true);
  }
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
export async function open(): Promise<HTMLElement> {
  await click(button(main(), '批量手动打款'));
  await waitFor(() => expect(dialogs()).toHaveLength(1));
  expect(stepDialogs()).toEqual([]);
  return dialogs()[0]!;
}
export function field(row: HTMLElement, label: string): HTMLInputElement {
  const found = within(row).queryAllByLabelText(label, { exact: true });
  expect(found, `one input: ${label}`).toHaveLength(1);
  expect(found[0]).toBeInstanceOf(HTMLInputElement);
  return found[0] as HTMLInputElement;
}
export function dateInputValue(node: HTMLInputElement, iso: string): string {
  if (node.type !== 'datetime-local') return iso;
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export async function fillRows(modal: HTMLElement, rows: readonly Withdrawal[]): Promise<Payload> {
  const items: Payload['items'] = [];
  for (const [index, item] of rows.entries()) {
    const row = rowOf(modal, item.out_biz_no);
    const serial = `Serial-${index + 1}-Aa`;
    await fill(field(row, '通道流水号'), `  ${serial}  `);
    const date = field(row, '实付时间');
    await fill(date, dateInputValue(date, WHEN));
    const amount = formatFen(parseFen(item.net_fen));
    await fill(field(row, '实付金额（元）'), amount);
    items.push({
      withdrawal_id: item.withdrawal_id,
      channel_order_id: serial,
      paid_at: WHEN,
      paid_fen: fenToJsonNumber(yuanStrToFen(amount)),
    });
  }
  return { items };
}
export async function confirm(server: Server, modal: HTMLElement, twice = false): Promise<void> {
  const before = writes(server).length;
  expect(disabled(button(modal, '确认录入'))).toBe(false);
  await click(button(modal, '确认录入'), twice);
  await waitFor(() => expect(stepDialogs()).toHaveLength(1));
  const verification = stepDialogs()[0]!;
  expect(within(verification).queryAllByLabelText('动态码', { exact: true })).toHaveLength(1);
  expect(within(verification).queryAllByLabelText('验证码', { exact: true })).toEqual([]);
  expect(buttons(verification, '重新发送')).toEqual([]);
  expect(writes(server)).toHaveLength(before);
}
export async function verify(twice = false): Promise<void> {
  await waitFor(() => expect(stepDialogs()).toHaveLength(1));
  const modal = stepDialogs()[0]!;
  await fill(field(modal, '动态码'), '123456');
  await click(button(modal, '验证并继续'), twice);
}
export function writes(server: Server) {
  return server.requests('POST', MANUAL);
}
export function assertRequest(server: Server, body: Payload, count = 1): void {
  const sent = writes(server);
  expect(sent).toHaveLength(count);
  const request = sent.at(-1)!;
  expect(request.method).toBe('POST');
  expect(request.path).toBe(MANUAL);
  expect(request.query).toEqual({});
  expect(request.body).toEqual(body);
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(`manual-pass-${count}`);
  expect(request.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
  expect(server.requests('POST', VERIFY).map((r) => r.body)).toEqual(
    Array.from({ length: count }, () => ({ tier: 'totp', code: '123456' })),
  );
  expect(server.log.indexOf(request)).toBeGreaterThan(
    server.log.indexOf(server.requests('POST', VERIFY).at(-1)!),
  );
}
export function assertReplay(server: Server, body: Payload, count: number): void {
  assertRequest(server, body, count);
  expect(writes(server).map((r) => r.headers.get('Idempotency-Key'))).toEqual(
    Array.from({ length: count }, () => writes(server)[0]!.headers.get('Idempotency-Key')),
  );
  expect(server.rawBodies).toEqual(Array.from({ length: count }, () => server.rawBodies[0]));
}
export function paid(rows: readonly Withdrawal[]): ResultItem[] {
  return rows.map((row) => ({ withdrawal_id: row.withdrawal_id, result: 'paid', reason: null }));
}
export function reply(server: Server, items: ResultItem[]): Response {
  for (const item of items.filter((item) => item.result === 'paid')) {
    const row = server.state.find((row) => row.withdrawal_id === item.withdrawal_id)!;
    row.status = 'PAID_MANUAL';
    row.display_status = 'paid_manual';
  }
  return ok({ items } satisfies Schema<'AdminWithdrawalBatchManualPaid'>);
}
export function failure(code: number, data: unknown): Response {
  return Response.json(
    { code, msg: '', data, trace_id: TRACE_ID },
    {
      status:
        code >= 50000
          ? 503
          : code === 40901 || code === 20901
            ? 409
            : code === 10003 || code === 10403
              ? 403
              : 400,
    },
  );
}
export async function notice(text: string, root = document.body): Promise<void> {
  await waitFor(() =>
    expect(within(root).queryAllByText(text, { exact: true }).length).toBeGreaterThan(0),
  );
}
export function inputs(modal: HTMLElement): HTMLInputElement[] {
  return Array.from(modal.querySelectorAll('input'));
}
export async function unknown(modal: HTMLElement): Promise<void> {
  await notice('上次提交结果未知', modal);
  await waitFor(() => expect(dialogs()).toEqual([modal]));
  expect(inputs(modal).length).toBeGreaterThan(0);
  expect(inputs(modal).map((node) => disabled(node))).toEqual(inputs(modal).map(() => true));
  expect(buttons(modal, '确认录入')).toEqual([]);
  expect(
    within(modal)
      .queryAllByRole('button')
      .filter((node) => !disabled(node))
      .map((node) => (node.textContent ?? '').replace(/\s+/g, '')),
  ).toEqual(['重试', '去列表核对']);
  await act(async () => {
    fireEvent['keyDown'](modal, { ['key']: 'Escape', code: 'Escape' });
  });
  const outside = modal.closest('.ant-modal-wrap');
  expect(outside, 'the real modal overlay').not.toBeNull();
  await act(async () => {
    fireEvent.mouseDown(outside!);
    fireEvent.mouseUp(outside!);
    fireEvent.click(outside!);
  });
  expect(dialogs()).toEqual([modal]);
}
export async function retry(server: Server, modal: HTMLElement): Promise<void> {
  const before = writes(server).length;
  await click(button(modal, '重试'));
  await waitFor(() => expect(stepDialogs()).toHaveLength(1));
  expect(writes(server)).toHaveLength(before);
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(before + 1));
  await settled(server);
}
