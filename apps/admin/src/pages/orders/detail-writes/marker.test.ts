// Unit tests of the order write marker (F1-07ee r5): the result-unknown marker of an order is the
// one of components/unknown-marker (this tab, this account, no body), held from sending until a
// definite answer of that very request; a marker left before the page opened blocks new writes
// and shows only a read-only prompt; an unknown status never opens a dialog or offers 【重试】;
// 【刷新】 of the detail sends one GET and nothing else.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearUnknown, readUnknown } from '../../../components/unknown-marker/index.ts';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { AdminApiError, type AdminApiErrorDetails } from '../../../providers/data/index.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import type { OrderDetail } from '../model.ts';
import { OrderDetailPage } from '../OrderDetailPage.tsx';
import { markerPageOf } from './model.ts';
import { OrderWrites, UnknownWritePrompt } from './OrderWrites.tsx';
import { useOrderMarker } from './useOrderMarker.ts';
import { useOrderWrite } from './useOrderWrite.tsx';

vi.setConfig({ testTimeout: 15_000 });

const answers: (() => Promise<unknown>)[] = [];
const custom = vi.fn<(request: { url: string; method: string }) => Promise<unknown>>(() => {
  const next = answers.shift();
  if (next === undefined) throw new Error('unexpected request');
  return next();
});
let admin = 'admin-1';
// One getIdentity per account, so a change of account is a new login (as the guard gives it).
const identities = new Map<string, () => Promise<unknown>>();
function identityOf(id: string): () => Promise<unknown> {
  let found = identities.get(id);
  if (found === undefined) {
    found = () => Promise.resolve({ admin_id: id });
    identities.set(id, found);
  }
  return found;
}
vi.mock('@refinedev/core', () => ({
  useDataProvider: () => () => ({ custom }),
  useActiveAuthProvider: () => ({ getIdentity: identityOf(admin) }),
}));

const ORDER_ID = '0b9d3c1e-1a2b-4c3d-8e9f-001122334455';
const PAGE = markerPageOf(ORDER_ID);
const clock = { now: () => Date.parse('2026-11-25T02:00:00.000Z') };
const everything: AccessControl = { isSuper: true, can: () => true, stepUpTier: () => null };

function fail(details: Partial<AdminApiErrorDetails>): () => Promise<unknown> {
  return () =>
    Promise.reject(
      new AdminApiError({ code: 0, msg: '', data: null, httpStatus: 200, kind: 'api', ...details }),
    );
}
const NETWORK = fail({ code: -1, httpStatus: 0, kind: 'network' });
const RATE_LIMITED = fail({ code: 42901, httpStatus: 429 });

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

function writeHook() {
  return renderHook(() =>
    useOrderWrite<{ note: string }>({
      url: `/admin/v1/orders/${ORDER_ID}/hold`,
      operation: 'hold',
      onDone: () => {},
      orderId: ORDER_ID,
      clock,
      blocked: false,
    }),
  );
}

/** Lets the login guard's identity answer (the marker's account). */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  admin = 'admin-1';
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
  answers.length = 0;
  custom.mockClear();
  clearUnknown({ page: PAGE, account: 'admin-1' });
  clearUnknown({ page: PAGE, account: 'admin-2' });
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

it('[AC-F1-07ee-UNIT#8] 结果未知的写只给发起账号留标记：换账号看不到，存的值不含请求体', async () => {
  const write = writeHook();
  await settle();
  answers.push(NETWORK);
  await act(async () => {
    write.result.current.submit({ note: '核对-机密原因' });
    await Promise.resolve();
  });
  await waitFor(() => expect(write.result.current.phase).toBe('unknown'));
  expect(readUnknown({ page: PAGE, account: 'admin-1' })).toBeDefined();
  expect(readUnknown({ page: PAGE, account: 'admin-2' })).toBeUndefined();
  const stored = Object.values({ ...window.sessionStorage }).join('');
  expect(stored).not.toContain('核对-机密原因');
  write.unmount();

  admin = 'admin-2';
  const other = renderHook(() => useOrderMarker(ORDER_ID));
  await settle();
  expect(other.result.current.scope.account).toBe('admin-2');
  expect(other.result.current.left).toBeUndefined();
  expect(other.result.current.present).toBeUndefined();
});

it('[AC-F1-07ee-UNIT#9] 刷新（重新挂载）后同一账号仍看到标记，写入口全部不出、只有只读提示', async () => {
  const write = writeHook();
  await settle();
  answers.push(NETWORK);
  await act(async () => {
    write.result.current.submit({ note: '核对' });
    await Promise.resolve();
  });
  await waitFor(() => expect(write.result.current.phase).toBe('unknown'));
  write.unmount();

  const again = renderHook(() => useOrderMarker(ORDER_ID));
  await settle();
  expect(again.result.current.left?.page).toBe(PAGE);
  const marker = again.result.current;
  render(
    createElement(OrderWrites, {
      order: order(),
      access: everything,
      marker,
      clock,
      onSaved: () => {},
      onConflict: () => {},
    }),
  );
  for (const name of Object.values(ordersTexts.writes.entries))
    expect(screen.queryByRole('button', { name })).toBeNull();
  cleanup();
  render(createElement(UnknownWritePrompt, { marker, order: order() }));
  expect(screen.getByText(ordersTexts.writes.pendingPrompt.notice)).toBeDefined();
  expect(screen.queryByRole('button', { name: ordersTexts.writes.retry })).toBeNull();
  expect(
    screen.getByRole('button', { name: ordersTexts.writes.pendingPrompt.close }),
  ).toBeDefined();
  expect(custom).toHaveBeenCalledTimes(1);
});

it('[AC-F1-07ee-UNIT#10] 状态未知时不开弹窗、不给重试，只显示结果未知提示', async () => {
  const write = writeHook();
  await settle();
  answers.push(NETWORK);
  await act(async () => {
    write.result.current.submit({ note: '核对' });
    await Promise.resolve();
  });
  await waitFor(() => expect(write.result.current.phase).toBe('unknown'));
  const hook = renderHook(() => useOrderMarker(ORDER_ID));
  await settle();
  const future = order({ display_status: 'SETTLING_V2' });
  render(
    createElement(OrderWrites, {
      order: future,
      access: everything,
      marker: hook.result.current,
      clock,
      onSaved: () => {},
      onConflict: () => {},
    }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: ordersTexts.writes.retry })).toBeNull();
  cleanup();
  // This page's own open write (no marker left before opening) with an unknown status.
  const own = { ...hook.result.current, left: undefined };
  render(createElement(UnknownWritePrompt, { marker: own, order: future }));
  expect(screen.getByText(ordersTexts.writes.pendingPrompt.notice)).toBeDefined();
  expect(screen.queryAllByRole('button')).toEqual([]);
  expect(custom).toHaveBeenCalledTimes(1);
});

it('[AC-F1-07ee-UNIT#11] 同一订单两个请求互不清除：后一个的明确拒绝不撤前一个的标记', async () => {
  const first = writeHook();
  const second = writeHook();
  await settle();
  answers.push(NETWORK);
  await act(async () => {
    first.result.current.submit({ note: 'A' });
    await Promise.resolve();
  });
  await waitFor(() => expect(first.result.current.phase).toBe('unknown'));
  answers.push(RATE_LIMITED);
  await act(async () => {
    second.result.current.submit({ note: 'B' });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(second.result.current.error).toBe(ordersTexts.writes.result.rateLimited),
  );
  expect(readUnknown({ page: PAGE, account: 'admin-1' })).toBeDefined();

  // A's own retry gets a definite answer: only then does the marker go.
  answers.push(() => Promise.resolve({ data: order() }));
  await act(async () => {
    first.result.current.retry();
    await Promise.resolve();
  });
  await waitFor(() => expect(readUnknown({ page: PAGE, account: 'admin-1' })).toBeUndefined());
  expect(custom.mock.calls.map(([request]) => request.method)).toEqual(['post', 'post', 'post']);
});

it('[AC-F1-07ee-UNIT#12] 发送中就留标记：答复前重新挂载也不给新提交，明确答复后才撤', async () => {
  const write = writeHook();
  await settle();
  let answer: (value: unknown) => void = () => {};
  answers.push(() => new Promise((resolve) => (answer = resolve)));
  await act(async () => {
    write.result.current.submit({ note: 'A' });
    await Promise.resolve();
  });
  expect(readUnknown({ page: PAGE, account: 'admin-1' })).toBeDefined();
  const remounted = renderHook(() => useOrderMarker(ORDER_ID));
  await settle();
  expect(remounted.result.current.left).toBeDefined();
  await act(async () => {
    answer({ data: order() });
    await Promise.resolve();
  });
  await waitFor(() => expect(remounted.result.current.left).toBeUndefined());
  expect(readUnknown({ page: PAGE, account: 'admin-1' })).toBeUndefined();
});

it('[AC-F1-07ee-UNIT#13] 详情【刷新】只重新 GET 一次详情，不发任何写请求；未知展示状态显示 UNKNOWN', async () => {
  answers.push(() => Promise.resolve({ data: order({ display_status: 'SETTLING_V2' }) }));
  answers.push(() => Promise.resolve({ data: order() }));
  const reports: unknown[] = [];
  const listener = (event: Event) => reports.push((event as CustomEvent).detail);
  window.addEventListener('couli.admin.diagnostic', listener);
  try {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(OrderDetailPage, { access: everything, orderId: ORDER_ID, clock }),
      ),
    );
    const refresh = await screen.findByRole('button', { name: ordersTexts.detail.refresh });
    expect(screen.getByText(ordersTexts.detail.status.unknownDisplay)).toBeDefined();
    expect(reports).toEqual([
      { event: 'unknown_code', enum: 'display_status', code: 'SETTLING_V2' },
    ]);
    // Unknown status: no write entry and no 【同步此单】, the read-only 【刷新】 stays.
    expect(screen.queryByRole('button', { name: ordersTexts.sync.thisOrderEntry })).toBeNull();
    fireEvent.click(refresh);
    await waitFor(() => expect(custom).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(ordersTexts.detail.status.unknownDisplay)).toBeNull(),
    );
    expect(custom.mock.calls.map(([request]) => request.method)).toEqual(['get', 'get']);
    expect(custom.mock.calls.map(([request]) => request.url)).toEqual([
      `/admin/v1/orders/${ORDER_ID}`,
      `/admin/v1/orders/${ORDER_ID}`,
    ]);
    expect(reports).toHaveLength(1);
  } finally {
    window.removeEventListener('couli.admin.diagnostic', listener);
  }
});
