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
  LIST,
  TRACE_ID,
  createServer,
  ok,
  samples,
  type Server,
  type Withdrawal,
} from '../admin-withdrawals/fixtures.ts';

// Only import frozen fixtures: both older mount helpers register suite-specific afterEach
// guards that disallow this list's writes. Mount the real shell, never a missing new module.
configure({ asyncUtilTimeout: 10_000 });
export { LIST, ok, samples };
export type { Server, Withdrawal };
export const APPROVE = '/admin/v1/withdrawals/batch-approve';
export const VERIFY = '/admin/v1/auth/step-up';
export const REVIEW: PermissionSnapshot = {
  isSuper: false,
  permissions: ['withdraw.review'],
  stepUp: { 'withdraw.review': { tier: 'totp', operations: {} } },
};
export type ResultItem = Schema<'AdminWithdrawalBatchApproveItem'>;

// Independent full-copy expectations, not imports of the implementation's text dictionary.
export const CONSEQUENCE =
  '通过后单据进入待执行打款，金额仍冻结，打款另由【执行打款】办理；余额为负、受阻等不能通过的单由服务端判定，被跳过时这里会写明原因。';
export const RESULT_TEXT = {
  approved: '已通过',
  not_found: '未找到该提现单（不存在或不属于本应用），本次未处理',
  not_pending: '提现单状态已变化，不再是待审核，已刷新为最新状态',
  negative_balance: '用户可用余额为负，本次未处理',
  blocked: '提现单被阻断（已记录阻断原因），本次未处理',
} as const;

const mounted: { server: Server; direct: ReturnType<typeof vi.fn<typeof globalThis.fetch>> }[] = [];

afterEach(() => {
  const current = mounted.splice(0);
  try {
    for (const { server, direct } of current) {
      expect(direct).not.toHaveBeenCalled();
      expect(
        server.log.filter(
          (request) =>
            !(
              (request.method === 'GET' &&
                [LIST, '/admin/v1/dict', '/admin/v1/me/permissions'].includes(request.path)) ||
              (request.method === 'POST' && [VERIFY, APPROVE].includes(request.path))
            ),
        ),
        'only list/common reads, dynamic-code verification and batch approval are permitted',
      ).toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

/** Five pending rows in list order; gross and net differ, including cents and thousands. */
export function pendingRows(): Withdrawal[] {
  const base = samples()[0]!;
  const amounts = [123456789, 123456, 9999, 201, 100];
  const nets = [120987653, 121011, 9988, 200, 99];
  const fees = [0, 345, 11, 1, 1];
  const taxes = [2469136, 2100, 0, 0, 0];
  return amounts.map((amount, index) => ({
    ...base,
    withdrawal_id: `e200000${index + 1}-0000-4000-8000-000000000001`,
    out_biz_no: `W2026111400010${index + 1}`,
    user: { ...samples()[index]!.user },
    amount_fen: amount,
    net_fen: nets[index]!,
    fee_fen: fees[index]!,
    tax_fen: taxes[index]!,
    blocked_reason: null,
    created_at: `2026-11-14T10:0${5 - index}:00+08:00`,
  }));
}

export function serverFor(rows = pendingRows()): Server {
  const server = createServer(rows);
  for (const pass of ['batch-pass-1', 'batch-pass-2', 'batch-pass-3']) {
    server.once('POST', VERIFY, () =>
      ok({ ['step_up_token']: pass, tier: 'totp', expire_at: '2099-01-01T00:00:00Z' }),
    );
  }
  return server;
}

export function failure(code: number, data: unknown): Response {
  return Response.json(
    { code, msg: '', data, trace_id: TRACE_ID },
    {
      status: code === 20901 || code === 40901 ? 409 : code === 10403 || code === 10003 ? 403 : 400,
    },
  );
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

export async function mount(
  server: Server,
  permissions: PermissionSnapshot = REVIEW,
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
        initialRoute: { menuId: 'withdrawals' },
        permissionsProvider: async () => permissions,
        account: { username: 'reviewer', displayName: '审核员' },
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
  await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
  await waitFor(() => expect(rowsOf(main(), server.state[0]!.out_biz_no)).toHaveLength(1));
  await settled(server);
  assertNoOtherActions();
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

export function assertNoOtherActions(): void {
  for (const name of ['批量手动打款', '批量自动打款', '一键组批', '导出', '保存', '恢复默认值'])
    expect(buttons(main(), name), `out-of-scope action: ${name}`).toEqual([]);
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
  expect(rows, `one row for ${number}`).toHaveLength(1);
  return rows[0]!;
}

export function checkbox(item: Withdrawal): HTMLInputElement {
  const choices = within(rowOf(main(), item.out_biz_no)).queryAllByRole('checkbox');
  expect(choices, `pending row ${item.out_biz_no} has a checkbox`).toHaveLength(1);
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
  });
}

export async function select(items: readonly Withdrawal[]): Promise<void> {
  for (const item of items) {
    await click(checkbox(item));
    expect(checkbox(item).checked).toBe(true);
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

export async function step(): Promise<HTMLElement> {
  await waitFor(() => expect(stepDialogs(), 'one totp StepUpModal').toHaveLength(1));
  return stepDialogs()[0]!;
}

export async function open(): Promise<HTMLElement> {
  const entry = button(main(), '批量通过');
  expect(disabled(entry)).toBe(false);
  entry.focus();
  await click(entry);
  await waitFor(() => expect(dialogs(), 'confirmation before step-up').toHaveLength(1));
  expect(stepDialogs()).toEqual([]);
  return dialogs()[0]!;
}

export async function confirm(server: Server, modal: HTMLElement, twice = false): Promise<void> {
  const before = server.writes().length;
  await click(button(modal, '确认通过'), twice);
  const verification = await step();
  expect(within(verification).queryAllByLabelText('动态码', { exact: true })).toHaveLength(1);
  expect(within(verification).queryAllByLabelText('验证码', { exact: true })).toEqual([]);
  expect(buttons(verification, '重新发送')).toEqual([]);
  expect(server.writes()).toHaveLength(before);
}

export async function verify(twice = false): Promise<void> {
  const modal = await step();
  const fields = within(modal).queryAllByLabelText('动态码', { exact: true });
  expect(fields).toHaveLength(1);
  await fill(fields[0]!, '123456');
  await click(button(modal, '验证并继续'), twice);
}

export function writes(server: Server) {
  return server.requests('POST', APPROVE);
}

export function assertRequest(server: Server, items: readonly Withdrawal[], count = 1): void {
  const sent = writes(server);
  expect(sent).toHaveLength(count);
  const request = sent.at(-1)!;
  expect(request.method).toBe('POST');
  expect(request.path).toBe(APPROVE);
  expect(request.query).toEqual({});
  expect(request.body).toEqual({ withdrawal_ids: items.map((item) => item.withdrawal_id) });
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(`batch-pass-${count}`);
  expect(request.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
  expect(server.requests('POST', VERIFY).map((read) => read.body)).toEqual(
    Array.from({ length: count }, () => ({ tier: 'totp', code: '123456' })),
  );
  expect(server.log.indexOf(request)).toBeGreaterThan(
    server.log.indexOf(server.requests('POST', VERIFY).at(-1)!),
  );
}

export function succeed(server: Server, items: readonly Withdrawal[]): Response {
  for (const item of items) {
    const current = server.state.find((row) => row.withdrawal_id === item.withdrawal_id)!;
    current.status = 'APPROVED';
    current.display_status = 'pending_review';
  }
  const results: ResultItem[] = items.map((item) => ({
    withdrawal_id: item.withdrawal_id,
    result: 'approved',
    reason: null,
  }));
  return ok({ items: results });
}

export async function notice(text: string): Promise<void> {
  await waitFor(() =>
    expect(within(document.body).queryAllByText(text, { exact: true }).length).toBeGreaterThan(0),
  );
}
