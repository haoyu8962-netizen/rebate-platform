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
import {
  BASE_URL,
  ID,
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

// Reuse only the frozen data/server fixtures. The old mount installs a read-only afterEach
// which deliberately forbids these newly contracted writes, so it cannot mount this suite.
configure({ asyncUtilTimeout: 10_000 });
export { ID, detailPath, ok };
export const APPROVE = '/admin/v1/withdrawals/batch-approve';
export const REJECT = `${detailPath(ID.pending)}/reject`;
export const VERIFY = '/admin/v1/auth/step-up';
export const OTP = '123456';
export const REVIEW: PermissionSnapshot = {
  isSuper: false,
  permissions: ['withdraw.review'],
  stepUp: { 'withdraw.review': { tier: 'totp', operations: {} } },
};
export const REASONS = [
  {
    code: 'RISK_SUSPECT',
    name: /风险嫌疑|RISK_SUSPECT/,
    text: '账户存在异常，需要核实，请联系客服',
  },
  {
    code: 'ORDER_ABNORMAL',
    name: /订单异常|ORDER_ABNORMAL/,
    text: '部分订单状态待核实，请稍后重新申请',
  },
  {
    code: 'PAYEE_INFO_INVALID',
    name: /收款信息无效|PAYEE_INFO_INVALID/,
    text: '收款信息有误，请核对后重新申请',
  },
  { code: 'USER_REQUEST', name: /用户申请撤销|USER_REQUEST/, text: '已按你的要求取消本次提现' },
  { code: 'OTHER', name: /其他|OTHER/, text: '其他原因，请联系客服' },
] as const;
export type Reason = (typeof REASONS)[number]['code'];
export type Action = 'approve' | 'reject';
export const ENTRY = { approve: /^审核通过$/, reject: /^驳回$/ };
export const SUBMIT = /^(?:确认|确定|提交|确认驳回|确认通过|确认审核通过|审核通过|驳回)$/;
const mounted: { server: Server; direct: ReturnType<typeof vi.fn<typeof globalThis.fetch>> }[] = [];

afterEach(() => {
  const current = mounted.splice(0);
  cleanup();
  vi.unstubAllGlobals();
  for (const { server, direct } of current) {
    expect(direct).not.toHaveBeenCalled();
    expect(
      server.log.filter(
        (r) =>
          !(
            (r.method === 'GET' &&
              [detailPath(ID.pending), '/admin/v1/dict', '/admin/v1/me/permissions'].includes(
                r.path,
              )) ||
            (r.method === 'POST' && [VERIFY, APPROVE, REJECT].includes(r.path))
          ),
      ),
      'no payout, manual-paid, cancellation, recalculation or other unrequested operation',
    ).toEqual([]);
  }
});

export function fixture(status: Withdrawal['status'] = 'PENDING_REVIEW'): Withdrawal {
  return {
    ...samples()[0]!,
    withdrawal_id: ID.pending,
    status,
    // APPROVED deliberately shares this display status with PENDING_REVIEW.
    display_status: (
      {
        PENDING_REVIEW: 'pending_review',
        APPROVED: 'pending_review',
        REJECTED: 'rejected',
        PAYING: 'paying',
        PAID_API: 'paid_auto_review',
        PAID_MANUAL: 'paid_manual',
        FAILED: 'failed',
      } as const
    )[status],
    blocked_reason: null,
    row_version: 17,
  };
}

export function serverFor(item = fixture()): Server {
  const server = createServer([item]);
  for (const pass of ['review-pass-1', 'review-pass-2', 'review-pass-3']) {
    server.once('POST', VERIFY, () =>
      ok({ ['step_up_token']: pass, tier: 'totp', expire_at: '2099-01-01T00:00:00Z' }),
    );
  }
  return server;
}

export function failure(code: number, data: unknown): Response {
  return Response.json(
    { code, msg: '', data, trace_id: TRACE_ID },
    { status: code === 20902 ? 409 : code === 10403 || code === 10003 ? 403 : 400 },
  );
}

export function pathFor(action: Action): string {
  return action === 'approve' ? APPROVE : REJECT;
}
export function writes(server: Server): RequestLog[] {
  return server.log.filter((r) => r.method === 'POST' && [APPROVE, REJECT].includes(r.path));
}
export function succeed(server: Server, action: Action, reason: Reason = 'OTHER'): Response {
  const item = server.state[0]!;
  item.status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  item.display_status = action === 'approve' ? 'pending_review' : 'rejected';
  item.reviewer_id = REVIEWER;
  item.reviewed_at = '2026-11-14T10:00:00+08:00';
  item.row_version += 1;
  if (action === 'approve')
    return ok({ items: [{ withdrawal_id: ID.pending, result: 'approved', reason: null }] });
  item.reject_reason_code = reason;
  return ok({
    withdrawal_id: ID.pending,
    status: 'REJECTED',
    reject_reason_code: reason,
    reviewer_id: REVIEWER,
    reviewed_at: item.reviewed_at,
  });
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
        initialRoute: { menuId: detailRoute(ID.pending) },
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
  await waitFor(() => expect(server.detailReads(ID.pending).length).toBeGreaterThan(0));
  await waitFor(() => expect(main().textContent).toContain(server.state[0]!.out_biz_no));
  await settled(server);
}
export function main(): HTMLElement {
  const area = document.querySelector<HTMLElement>('main');
  expect(area, 'real shell main').not.toBeNull();
  return area!;
}
export function squash(text: string | null): string {
  return (text ?? '').replace(/\s+/g, '');
}
export function actions(root: HTMLElement, name: RegExp): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, a, [role="button"]')).filter(
    (node) =>
      name.test(squash(node.textContent)) || name.test(squash(node.getAttribute('aria-label'))),
  );
}
export function button(root: HTMLElement, name: RegExp): HTMLElement {
  const found = actions(root, name);
  expect(found, `one button ${String(name)}`).toHaveLength(1);
  return found[0]!;
}
export function disabled(node: HTMLElement): boolean {
  return node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true';
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
    for (let parent: HTMLElement | null = node; parent !== null; parent = parent.parentElement) {
      if (parent.hidden || parent.style.display === 'none') return false;
    }
    return true;
  });
}
export function stepDialogs(): HTMLElement[] {
  return dialogs().filter((node) => (node.textContent ?? '').includes('二次验证'));
}
export async function step(): Promise<HTMLElement> {
  await waitFor(() => expect(stepDialogs(), 'StepUpModal totp').toHaveLength(1));
  return stepDialogs()[0]!;
}
export async function open(action: Action): Promise<HTMLElement> {
  const entry = button(main(), ENTRY[action]);
  expect(disabled(entry)).toBe(false);
  entry.focus();
  await click(entry);
  await waitFor(() => expect(dialogs(), 'one review confirmation').toHaveLength(1));
  expect(stepDialogs(), 'confirmation precedes step-up').toEqual([]);
  return dialogs()[0]!;
}
export async function choose(modal: HTMLElement, reason: Reason): Promise<void> {
  const option = REASONS.find((row) => row.code === reason)!;
  const radios = within(modal).queryAllByRole('radio');
  const chosen = radios.filter(
    (node) =>
      (node instanceof HTMLInputElement && node.value === reason) ||
      option.name.test(node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? ''),
  );
  expect(chosen, `one radio ${reason}`).toHaveLength(1);
  await click(chosen[0]!);
}
export function noteField(modal: HTMLElement): HTMLElement {
  const found = within(modal).queryAllByRole('textbox', { name: /内部备注|备注/ });
  expect(found, 'labelled internal note').toHaveLength(1);
  return found[0]!;
}
export async function confirm(server: Server, modal: HTMLElement, twice = false): Promise<void> {
  const before = writes(server).length;
  await click(button(modal, SUBMIT), twice);
  await step();
  expect(writes(server)).toHaveLength(before);
}
export async function verify(twice = false): Promise<void> {
  const modal = await step();
  const fields = within(modal).queryAllByLabelText('动态码', { exact: true });
  expect(fields, 'totp field, not SMS').toHaveLength(1);
  await fill(fields[0]!, OTP);
  await click(button(modal, /^验证并继续$/), twice);
}
export async function start(server: Server, action: Action): Promise<HTMLElement> {
  const modal = await open(action);
  if (action === 'reject') await choose(modal, 'OTHER');
  await confirm(server, modal);
  return modal;
}
export function assertRequest(server: Server, action: Action, body: unknown, count = 1): void {
  const sent = writes(server);
  expect(sent).toHaveLength(count);
  const request = sent.at(-1)!;
  expect(request.method).toBe('POST');
  expect(request.path).toBe(pathFor(action));
  expect(request.query).toEqual({});
  expect(request.body).toEqual(body);
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(`review-pass-${count}`);
  expect(request.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/\S/));
  expect(server.requests('POST', VERIFY).map((r) => r.body)).toEqual(
    Array.from({ length: count }, () => ({ tier: 'totp', code: OTP })),
  );
  expect(server.log.indexOf(request)).toBeGreaterThan(
    server.log.indexOf(server.requests('POST', VERIFY).at(-1)!),
  );
}
export async function refreshed(server: Server, before: number, state: RegExp): Promise<void> {
  await waitFor(() => expect(server.detailReads(ID.pending).length).toBeGreaterThan(before));
  await settled(server);
  await waitFor(() => expect(main().textContent).toMatch(state));
  expect(actions(main(), ENTRY.approve)).toEqual([]);
  if (server.state[0]!.status === 'REJECTED') expect(actions(main(), ENTRY.reject)).toEqual([]);
}
export function notices(): string {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-form-item-explain-error, .ant-result',
    ),
  )
    .map((node) => node.textContent ?? '')
    .join(' ');
}
