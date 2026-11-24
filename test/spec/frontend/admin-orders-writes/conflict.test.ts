// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DETAIL, failure, type Detail } from '../admin-orders/orders-fixtures.ts';
import { settled } from '../admin-orders/orders-helpers.ts';
import {
  SUB_REASON_LABEL,
  choose,
  fillAssign,
  fillHold,
  open,
  renderOrder,
  submit,
} from './flows.ts';
import {
  NOTE,
  assignBody,
  assigned,
  createWriteServer,
  expectOrderPosts,
  held,
  order,
  unattributed,
  writes,
  type Action,
} from './kit.ts';

const CHANGED_ORDER = '另一位操作员更新后的商品名称';

async function exerciseConflict(
  action: Action,
  shown: Detail,
  refreshed: Detail,
  fillForm: (form: HTMLElement) => Promise<void>,
  expectedBody: unknown,
): Promise<void> {
  const server = createWriteServer(shown);
  const resource = action === 'reassign' ? 'order_attribution' : 'order';
  server.respond(action, () => failure(20902, { resource }, '状态已变化，请刷新后重试'));
  await renderOrder(server);
  const form = await open(action);
  await fillForm(form);
  server.state.detail = { ...refreshed, title: CHANGED_ORDER };
  await submit(form);

  const conflict = /(?:订单|状态|归属).*(?:已变|发生变化|修改|更新)|请刷新后重试/;
  await screen.findByText(conflict);
  await screen.findByText(CHANGED_ORDER, { exact: true });
  await settled(server);
  expect(server.log.map(({ method, path }) => [method, path])).toEqual([
    ['GET', DETAIL],
    ['POST', `${DETAIL}/${action}`],
    ['GET', DETAIL],
  ]);
  expectOrderPosts(server, action, expectedBody);
  expect(writes(server)).toHaveLength(1);
}

it('[AC-F1-07ee-CONFLICT#1] 暂停收到订单冲突，提示变更且只重读一次详情', async () => {
  const shown = order();
  await exerciseConflict('hold', shown, held(shown), fillHold, {
    reason_code: 'RISK',
    note: NOTE,
    expected_row_version: shown.row_version,
  });
}, 40_000);

it('[AC-F1-07ee-CONFLICT#2] 指派收到归属冲突，只读取一次已被他人指派的最新详情', async () => {
  const shown = unattributed();
  await exerciseConflict('reassign', shown, assigned(shown), fillAssign, assignBody(shown));
}, 40_000);

it('[AC-F1-07ee-CONFLICT#3] 恢复收到订单冲突，只重读一次并显示最新订单', async () => {
  const shown = held(order());
  await exerciseConflict('unhold', shown, { ...shown, row_version: 37 }, fillHold, {
    reason_code: 'RISK',
    note: NOTE,
    expected_row_version: shown.row_version,
  });
}, 40_000);

it('[AC-F1-07ee-CONFLICT#4] 原因细分收到版本冲突，重读一次且不自动重提', async () => {
  const shown = order();
  await exerciseConflict(
    'reason-sub',
    shown,
    { ...shown, row_version: 20, reason_sub: 'AFTER_SETTLE' },
    (form) => choose(form, SUB_REASON_LABEL, { code: 'none', label: '无' }),
    { reason_sub: 'none', expected_row_version: shown.row_version },
  );
}, 40_000);
