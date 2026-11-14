/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  ADJ,
  BASE_URL,
  COLUMN,
  TEXT,
  VIEW_GRANTS,
  createServer,
  reasonName,
  snapshot,
  statusName,
  yuan,
  type Server,
} from './fixtures.ts';

// The real /adjustments route of the admin app in Chromium for a fund.view account: the 调账单
// table shows the reversed payout recovery with its amount, reason, status, 「已红冲」 and Beijing
// time cell by cell; 【详情】 opens the 调账单详情 drawer with the reversal form's id and the
// 「已红冲」 mark; only the GETs of this page go out. Waits use expect.element only.
const FIRST = { timeout: 10_000 };
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

async function show(server: Server): Promise<Server> {
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/adjustments');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => snapshot(server.permissions),
      account: { username: 'fin-adjust', displayName: '财务' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: server.fetch,
        ['getToken']: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return server;
}

function norm(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
/** The cells of a table row by column title (whitespace collapsed and trimmed). */
function cellsOf(row: Element): Record<string, string> {
  let header: Element | null = null;
  for (let node = row.parentElement; node !== null && header === null; node = node.parentElement)
    header = node.querySelector('thead tr');
  expect(header, 'a header row with column titles').not.toBeNull();
  const titles = Array.from(header!.children, (cell) => norm(cell.textContent));
  const cells: Record<string, string> = {};
  Array.from(row.children).forEach((cell, index) => {
    const title = titles[index];
    if (title !== undefined && title !== '') cells[title] = norm(cell.textContent);
  });
  return cells;
}

it('[AC-F1-08ca-BROWSER#1] /adjustments（fund.view）：已红冲的打款追回单逐格显示金额、原因、状态、「已红冲」与北京时间；【详情】打开「调账单详情」抽屉，显示红冲单号与「已红冲」；只发本页的 GET', async () => {
  await page.viewport(1440, 1080);
  const server = await show(createServer({ permissions: VIEW_GRANTS }));
  const row = page.getByRole('main').getByRole('row').filter({ hasText: ADJ.recovery });
  await expect.element(row, FIRST).toBeVisible();
  const cells = cellsOf(row.element());
  const titles = [
    COLUMN.id,
    COLUMN.amount,
    COLUMN.reason,
    COLUMN.status,
    COLUMN.reversal,
    COLUMN.created,
  ];
  const shown = Object.fromEntries(titles.map((title) => [title, cells[title]]));
  expect(shown).toEqual({
    [COLUMN.id]: ADJ.recovery,
    [COLUMN.amount]: yuan(10000),
    [COLUMN.reason]: reasonName('PAYOUT_RECOVERY'),
    [COLUMN.status]: statusName('APPROVED'),
    [COLUMN.reversal]: TEXT.reversed,
    [COLUMN.created]: '2026-11-30 10:30:00',
  });

  await row.getByText(TEXT.detailEntry, { exact: true }).click();
  const sheet = page.getByRole('dialog').filter({ hasText: TEXT.detailTitle }).first();
  await expect.element(sheet.getByText(ADJ.reversal, { exact: true }), FIRST).toBeVisible();
  await expect.element(sheet.getByText(TEXT.reversed, { exact: true })).toBeVisible();
  expect(server.detailReads(ADJ.recovery)).toHaveLength(1);
  expect(server.others()).toEqual([]);
});
