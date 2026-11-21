// F1-08anb：【批量自动打款】补测试（编排 D10-2199 / D10-2201）的辅助：按单号取列表「原因 / 执行结果」单元格里
// 本次执行结果那一行、结果对话框的关闭与汇总、整批拒绝提示，以及带登录会话管理员 id 的挂载（SELF）。
// 列名「原因 / 执行结果」与结果行前缀「本次执行结果：」取自工作树 apps/admin/src/texts/withdrawals.ts
// （columns.reason、batchPayout.listResult），在这里独立写成全文期望，不 import 实现的文案。
// 其余约定（假服务端、动态码、请求白名单）见 ../helpers.ts 开头。
import { act, render, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell } from '../../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../../apps/admin/src/providers/access-control/index.ts';
import type {
  AdminAuthProvider,
  LoginSnapshot,
} from '../../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL } from '../../admin-withdrawals/fixtures.ts';
import {
  BATCHES,
  NAME,
  VERIFY,
  click,
  compact,
  dialogs,
  listed,
  main,
  rowOf,
  stepDialogs,
  stubMedia,
  track,
  type Server,
} from '../helpers.ts';

/** The list column holding the per-withdrawal result (texts columns.reason). */
export const RESULT_COLUMN = '原因 / 执行结果';
/** The label of the result line in that column (texts batchPayout.listResult + full-width colon). */
export const RESULT_LABEL = '本次执行结果：';

/** The admin of the signed-in session in SELF (and the reviewer of the self-reviewed withdrawal). */
export const SELF_ADMIN = 'ad0000a1-0000-4000-8000-0000000000a1';
/** Another admin (reviewer of the other withdrawal in SELF). */
export const OTHER_ADMIN = 'ad0000a2-0000-4000-8000-0000000000a2';

/** Hints of a second-person approval that must never appear (BR-WDR-11: no batch second approval). */
export const SECOND_PERSON_HINTS: readonly string[] = [
  '需他人批准',
  '他人批准',
  '第二人',
  '待批准',
  '需批准',
  '二人审批',
];

/** The 「原因 / 执行结果」 cell of the list row of withdrawal number `number`. */
export function resultCell(number: string): HTMLElement {
  const tr = rowOf(main(), number);
  const scope = tr.closest<HTMLElement>('.ant-table') ?? tr.closest<HTMLElement>('table');
  expect(scope, `the table of ${number}`).not.toBeNull();
  const heads = Array.from(scope!.querySelectorAll<HTMLElement>('thead th')).filter(
    (one) => !one.classList.contains('ant-table-cell-scrollbar'),
  );
  const index = heads.findIndex((one) => compact(one.textContent) === compact(RESULT_COLUMN));
  expect(index, `a column ${RESULT_COLUMN}`).not.toBe(-1);
  const cells = Array.from(tr.children).filter(
    (one): one is HTMLElement => one instanceof HTMLElement && one.localName === 'td',
  );
  expect(cells, `${number}: one cell per column`).toHaveLength(heads.length);
  return cells[index]!;
}

/** The result lines (「本次执行结果：…」, outermost elements only) of the list row of `number`. */
export function resultLines(number: string): string[] {
  const cell = resultCell(number);
  const label = compact(RESULT_LABEL);
  const found = Array.from(cell.querySelectorAll<HTMLElement>('*')).filter((one) =>
    compact(one.textContent).startsWith(label),
  );
  return found
    .filter((one) => !found.some((other) => other !== one && other.contains(one)))
    .map((one) => compact(one.textContent));
}

/** The one result line `text` is expected as. */
export function line(text: string): string[] {
  return [compact(`${RESULT_LABEL}${text}`)];
}

/** The page's own dialog (not the step-up), when exactly one is open. */
export function ownDialog(): HTMLElement {
  const own = dialogs().filter((node) => !stepDialogs().includes(node));
  expect(own, 'one dialog of the page').toHaveLength(1);
  return own[0]!;
}

/** The leaf elements of `root` whose text starts with `start` (compact text). */
export function leavesStarting(root: HTMLElement, start: string): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter((one) => one.children.length === 0)
    .map((one) => compact(one.textContent))
    .filter((text) => text.startsWith(compact(start)));
}

/** The alerts of `root` (role=alert) by compact text. */
export function alertsOf(root: HTMLElement): string[] {
  return within(root)
    .queryAllByRole('alert')
    .map((one) => compact(one.textContent));
}

/** Success marks of antd anywhere on the page (message, notification, alert, result, text). */
export function successMarks(): Element[] {
  return Array.from(
    document.querySelectorAll(
      '.ant-message-success, .ant-notification-notice-success, .ant-alert-success, .ant-result-success, .ant-typography-success',
    ),
  );
}

/** 【关闭】 of the result dialog (the footer button with that text, not the corner icon). */
export async function closeResult(): Promise<void> {
  const modal = ownDialog();
  const found = Array.from(modal.querySelectorAll<HTMLElement>('button')).filter(
    (node) => compact(node.textContent) === compact(NAME.close),
  );
  expect(found, `one ${NAME.close} button`).toHaveLength(1);
  await click(found[0]!);
  await waitFor(() => expect(dialogs(), 'the dialog is closed').toEqual([]));
}

/** Every non-GET request as "METHOD path". */
export function writeLines(server: Server): string[] {
  return server.writes().map((request) => `${request.method} ${request.path}`);
}
/** Exactly one verification and one batch write. */
export const ONE_BATCH: readonly string[] = [`POST ${VERIFY}`, `POST ${BATCHES}`];

/** A guard stub whose session is `adminId` (refine's getIdentity answers it). */
function sessionOf(adminId: string, permissions: PermissionSnapshot): AdminAuthProvider {
  const snapshot: LoginSnapshot = { step: 'done', username: 'finance' };
  return {
    login: () => Promise.resolve({ success: false }),
    logout: () => Promise.resolve({ success: true }),
    check: () => Promise.resolve({ authenticated: true }),
    onError: () => Promise.resolve({}),
    getIdentity: () =>
      Promise.resolve({
        ['admin_id']: adminId,
        username: 'finance',
        ['is_super']: permissions.isSuper,
        ['verify_phone_masked']: null,
        permissions: [],
      }),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    ['getToken']: () => 'example-admin-token',
    recordSuccessfulRequest: () => undefined,
    resetLogin: () => undefined,
    retryBindingSecret: () => Promise.resolve({ success: false }),
    start: () => () => undefined,
    dispose: () => undefined,
  };
}

export type DirectFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

/**
 * Mounts the real shell on 资金 / 提现审核 with a signed-in session of `adminId` and waits for the
 * first row. Returns the stubbed global fetch (the page must never call it).
 */
export async function mountAs(
  server: Server,
  permissions: PermissionSnapshot,
  adminId: string,
): Promise<DirectFetch> {
  stubMedia();
  const direct = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', direct);
  track(server);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'withdrawals' },
        permissionsProvider: async () => permissions,
        account: { username: 'finance', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        authProvider: sessionOf(adminId, permissions),
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
  return direct;
}
