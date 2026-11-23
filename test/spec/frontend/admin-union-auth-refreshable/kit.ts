import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import {
  CREDENTIAL,
  NEW_EXPIRY,
  SECRET,
  createServer,
  ok,
  rows,
  type Account,
} from '../admin-unions/fixtures.ts';
import {
  fill,
  loaded,
  main,
  mount,
  openManual,
  row,
  stepUp,
  verify,
} from '../admin-unions/helpers.ts';

export const REFRESHABLE_COLUMN = '能否自动续期';
export const EXPIRY_COLUMN = '到期时间（北京时间）';
export const MANUAL_ACCOUNT = '测试手工账号';
export const RAW_DURATION = 7776000;
export const ACCESS_TOKEN = 'fixture-access-token-must-not-render';
export const REFRESH_TOKEN = 'fixture-refresh-token-must-not-render';

export function listServer() {
  const [oauth, manual] = rows();
  const refreshableAccount = {
    ...oauth!,
    auth_refreshable: true,
    re_expires_in: RAW_DURATION,
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
  };

  return createServer([
    refreshableAccount,
    {
      ...oauth!,
      union_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a04',
      account_name: '测试不可续期账号',
      auth_refreshable: false,
    },
    { ...manual!, auth_refreshable: null },
    {
      ...oauth!,
      union_account_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a05',
      account_name: '测试旧版响应账号',
    },
  ]);
}

export function accountCell(accountName: string, columnName: string): HTMLElement | undefined {
  const header = within(main()).queryByRole('columnheader', { name: columnName });
  const headerRow = header?.closest<HTMLElement>('tr, [role="row"]');
  if (!header || !headerRow) return undefined;

  const column = within(headerRow).getAllByRole('columnheader').indexOf(header);
  return within(row(accountName)).queryAllByRole('cell')[column];
}

export async function saveManualCredential(result: Pick<Account, 'auth_refreshable'>) {
  const initial = rows();
  const manual = initial[1]!;
  const server = createServer(
    initial.map((account) =>
      account.union_account_id === manual.union_account_id
        ? { ...account, auth_refreshable: true }
        : account,
    ),
  );
  // 列表仍返回原行，只有 PUT 响应带回保存后的状态。
  server.once('PUT', CREDENTIAL, () =>
    ok({
      ...manual,
      auth_status: 'active',
      auth_expires_at: NEW_EXPIRY,
      auth_expires_estimated: true,
      ...result,
    } satisfies Account),
  );

  await mount(server);
  await loaded();
  const before = accountCell(MANUAL_ACCOUNT, REFRESHABLE_COLUMN)?.textContent?.trim();
  const form = await openManual();
  await fill(within(form).getByLabelText('新凭据'), SECRET);
  await verify(await stepUp(form));
  await waitFor(() => expect(row(MANUAL_ACCOUNT).textContent).toMatch(/2027[-/]0?4[-/]0?4/));

  return { before, server };
}
