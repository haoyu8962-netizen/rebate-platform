/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  ALL_GRANTS,
  BASE_URL,
  ID,
  NO,
  PAYEE,
  RISK_NAME,
  STATUS_NAME,
  UNMASKED_VALUES,
  createServer,
  detailPath,
  disallowedRequests,
  snapshot,
} from './fixtures.ts';

// The real /withdrawals route of the admin app in Chromium: the review list with dictionary
// names, a row's 【详情】 to /withdrawals/{id}, the masked payee, and no usable write entry even
// for an account holding every write point. Waits use expect.element / expect.poll only.
const FIRST = { timeout: 10_000 };
const ENTRY = /^(?:详\s*情|查\s*看.*详\s*情|查\s*看)$/;
const WRITE =
  /^(?:审核通过|驳回|批量通过|批量手动打款|批量自动打款|一键组批|手动成功|执行打款|撤销微信转账|重新计算|导出$)/;
/** A reveal entry beside a masked value (this section offers none). */
const REVEAL =
  /^(?:查看|显示)(?:全量|完整|明文)?$|^(?:查看|显示)(?:全量|完整|明文)?(?:收款)?(?:账号|手机号?|号码|姓名|实名|身份证号?)$|揭示|reveal/i;
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

async function show(server = createServer(undefined, { permissions: ALL_GRANTS })) {
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/withdrawals');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => snapshot(server.permissions),
      account: { username: 'fin-yi', displayName: '财务' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: server.fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return server;
}

function usable(name: RegExp): HTMLElement[] {
  const main = page.getByRole('main');
  return [
    ...main.getByRole('button', { name }).elements(),
    ...main.getByRole('link', { name }).elements(),
  ].filter(
    (node) =>
      !(node as HTMLButtonElement).disabled && node.getAttribute('aria-disabled') !== 'true',
  ) as HTMLElement[];
}
function usableWrites(): HTMLElement[] {
  return usable(WRITE);
}
/** Usable reveal entries, leaving out the 【查看】 detail entries of list rows. */
function usableReveals(): HTMLElement[] {
  return usable(REVEAL).filter((node) => {
    const row = node.closest<HTMLElement>('.ant-table-row, [role="row"]');
    return (
      row === null ||
      row.closest('.ant-descriptions') !== null ||
      !/W\d{14}/.test(row.textContent ?? '')
    );
  });
}
/** Unmasked comparison values in the document's text or field values. */
function unmaskedShown(): string[] {
  const fields = Array.from(document.querySelectorAll('input, textarea'), (node) =>
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : '',
  );
  const all = [document.body.textContent ?? '', ...fields].join('\n');
  return UNMASKED_VALUES.filter((value) => all.includes(value));
}

it('[AC-F1-08a-BROWSER#1] /withdrawals 审核列表：列出字典中文名与风险标签，行【详情】进入 /withdrawals/{id}，详情只显示脱敏收款账号与姓名、没有可点的【查看】全量入口，全部写与查看全量权限下也没有可点的写入口，全程只发允许的 GET', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const area = page.getByRole('main');
  const tab = area.getByRole('tab', { name: /^审核列表/ });
  const row = area.getByRole('row').filter({ hasText: NO.rejected });
  // With tabs, the 审核列表 tab is chosen first; without tabs the list is the page itself.
  await expect.poll(() => tab.elements().length + row.elements().length, FIRST).toBeGreaterThan(0);
  if (tab.elements().length > 0) await tab.first().click();
  await expect.element(row, FIRST).toBeVisible();
  await expect.element(row).toMatchTextContent(STATUS_NAME.REJECTED);
  await expect.element(row).toMatchTextContent(RISK_NAME.same_device_multi_account!);
  await expect
    .element(area.getByRole('row').filter({ hasText: NO.pending }))
    .toMatchTextContent(STATUS_NAME.PENDING_REVIEW);
  expect(usableWrites(), 'no usable write entry on the list').toEqual([]);

  const buttons = row.getByRole('button', { name: ENTRY });
  const links = row.getByRole('link', { name: ENTRY });
  await expect.poll(() => buttons.elements().length + links.elements().length).toBeGreaterThan(0);
  await (buttons.elements().length > 0 ? buttons.first() : links.first()).click();

  await expect.poll(() => window.location.pathname, FIRST).toBe(`/withdrawals/${ID.rejected}`);
  await expect.element(page.getByText(PAYEE.rejected.masked_account).first(), FIRST).toBeVisible();
  await expect.element(area).toMatchTextContent(PAYEE.rejected.masked_name);
  await expect.element(area).toMatchTextContent(STATUS_NAME.REJECTED);
  expect(server.requests('GET', detailPath(ID.rejected)).length).toBeGreaterThan(0);
  expect(
    usableWrites().filter(
      (node) =>
        !/^(审核通过|驳回)$/.test(
          (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ''),
        ),
    ),
    'no usable write entry on the detail',
  ).toEqual([]);
  expect(usableReveals(), 'no usable reveal entry on the detail').toEqual([]);
  expect(unmaskedShown(), 'no unmasked phone number, payee account or payee name').toEqual([]);
  expect(server.writes(), 'only GET requests').toEqual([]);
  expect(disallowedRequests(server.log), 'only the allowed GET reads').toEqual([]);
});
