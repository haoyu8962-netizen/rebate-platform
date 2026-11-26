// Unit tests of the detail gate (F1-07ee r6, BR-FUND-06): a detail read never shows over a newer
// write answer. A read sent before a write's success answer is dropped when it comes back late
// (its success and its failure alike), and so is any answer with a smaller row_version; the page
// keeps the write's detail and the entries that detail gives. The result-unknown prompt never
// offers 【关闭】; it offers 【放弃这次提交】 only while a detail read by the page is shown (r7).
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import type { OrderDetail } from '../model.ts';
import { createDetailGate } from './detailGate.ts';
import { markerPageOf } from './model.ts';
import { OrderWrites, UnknownWritePrompt } from './OrderWrites.tsx';
import type { OrderMarker } from './useOrderMarker.ts';

const ORDER_ID = '0b9d3c1e-1a2b-4c3d-8e9f-001122334455';
const clock = { now: () => Date.parse('2026-11-25T02:00:00.000Z') };
const everything: AccessControl = { isSuper: true, can: () => true, stepUpTier: () => null };
const noMarker: OrderMarker = {
  orderId: ORDER_ID,
  scope: { page: markerPageOf(ORDER_ID), account: 'admin-1' },
  left: undefined,
  present: undefined,
  sending: false,
  drops: 0,
};
const e = ordersTexts.writes.entries;

function order(patch: Record<string, unknown> = {}): OrderDetail {
  return {
    order_id: ORDER_ID,
    platform: 'taobao',
    sub_order_id: 'SUB-1',
    parent_order_id: null,
    title: null,
    raw_item_id: '61234',
    product_key: null,
    quantity: 1,
    refunded_quantity: 0,
    pay_amount_fen: null,
    paid_at: null,
    received_at: null,
    settled_at: null,
    settle_period: null,
    credited_at: null,
    est_commission_fen: null,
    settle_commission_fen: null,
    commission_rate_bp: null,
    is_presale: false,
    deposit_paid_at: null,
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
    display_status: 'WAITING',
    flags: { locked: false, status_locked: false, rights_pending: false, hold: false },
    hold_reason: null,
    unmapped_pending_open: false,
    reason: 'REFUND',
    reason_sub: 'IN_SALE',
    user: null,
    buy_type: null,
    scene_basis: null,
    user_basis: null,
    commission_split: null,
    status_history: [],
    link_logs: [],
    row_version: 7,
    ...patch,
  } as unknown as OrderDetail;
}

const v7 = order();
const v8held = order({
  row_version: 8,
  hold_reason: 'RISK',
  flags: { locked: false, status_locked: false, rights_pending: false, hold: true },
});

/** The page's way with answers: what it shows after each one the gate takes. */
function page() {
  const gate = createDetailGate();
  let shown: OrderDetail | undefined;
  return {
    gate,
    read: () => gate.read(),
    readAnswer: (ticket: number, detail: OrderDetail | undefined) => {
      if (gate.takeRead(ticket, detail)) shown = detail;
    },
    writeAnswer: (detail: OrderDetail) => {
      if (gate.takeWrite(detail)) shown = detail;
    },
    shown: () => shown,
  };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('[AC-F1-07ee-UNIT#14] 写成功后晚到的旧读取被丢弃：页面保持写返回的详情（版本 8 已暂停）与【恢复结算】入口', () => {
  const p = page();
  p.readAnswer(p.read(), v7);
  // A read is sent (version 7, not held), its answer is late; the hold's answer comes first.
  const late = p.read();
  p.writeAnswer(v8held);
  p.readAnswer(late, v7);
  expect(p.shown()).toBe(v8held);

  const kept = p.shown();
  if (kept === undefined) throw new Error('no detail shown');
  render(
    createElement(OrderWrites, {
      order: kept,
      access: everything,
      marker: noMarker,
      clock,
      onSaved: () => {},
      onConflict: () => {},
      locked: false,
    }),
  );
  expect(screen.getByRole('button', { name: e.unhold })).toBeDefined();
  expect(screen.queryByRole('button', { name: e.hold })).toBeNull();
});

it('[AC-F1-07ee-UNIT#15] 写成功后晚到的旧读取失败也不清掉写返回的详情；版本更小的答复一律不显示', () => {
  const p = page();
  p.readAnswer(p.read(), v7);
  const late = p.read();
  p.writeAnswer(v8held);
  // Its failure is dropped too: the gate says no, so the page keeps the write's detail.
  expect(p.gate.takeRead(late, undefined)).toBe(false);
  expect(p.shown()).toBe(v8held);

  // A read sent after the write but answering an older version (7) is not shown either.
  const after = p.read();
  expect(p.gate.takeRead(after, v7)).toBe(false);
  expect(p.shown()).toBe(v8held);

  // A read sent after the write with the same or a newer version is shown.
  const v9 = order({ ...v8held, row_version: 9 });
  p.readAnswer(p.read(), v9);
  expect(p.shown()).toBe(v9);
  // A write answer older than the shown read is not shown over it.
  p.writeAnswer(v8held);
  expect(p.shown()).toBe(v9);
});

it('[AC-F1-07ee-UNIT#16] 遗留的结果未知提示：从不给【关闭】；详情未读到（读取中或读取失败）时不给【放弃这次提交】，读到并显示后才给', () => {
  const left = {
    page: markerPageOf(ORDER_ID),
    unknown: true as const,
    at: '2026-11-25T01:59:00.000Z',
  };
  const marker: OrderMarker = { ...noMarker, left, present: left };
  const abandon = ordersTexts.writes.pendingPrompt.abandon;
  render(createElement(UnknownWritePrompt, { marker, order: undefined }));
  expect(screen.getByText(ordersTexts.writes.pendingPrompt.notice)).toBeDefined();
  expect(screen.queryAllByRole('button')).toEqual([]);
  cleanup();
  render(createElement(UnknownWritePrompt, { marker, order: v7 }));
  expect(screen.getByRole('button', { name: abandon })).toBeDefined();
  expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
});
