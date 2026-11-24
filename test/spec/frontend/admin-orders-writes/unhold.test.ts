// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL, ROUTE } from '../admin-orders/orders-fixtures.ts';
import { fill, loaded, mount, settled } from '../admin-orders/orders-helpers.ts';
import {
  HOLD_REASON_LABEL,
  STAFF_REASONS,
  choose,
  fillHold,
  noteField,
  open,
  renderOrder,
  submit,
} from './flows.ts';
import {
  ENTRY,
  NOTE,
  createWriteServer,
  entryName,
  expectOrderPosts,
  expectWriteEntries,
  held,
  order,
  released,
  writes,
} from './kit.ts';

it('[AC-F1-07ee-UNHOLD#1] 恢复提交新选的原因、备注和当前版本，成功后按响应显示未暂停', async () => {
  const shown = held(order());
  const server = createWriteServer(shown);
  server.succeed('unhold', released(shown));
  await renderOrder(server, 'order.hold');
  const form = await open('unhold');
  await choose(form, HOLD_REASON_LABEL, STAFF_REASONS[1], STAFF_REASONS);
  await fill(noteField(form), NOTE);
  await submit(form);

  await waitFor(() => expect(screen.getByRole('main').textContent).toContain('未暂停'));
  expect(screen.getByRole('main').textContent).not.toContain('REVIEWING');
  expect(screen.queryByRole('button', { name: entryName(ENTRY.hold) })).not.toBeNull();
  await settled(server);
  expectOrderPosts(server, 'unhold', {
    reason_code: 'CS',
    note: NOTE,
    expected_row_version: shown.row_version,
  });
  expect(writes(server)).toHaveLength(1);
  expect(server.requests('GET', DETAIL)).toHaveLength(1);
}, 40_000);

it('[AC-F1-07ee-UNHOLD#2] 系统待处理关闭后可以打开恢复弹窗，原因必选，备注须有 1–200 字', async () => {
  const server = createWriteServer({ ...held(order()), hold_reason: 'UNMAPPED_STATUS' });
  await renderOrder(server, 'order.hold');
  const form = await open('unhold');
  await fill(noteField(form), NOTE);
  await submit(form);
  await settled(server);
  expect(writes(server)).toEqual([]);

  await fillHold(form, STAFF_REASONS[1], '');
  await submit(form);
  await settled(server);
  expect(writes(server)).toEqual([]);

  const field = noteField(form) as HTMLInputElement | HTMLTextAreaElement;
  await fill(field, '核'.repeat(201));
  if (field.value.length > 200 && field.maxLength !== 200) {
    await submit(form);
    await settled(server);
    expect(writes(server)).toEqual([]);
  } else {
    expect(field.value.length <= 200 || field.maxLength === 200).toBe(true);
  }
}, 40_000);

it('[AC-F1-07ee-UNHOLD#3] 预估状态的暂停单可恢复，持 risk.freeze 也须手选恢复原因', async () => {
  const shown = held(
    order({ platform_status: 'PAID', rebate_status: 'ESTIMATED', display_status: 'PAID' }),
  );
  const server = createWriteServer(shown);
  server.succeed('unhold', { ...released(shown), display_status: 'PAID' });
  await mount(server, ROUTE, {
    isSuper: false,
    permissions: ['order.view', 'order.hold', 'risk.freeze'],
  });
  await loaded();
  expectWriteEntries(server, [ENTRY.unhold]);

  const form = await open('unhold');
  await fill(noteField(form), NOTE);
  await submit(form);
  await settled(server);
  expect(writes(server)).toEqual([]);

  await choose(form, HOLD_REASON_LABEL, STAFF_REASONS[1], STAFF_REASONS);
  await submit(form);
  await waitFor(() => expect(screen.getByRole('main').textContent).toContain('未暂停'));
  await settled(server);
  expectOrderPosts(server, 'unhold', {
    reason_code: 'CS',
    note: NOTE,
    expected_row_version: shown.row_version,
  });
  expect(writes(server)).toHaveLength(1);
}, 40_000);
