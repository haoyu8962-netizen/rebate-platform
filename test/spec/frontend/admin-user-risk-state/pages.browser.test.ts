/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import {
  BASE_URL,
  OTP,
  REASON,
  RISK_PATH,
  ROW,
  UID,
  categoryShown,
  createServer,
  inModeChoice,
  userDetail,
  userIn,
  type Server,
} from './risk-fixtures.ts';

// The real users route of the admin app in Chromium: 【详情】 of the user, the title row's
// 【解冻】 / 【封禁】, the dialog, the totp step-up and the one PUT risk-state; the title row then
// shows the new state and its entries. Only the reads, the step-up and that write go out.
const FIRST = { timeout: 10_000 };
const DISMISS = /^(?:取消|关闭|返回|Close|Cancel)$/i;
const FIELD_PARTS =
  '.ant-modal-close, .ant-select, .ant-radio-group, .ant-radio-wrapper, .ant-segmented, .ant-picker, [role="radiogroup"], label';
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

/** Renders the shell over `server`; the marker's data-pending counts requests in flight. */
function show(server: Server): HTMLElement {
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    pending += 1;
    marker.dataset['pending'] = String(pending);
    try {
      return await server.fetch(input, init);
    } finally {
      pending -= 1;
      marker.dataset['pending'] = String(pending);
    }
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'users' },
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return marker;
}

async function screenshot(name: string, marker: HTMLElement): Promise<void> {
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  for (const overlay of Array.from(
    document.querySelectorAll('.ant-modal, .ant-modal-mask, .ant-drawer'),
  ))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

/**
 * The one button of `dialog` that does not dismiss it (field controls left out, the 处理方式
 * 冻结 / 封禁 choices of a dialog that does both included).
 */
function submitIn(dialog: Element): HTMLElement {
  const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button')).filter((node) => {
    const text = squash(node.textContent);
    return (
      node.closest(FIELD_PARTS) === null &&
      !inModeChoice(dialog, node) &&
      text !== '' &&
      !DISMISS.test(text)
    );
  });
  expect(buttons, 'one submit button in the dialog').toHaveLength(1);
  return buttons[0]!;
}

/** The title row: the block around the 用户详情 heading that holds 【返回用户查询】. */
function titleRow(): Element {
  const headings = Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4'));
  const heading = headings.find((node) => squash(node.textContent) === '用户详情');
  const hasBack = (node: Element) =>
    Array.from(node.querySelectorAll('button')).some(
      (button) => squash(button.textContent) === '返回用户查询',
    );
  let row: Element | null | undefined = heading?.parentElement;
  while (row !== null && row !== undefined && !hasBack(row)) row = row.parentElement;
  expect(row ?? null, 'the title row with 【返回用户查询】').not.toBeNull();
  return row!;
}

/** Text of the title row without its buttons and links. */
function titleRowState(): string {
  const copy = titleRow().cloneNode(true) as Element;
  for (const node of Array.from(copy.querySelectorAll('button, a'))) node.remove();
  return squash(copy.textContent);
}

async function openDetail(server: Server) {
  const marker = show(server);
  const main = page.getByRole('main');
  const open = main.getByRole('button', { name: `详情 ${UID}` });
  await expect.element(open, FIRST).toBeVisible();
  await open.click();
  await expect.element(main.getByRole('heading', { name: '用户详情' }), FIRST).toBeVisible();
  return { marker, main };
}

async function verifyStep(server: Server): Promise<void> {
  const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
  await expect.element(verification, FIRST).toBeVisible();
  expect(server.writes(), 'no PUT before the step-up').toEqual([]);
  await verification.getByLabelText('动态码', { exact: true }).fill(OTP);
  await verification.getByRole('button', { name: '验证并继续' }).click();
}

it('[AC-F1-07jd-BROWSER#1] 1440 超管看已冻结用户：标题行【解冻】→ 对话框（只填原因）→ 动态码 → 一次 PUT risk-state（unfreeze），标题行变正常并出现【冻结】；只发读、动态码与这一个写', async () => {
  await page.viewport(1440, 1100);
  const server = createServer(userIn('frozen'), { writes: ['unfreeze'] });
  const { marker, main } = await openDetail(server);
  const unfreeze = main.getByRole('button', { name: /^解\s*冻$/ });
  await expect.element(unfreeze, FIRST).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^封\s*禁$/ }), FIRST).toBeVisible();
  expect(main.getByRole('button', { name: /^解\s*封$/ }).elements()).toEqual([]);
  expect(titleRowState()).toMatch(/已冻结|frozen/);
  expect(server.requests('PUT'), 'reading the detail sends no PUT').toEqual([]);
  await unfreeze.click();

  const dialog = page.getByRole('dialog');
  await expect.element(dialog, FIRST).toBeVisible();
  await dialog.getByRole('textbox', { name: /原因/ }).fill(REASON);
  expect(dialog.getByRole('radio').elements(), 'no category choice').toEqual([]);
  expect(server.requests('PUT'), 'nothing sent when the dialog opens').toEqual([]);
  await screenshot('admin-user-risk-unfreeze', marker);
  await page.elementLocator(submitIn(dialog.element())).click();

  await verifyStep(server);
  await expect.element(main.getByRole('button', { name: /^冻\s*结$/ }), FIRST).toBeVisible();
  await expect
    .element(main.getByRole('button', { name: /^解\s*冻$/ }), FIRST)
    .not.toBeInTheDocument();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  // The row's buttons hold 冻结 / 封禁 only, so 正常 can only come from its state tag.
  await expect.element(page.elementLocator(titleRow()), FIRST).toMatchTextContent(/正常|normal/);
  expect(titleRowState()).toMatch(/正常|normal/);
  expect(titleRowState()).not.toMatch(/已冻结/);
  expect(server.writes()).toHaveLength(1);
  const write = server.writes()[0]!;
  expect(write.method).toBe('PUT');
  expect(write.path).toBe(RISK_PATH);
  expect(write.body).toStrictEqual({
    action: 'unfreeze',
    reason: REASON,
    expected_row_version: ROW.frozen,
  });
  expect(write.headers.get('X-Step-Up-Token')).toBe(server.issued[0]);
  expect(write.headers.has('Idempotency-Key')).toBe(false);
  expect(server.strays()).toEqual([]);
});

it('[AC-F1-07jd-BROWSER#2] 超管看无风控行的正常用户：【封禁】→ 选原因类别、填原因 → 动态码 → 一次 PUT（ban，expected_row_version null），标题行变已封禁、只剩【解封】', async () => {
  await page.viewport(1440, 1100);
  const server = createServer(userDetail(), { writes: ['ban'] });
  const { marker, main } = await openDetail(server);
  const ban = main.getByRole('button', { name: /^封\s*禁$/ });
  await expect.element(ban, FIRST).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^冻\s*结$/ }), FIRST).toBeVisible();
  await ban.click();

  const dialog = page.getByRole('dialog');
  await expect.element(dialog, FIRST).toBeVisible();
  // Let the dialog's opening animation finish before clicking inside it: a click while the box
  // is still zooming in can land beside the moved control and be lost.
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  const shell = dialog.element().closest('.ant-modal') ?? dialog.element();
  await expect.element(page.elementLocator(shell), FIRST).not.toHaveClass(MOTION);
  const category = categoryShown('malicious_rights');
  const radioLabel = Array.from(dialog.element().querySelectorAll('label')).find(
    (label) =>
      label.querySelector('input[type="radio"]') !== null &&
      category.test(squash(label.textContent)),
  );
  if (radioLabel !== undefined) {
    await page.elementLocator(radioLabel).click();
    const radio = radioLabel.querySelector<HTMLInputElement>('input[type="radio"]')!;
    await expect.poll(() => radio.checked, FIRST).toBe(true);
  } else {
    await dialog.getByRole('combobox').click();
    // The open select's list (rc-select renders it with its visible options).
    await expect.element(page.getByRole('listbox').first(), FIRST).toBeInTheDocument();
    const option = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
      ),
    ).find((node) => category.test(squash(node.textContent)));
    expect(option, 'the category among the options').toBeDefined();
    await page.elementLocator(option!).click();
    await expect
      .poll(
        () => squash(dialog.element().querySelector('.ant-select-selection-item')?.textContent),
        FIRST,
      )
      .toMatch(category);
  }
  await dialog.getByRole('textbox', { name: /原因/ }).fill(REASON);
  expect(server.requests('PUT'), 'nothing sent before the submit').toEqual([]);
  await screenshot('admin-user-risk-ban', marker);
  await page.elementLocator(submitIn(dialog.element())).click();

  await verifyStep(server);
  await expect.element(main.getByRole('button', { name: /^解\s*封$/ }), FIRST).toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  // The row's buttons hold 解封 only, so 已封禁 can only come from its state tag.
  await expect.element(page.elementLocator(titleRow()), FIRST).toMatchTextContent(/已封禁|banned/);
  expect(titleRowState()).toMatch(/已封禁|banned/);
  for (const name of [/^冻\s*结$/, /^解\s*冻$/, /^封\s*禁$/])
    expect(main.getByRole('button', { name }).elements(), String(name)).toEqual([]);
  expect(server.writes()).toHaveLength(1);
  const write = server.writes()[0]!;
  expect(write.path).toBe(RISK_PATH);
  expect(write.body).toStrictEqual({
    action: 'ban',
    reason_category: 'malicious_rights',
    reason: REASON,
    expected_row_version: null,
  });
  expect(write.headers.get('X-Step-Up-Token')).toBe(server.issued[0]);
  expect(write.headers.has('Idempotency-Key')).toBe(false);
  expect(server.strays()).toEqual([]);
});
