// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL, ROUTE, failure } from '../admin-orders/orders-fixtures.ts';
import {
  click,
  fill,
  loaded,
  mount,
  section,
  settled,
  textbox,
} from '../admin-orders/orders-helpers.ts';
import { ASSIGN_REASON_LABEL, fillAssign, open, renderOrder, submit } from './flows.ts';
import {
  ENTRY,
  STEP_UP_TITLE,
  STEP_UP_TOKEN,
  TARGET,
  VERIFY,
  assignBody,
  assigned,
  createWriteServer,
  entryName,
  expectOrderPosts,
  path,
  unattributed,
  writes,
} from './kit.ts';

const STEP_UP_REQUIRED = () => {
  const envelope = failure(10003, { tier: 'totp' }, '需要二次验证，请输入动态码');
  return new Response(envelope.body, { status: 403, headers: envelope.headers });
};

async function expectAssigned(): Promise<void> {
  await waitFor(() => expect(section('归属信息').textContent).toContain(TARGET));
  expect(section('归属信息').textContent).toContain('137****4321');
  expect(section('归属信息').textContent).not.toContain('未归因');
  expect(screen.queryByRole('button', { name: entryName(ENTRY.reassign) })).toBeNull();
}

it('[AC-F1-07ee-ASSIGN#1] 指派带详情锁定值、空的期望归属和 200 字原因，无 10003 时直接显示新归属', async () => {
  const unowned = unattributed();
  const shown = { ...unowned, flags: { ...unowned.flags, locked: true } };
  const reason = '核'.repeat(200);
  const server = createWriteServer(shown);
  server.succeed('reassign', assigned(shown));
  await renderOrder(server, 'order.assign');
  const form = await open('reassign');
  expect(screen.queryByRole('dialog', { name: STEP_UP_TITLE })).toBeNull();
  await fillAssign(form, reason + '验');
  const field = textbox(ASSIGN_REASON_LABEL, form) as HTMLInputElement | HTMLTextAreaElement;
  if (field.value.length > 200 && field.maxLength !== 200) {
    await submit(form);
    await settled(server);
    expect(writes(server)).toEqual([]);
  } else {
    expect(field.value.length <= 200 || field.maxLength === 200).toBe(true);
  }

  await fill(field, reason);
  await submit(form);
  await expectAssigned();
  await settled(server);
  expectOrderPosts(server, 'reassign', assignBody(shown, reason));
  expect(writes(server)).toHaveLength(1);
  expect(screen.queryByRole('dialog', { name: STEP_UP_TITLE })).toBeNull();
  expect(server.requests('GET', DETAIL)).toHaveLength(1);
}, 40_000);

it('[AC-F1-07ee-ASSIGN#2] 第一次不带令牌，收到 10003 后经动态码验证，原请求体带新令牌重发一次', async () => {
  const shown = unattributed();
  const server = createWriteServer(shown);
  const reassign = path('reassign');
  const answer = server.hold('POST', reassign, STEP_UP_REQUIRED);
  server.succeed('reassign', assigned(shown));
  server.verifyTotp();
  await mount(server, ROUTE, {
    isSuper: false,
    permissions: ['order.view', 'order.assign'],
    stepUp: { 'order.assign': { tier: 'totp', operations: {} } },
  });
  await loaded();
  const form = await open('reassign');
  await fillAssign(form);
  try {
    await submit(form);
    await waitFor(() => expectOrderPosts(server, 'reassign', assignBody(shown)));
    expect(screen.queryByRole('dialog', { name: STEP_UP_TITLE })).toBeNull();
    expect(server.requests('POST', VERIFY)).toEqual([]);
  } finally {
    answer();
  }

  const modal = await screen.findByRole('dialog', { name: STEP_UP_TITLE });
  expectOrderPosts(server, 'reassign', assignBody(shown));
  expect(server.requests('POST', VERIFY)).toEqual([]);
  await fill(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  await click(within(modal).getByRole('button', { name: '验证并继续' }));

  await expectAssigned();
  await settled(server);
  expectOrderPosts(server, 'reassign', assignBody(shown), [null, STEP_UP_TOKEN]);
  expect(writes(server).map((request) => request.path)).toEqual([reassign, VERIFY, reassign]);
  const verification = server.requests('POST', VERIFY);
  expect(verification.map(({ body }) => body)).toEqual([{ tier: 'totp', code: '123456' }]);
}, 40_000);

async function expectTargetRejection(
  reason: 'target_banned' | 'target_deleting' | 'target_deleted',
  message: RegExp,
): Promise<void> {
  const shown = unattributed();
  const server = createWriteServer(shown);
  server.respond('reassign', () => failure(20001, { fields: ['user_id'], reason }));
  await renderOrder(server, 'order.assign');
  const form = await open('reassign');
  await fillAssign(form);
  await submit(form);

  await screen.findByText(message);
  expect(section('归属信息').textContent).toContain('未归因');
  expect(section('归属信息').textContent).not.toContain(TARGET);
  expect(screen.queryByRole('dialog', { name: STEP_UP_TITLE })).toBeNull();
  await settled(server);
  expectOrderPosts(server, 'reassign', assignBody(shown));
  expect(writes(server)).toHaveLength(1);
  expect(server.requests('GET', DETAIL)).toHaveLength(1);
}

it(
  '[AC-F1-07ee-ASSIGN#3] 20001 target_banned 提示封禁并保留未归因',
  async () => expectTargetRejection('target_banned', /已封禁|被封禁/),
  40_000,
);

it(
  '[AC-F1-07ee-ASSIGN#4] 20001 target_deleting 提示注销处理中并保留未归因',
  async () => expectTargetRejection('target_deleting', /正在注销|注销(?:中|流程|处理)/),
  40_000,
);

it(
  '[AC-F1-07ee-ASSIGN#5] 20001 target_deleted 提示已注销并保留未归因',
  async () => expectTargetRejection('target_deleted', /已注销|已经注销/),
  40_000,
);
