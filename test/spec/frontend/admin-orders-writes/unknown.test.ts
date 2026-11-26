// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { failure, ok } from '../admin-orders/orders-fixtures.ts';
import { click, fill, section, settled, textbox } from '../admin-orders/orders-helpers.ts';
import {
  ASSIGN_REASON_LABEL,
  SUB_REASON_LABEL,
  UID_LABEL,
  choose,
  fillAssign,
  fillHold,
  noteField,
  open,
  renderOrder,
  submit,
} from './flows.ts';
import {
  ASSIGN_REASON,
  NOTE,
  TARGET,
  assignBody,
  createWriteServer,
  expectOrderPosts,
  held,
  order,
  path,
  released,
  unattributed,
  writes,
} from './kit.ts';

function locked(element: HTMLElement): boolean {
  return element.matches(':disabled, [aria-disabled="true"]');
}

function expectPickerLocked(form: HTMLElement): void {
  const scope = within(form);
  const choices = [...scope.queryAllByRole('combobox'), ...scope.queryAllByRole('radio')];
  expect(choices.length).toBeGreaterThan(0);
  expect(choices.every(locked)).toBe(true);
}

function expectTextLocked(field: HTMLElement, value: string): void {
  expect(locked(field) || field.matches('[readonly], [aria-readonly="true"]')).toBe(true);
  expect(field).toHaveProperty('value', value);
}

async function retryButton(form: HTMLElement): Promise<HTMLElement> {
  const scope = within(form);
  const button = await scope.findByRole('button', { name: /重试/ });
  expect(locked(button)).toBe(false);
  const submitting = scope.queryAllByRole('button', {
    name: /^(?:确认|提交|保存|暂停结算|恢复结算|指定归属)/,
  });
  expect(submitting.every(locked)).toBe(true);
  return button;
}

function serverUnavailable(): Response {
  const response = failure(50001, null, '服务暂时不可用');
  return new Response(response.body, { status: 503, headers: response.headers });
}

it('[AC-F1-07ee-UNKNOWN#1] 暂停网络断开时锁定原因和备注，手动原体重试收到成功才结束', async () => {
  const shown = order();
  const server = createWriteServer(shown);
  server.respond('hold', () => Promise.reject(new TypeError('Failed to fetch')));
  const updated = { ...held(shown), last_hold_note: NOTE };
  const answer = server.hold('POST', path('hold'), () => ok(updated));
  await renderOrder(server, 'order.hold');
  const form = await open('hold');
  await fillHold(form);
  await submit(form);
  const again = await retryButton(form);
  const body = { reason_code: 'RISK', note: NOTE, expected_row_version: shown.row_version };
  await settled(server);
  expectOrderPosts(server, 'hold', body);
  expectPickerLocked(form);
  expectTextLocked(noteField(form), NOTE);

  try {
    await click(again);
    await waitFor(() => expectOrderPosts(server, 'hold', body, [null, null]));
    expectPickerLocked(form);
    expectTextLocked(noteField(form), NOTE);
  } finally {
    answer();
  }

  await waitFor(() => expect(screen.getByRole('main').textContent).toContain('REVIEWING'));
  await settled(server);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expectOrderPosts(server, 'hold', body, [null, null]);
  expect(writes(server)).toHaveLength(2);
}, 40_000);

it('[AC-F1-07ee-UNKNOWN#2] 恢复超时后只能用原说明、原因和版本重试', async () => {
  const shown = held(order());
  const server = createWriteServer(shown);
  const timeout = new DOMException('Request timed out', 'TimeoutError');
  server.respond('unhold', () => Promise.reject(timeout));
  server.succeed('unhold', released(shown));
  await renderOrder(server, 'order.hold');
  const form = await open('unhold');
  await fillHold(form);
  await submit(form);
  const again = await retryButton(form);
  const body = { reason_code: 'RISK', note: NOTE, expected_row_version: shown.row_version };
  await settled(server);
  expectOrderPosts(server, 'unhold', body);
  expectPickerLocked(form);
  expectTextLocked(noteField(form), NOTE);

  await click(again);
  await waitFor(() => expect(screen.getByRole('main').textContent).toContain('未暂停'));
  await settled(server);
  expectOrderPosts(server, 'unhold', body, [null, null]);
  expect(writes(server)).toHaveLength(2);
}, 40_000);

it('[AC-F1-07ee-UNKNOWN#3] 原因细分收到 503 保留选择，手动原体重试成功后更新详情', async () => {
  const shown = order();
  const server = createWriteServer(shown);
  server.respond('reason-sub', serverUnavailable);
  server.succeed('reason-sub', { ...shown, reason_sub: 'AFTER_SETTLE', row_version: 20 });
  await renderOrder(server, 'order.claim');
  const form = await open('reason-sub');
  const choice = { code: 'AFTER_SETTLE', label: /结算后退款|AFTER_SETTLE/ };
  await choose(form, SUB_REASON_LABEL, choice);
  await submit(form);
  const again = await retryButton(form);
  const body = { reason_sub: 'AFTER_SETTLE', expected_row_version: shown.row_version };
  await settled(server);
  expectOrderPosts(server, 'reason-sub', body);
  expectPickerLocked(form);

  await click(again);
  await waitFor(() => expect(screen.getByRole('main').textContent).toMatch(choice.label));
  await settled(server);
  expectOrderPosts(server, 'reason-sub', body, [null, null]);
  expect(writes(server)).toHaveLength(2);
}, 40_000);

it('[AC-F1-07ee-UNKNOWN#4] 指派结果未知时锁定 UID 和原因，原体重试明确被拒后可以修改', async () => {
  const shown = unattributed();
  const server = createWriteServer(shown);
  server.respond('reassign', serverUnavailable);
  const rejected = { fields: ['user_id'], reason: 'target_banned' };
  server.respond('reassign', () => failure(20001, rejected));
  await renderOrder(server, 'order.assign');
  const form = await open('reassign');
  await fillAssign(form);
  await submit(form);
  const again = await retryButton(form);
  await settled(server);
  expectOrderPosts(server, 'reassign', assignBody(shown));
  expectTextLocked(textbox(UID_LABEL, form), TARGET);
  expectTextLocked(textbox(ASSIGN_REASON_LABEL, form), ASSIGN_REASON);

  await click(again);
  await screen.findByText(/已封禁|被封禁/);
  await settled(server);
  expectOrderPosts(server, 'reassign', assignBody(shown), [null, null]);
  expect(section('归属信息').textContent).toContain('未归因');
  const field = textbox(ASSIGN_REASON_LABEL, form);
  expect(locked(field) || field.matches('[readonly], [aria-readonly="true"]')).toBe(false);
  await fill(field, '重新核实买家的购买资料');
  expect(field).toHaveProperty('value', '重新核实买家的购买资料');
  expect(writes(server)).toHaveLength(2);
}, 40_000);
