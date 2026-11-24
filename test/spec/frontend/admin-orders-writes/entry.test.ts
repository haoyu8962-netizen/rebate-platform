// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ROUTE, type Detail } from '../admin-orders/orders-fixtures.ts';
import { loaded, mount, openDetail, settled } from '../admin-orders/orders-helpers.ts';
import { renderOrder } from './flows.ts';
import {
  ENTRY,
  controls,
  createWriteServer,
  entryName,
  expectWriteEntries,
  held,
  order,
  unattributed,
} from './kit.ts';

it('[AC-F1-07ee-ENTRY#1] order.hold 按暂停标志只显示暂停或恢复，order.claim 单独开放原因细分', async () => {
  const waiting = createWriteServer(order());
  const first = await renderOrder(waiting, 'order.hold');
  expectWriteEntries(waiting, [ENTRY.hold]);
  first.unmount();

  const paused = createWriteServer(held(order()));
  const second = await renderOrder(paused, 'order.hold');
  expectWriteEntries(paused, [ENTRY.unhold]);
  second.unmount();

  const refundable = createWriteServer(order());
  await renderOrder(refundable, 'order.claim');
  expectWriteEntries(refundable, [ENTRY['reason-sub']]);
}, 40_000);

it('[AC-F1-07ee-ENTRY#2] order.assign 可指派未归因的作废单，已归属订单即便超管也不能改给他人', async () => {
  const owned = createWriteServer(order());
  const first = await renderOrder(owned);
  expectWriteEntries(owned, [ENTRY.hold, ENTRY['reason-sub']]);
  first.unmount();

  const voided = unattributed({ rebate_status: 'VOID', display_status: 'INVALID' });
  const unowned = createWriteServer(voided);
  await renderOrder(unowned, 'order.assign');
  expectWriteEntries(unowned, [ENTRY.reassign]);
}, 40_000);

it('[AC-F1-07ee-ENTRY#3] 只有 order.view 的详情及超管列表均无本单写入口，超管打开未归因详情才见指定归属', async () => {
  const refundable = createWriteServer(order());
  const readOnlyDetail = await mount(refundable, ROUTE);
  await loaded();
  await settled(refundable);
  expectWriteEntries(refundable, []);
  expect(readOnlyDetail.directFetch).not.toHaveBeenCalled();
  readOnlyDetail.unmount();

  const server = createWriteServer(unattributed());
  const viewer = await mount(server, ROUTE);
  await loaded();
  await settled(server);
  expectWriteEntries(server, []);
  expect(viewer.directFetch).not.toHaveBeenCalled();
  viewer.unmount();

  await mount(server, '/orders', { isSuper: true, permissions: [] });
  await loaded();
  expectWriteEntries(server, []);
  await openDetail();
  await screen.findByText('归属信息', { exact: true });
  await settled(server);
  expectWriteEntries(server, [ENTRY.reassign]);
}, 40_000);

it('[AC-F1-07ee-ENTRY#4] 已作废的暂停单保留暂停标记，系统未映射待处理未关闭时禁用恢复', async () => {
  const paused = held(order());
  const voided = createWriteServer({
    ...paused,
    rebate_status: 'VOID',
    display_status: 'INVALID',
  });
  const first = await renderOrder(voided, 'order.hold');
  expect(screen.getByRole('main').textContent).toMatch(/暂停.*RISK/i);
  expectWriteEntries(voided, []);
  first.unmount();

  const pending = createWriteServer({
    ...paused,
    hold_reason: 'UNMAPPED_STATUS',
    unmapped_pending_open: true,
  });
  await renderOrder(pending, 'order.hold');
  expectWriteEntries(pending, [ENTRY.unhold]);
  const restore = controls(screen.getByRole('main'), entryName(ENTRY.unhold));
  expect(restore[0]!.matches(':disabled, [aria-disabled="true"]')).toBe(true);
}, 40_000);

it('[AC-F1-07ee-ENTRY#5] 客户端未知订单状态隐藏写入口，已知状态的同权限详情显示写入口', async () => {
  const shown = unattributed({ reason: 'REFUND', reason_sub: 'IN_SALE' });
  const future = createWriteServer({
    ...shown,
    platform_status: 'FUTURE_PLATFORM_STATUS' as Detail['platform_status'],
  });
  const first = await renderOrder(future);
  expectWriteEntries(future, []);
  first.unmount();

  const known = createWriteServer(shown);
  await renderOrder(known);
  expectWriteEntries(known, [ENTRY.reassign, ENTRY['reason-sub']]);
}, 40_000);
