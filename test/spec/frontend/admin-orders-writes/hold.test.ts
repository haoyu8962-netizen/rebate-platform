// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { click, fill, loaded, mount, settled } from '../admin-orders/orders-helpers.ts';
import {
  HOLD_REASON_LABEL,
  STAFF_REASONS,
  choose,
  fillHold,
  noteField,
  open,
  renderOrder,
  submit,
  submitButton,
} from './flows.ts';
import { DETAIL, ROUTE } from '../admin-orders/orders-fixtures.ts';
import {
  ENTRY,
  NOTE,
  createWriteServer,
  entryName,
  expectOrderPosts,
  held,
  order,
  writes,
} from './kit.ts';

it('[AC-F1-07ee-HOLD#1] 暂停只提供风控和客服原因，提交当前版本，状态卡以成功响应为准', async () => {
  const shown = order();
  const updated = { ...held(shown), last_hold_note: NOTE };
  const server = createWriteServer(shown);
  server.succeed('hold', updated);
  await renderOrder(server, 'order.hold');
  expect(screen.getByRole('main').textContent).toContain('未暂停');

  const form = await open('hold');
  await choose(form, HOLD_REASON_LABEL, STAFF_REASONS[0], STAFF_REASONS);
  await fill(noteField(form), NOTE);
  await submit(form);

  await waitFor(() => expect(screen.getByRole('main').textContent).toContain('REVIEWING'));
  const main = screen.getByRole('main');
  expect(main.textContent).toMatch(/暂停.*RISK/i);
  expect(main.textContent).not.toContain('未暂停');
  expect(screen.queryByRole('button', { name: entryName(ENTRY.unhold) })).not.toBeNull();
  await settled(server);
  expectOrderPosts(server, 'hold', {
    reason_code: 'RISK',
    note: NOTE,
    expected_row_version: shown.row_version,
  });
  expect(writes(server)).toHaveLength(1);
  expect(server.requests('GET', DETAIL)).toHaveLength(1);
}, 40_000);

it('[AC-F1-07ee-HOLD#2] 先填备注仍须选原因，清空备注也不可提交', async () => {
  const server = createWriteServer(order());
  await renderOrder(server, 'order.hold');
  const form = await open('hold');

  await fill(noteField(form), NOTE);
  await click(submitButton(form));
  await settled(server);
  expect(writes(server)).toEqual([]);

  await fillHold(form, STAFF_REASONS[1], '');
  await submit(form);
  await settled(server);
  expect(writes(server)).toEqual([]);
}, 40_000);

it('[AC-F1-07ee-HOLD#3] 备注最多 200 字且 200 字可完整提交', async () => {
  const shown = order();
  const note = '核'.repeat(200);
  const server = createWriteServer(shown);
  server.succeed('hold', { ...held(shown), last_hold_note: note });
  await renderOrder(server, 'order.hold');
  const form = await open('hold');
  await fillHold(form, STAFF_REASONS[0], note + '验');
  const field = noteField(form) as HTMLInputElement | HTMLTextAreaElement;
  if (field.value.length > 200 && field.maxLength !== 200) {
    await submit(form);
    await settled(server);
    expect(writes(server)).toEqual([]);
  } else {
    expect(field.value.length <= 200 || field.maxLength === 200).toBe(true);
  }

  await fill(field, note);
  await submit(form);
  await settled(server);
  expectOrderPosts(server, 'hold', {
    reason_code: 'RISK',
    note,
    expected_row_version: shown.row_version,
  });
}, 40_000);

async function expectDerivedHoldReason(
  permissions: readonly string[],
  reasonCode: 'RISK' | 'CS',
): Promise<void> {
  const shown = order();
  const server = createWriteServer(shown);
  server.succeed('hold', { ...held(shown), hold_reason: reasonCode });
  const view = await mount(server, ROUTE, {
    isSuper: false,
    permissions: ['order.view', 'order.hold', ...permissions],
  });
  await loaded();
  const form = await open('hold');
  expect(within(form).queryAllByRole('combobox')).toEqual([]);
  expect(within(form).queryAllByRole('radio')).toEqual([]);

  await fill(noteField(form), NOTE);
  await submit(form);
  await settled(server);
  expectOrderPosts(server, 'hold', {
    reason_code: reasonCode,
    note: NOTE,
    expected_row_version: shown.row_version,
  });
  expect(writes(server)).toHaveLength(1);
  view.unmount();
}

it('[AC-F1-07ee-HOLD#4] 持任一 risk.* 且无 order.claim 时无需选原因，提交 RISK', async () => {
  for (const permission of ['risk.freeze', 'risk.ban', 'risk.blocklist', 'risk.appeal']) {
    await expectDerivedHoldReason([permission], 'RISK');
  }
}, 40_000);

it('[AC-F1-07ee-HOLD#5] 有 order.claim 且无 risk.* 时无需选原因，config.risk 不影响提交 CS', async () => {
  await expectDerivedHoldReason(['order.claim'], 'CS');
  await expectDerivedHoldReason(['order.claim', 'config.risk'], 'CS');
}, 40_000);

it('[AC-F1-07ee-HOLD#6] 同时有两类权限或两类都没有时须选风控或客服，超管同样必选', async () => {
  const cases = [
    { isSuper: false, permissions: ['order.view', 'order.hold', 'risk.freeze', 'order.claim'] },
    { isSuper: false, permissions: ['order.view', 'order.hold', 'config.risk'] },
    { isSuper: true, permissions: [] },
  ];
  for (const snapshot of cases) {
    const shown = order();
    const server = createWriteServer(shown);
    server.succeed('hold', { ...held(shown), hold_reason: 'CS' });
    const view = await mount(server, ROUTE, snapshot);
    await loaded();
    const form = await open('hold');
    await fill(noteField(form), NOTE);
    await submit(form);
    await settled(server);
    expect(writes(server)).toEqual([]);

    await choose(form, HOLD_REASON_LABEL, STAFF_REASONS[1], STAFF_REASONS);
    await submit(form);
    await settled(server);
    expectOrderPosts(server, 'hold', {
      reason_code: 'CS',
      note: NOTE,
      expected_row_version: shown.row_version,
    });
    expect(writes(server)).toHaveLength(1);
    view.unmount();
  }
}, 40_000);
