// Unit tests of the order write marker (F1-07ee r5–r7): the result-unknown marker of an order is
// the one of components/unknown-marker (this tab, this account, no body), held from sending until
// a definite answer of that very request; a marker left before the page opened blocks new writes
// and shows only a read-only prompt, never with 【关闭】: 【放弃这次提交】 (confirmed) only once the
// page's own read is shown and no write of the order is waiting for its answer in this tab; once
// the left marker goes, the page reads the detail once again and offers no entry until that read
// is shown (【同步此单】 included, r8); an unknown status never opens a dialog or offers 【重试】;
// no reread button.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearUnknown, readUnknown } from '../../../components/unknown-marker/index.ts';
import { subscribeMarkers } from '../../../components/unknown-marker/marker.ts';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { AdminApiError, type AdminApiErrorDetails } from '../../../providers/data/index.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import type { OrderDetail } from '../model.ts';
import { OrderDetailPage } from '../OrderDetailPage.tsx';
import { markerPageOf } from './model.ts';
import { subscribeWrites, writePending } from './openWrites.ts';
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
// One provider getter for every render, as refine's useDataProvider (a useCallback on the data
// context) gives it; a new getter per render would rerun the detail GET effect.
const getProvider = () => ({ custom });
vi.mock('@refinedev/core', () => ({
  useDataProvider: () => getProvider,
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

it('[AC-F1-07ee-UNIT#9] 刷新（重新挂载）后同一账号仍看到标记，写入口全部不出、只有只读提示（无【关闭】，给【放弃这次提交】）', async () => {
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
      locked: false,
    }),
  );
  for (const name of Object.values(ordersTexts.writes.entries))
    expect(screen.queryByRole('button', { name })).toBeNull();
  cleanup();
  render(createElement(UnknownWritePrompt, { marker, order: order() }));
  expect(screen.getByText(ordersTexts.writes.pendingPrompt.notice)).toBeDefined();
  expect(screen.queryByRole('button', { name: ordersTexts.writes.retry })).toBeNull();
  expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  expect(
    screen.getByRole('button', { name: ordersTexts.writes.pendingPrompt.abandon }),
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
      locked: false,
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
  // Still waiting for its answer: no 【放弃这次提交】 for it (r7).
  expect(remounted.result.current.sending).toBe(true);
  expect(remounted.result.current.drops).toBe(0);
  await act(async () => {
    answer({ data: order() });
    await Promise.resolve();
  });
  await waitFor(() => expect(remounted.result.current.left).toBeUndefined());
  expect(readUnknown({ page: PAGE, account: 'admin-1' })).toBeUndefined();
  expect(remounted.result.current.sending).toBe(false);
  expect(remounted.result.current.drops).toBe(1);
});

it('[AC-F1-07ee-UNIT#13] 未知展示状态显示 UNKNOWN、上报一次，不给写入口与【同步此单】，页面只 GET 一次详情', async () => {
  answers.push(() => Promise.resolve({ data: order({ display_status: 'SETTLING_V2' }) }));
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
    expect(await screen.findByText(ordersTexts.detail.status.unknownDisplay)).toBeDefined();
    expect(reports).toEqual([
      { event: 'unknown_code', enum: 'display_status', code: 'SETTLING_V2' },
    ]);
    // Unknown status: no write entry and no 【同步此单】.
    expect(screen.queryByRole('button', { name: ordersTexts.sync.thisOrderEntry })).toBeNull();
    for (const name of Object.values(ordersTexts.writes.entries))
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(custom.mock.calls.map(([request]) => request.method)).toEqual(['get']);
    expect(custom.mock.calls.map(([request]) => request.url)).toEqual([
      `/admin/v1/orders/${ORDER_ID}`,
    ]);
    expect(reports).toHaveLength(1);
  } finally {
    window.removeEventListener('couli.admin.diagnostic', listener);
  }
});

// ---- r7 (approvals 209, D10-3129 ②, D10-3169): 【放弃这次提交】 and the reread after a drop ----

const p = ordersTexts.writes.pendingPrompt;
const e = ordersTexts.writes.entries;
const SCOPE = { page: PAGE, account: 'admin-1' };
const v7 = order();
const v8held = order({
  row_version: 8,
  flags: { locked: false, status_locked: false, rights_pending: false, hold: true },
  hold_reason: 'CS',
});

/** An answer the test gives by hand (no timer). */
function controlled(): {
  readonly answer: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const promise = new Promise<unknown>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { answer: () => promise, resolve, reject };
}
function networkError(): AdminApiError {
  return new AdminApiError({
    code: -1,
    msg: '',
    data: null,
    httpStatus: 0,
    kind: 'network',
  });
}
function apiError(code: number, httpStatus: number): AdminApiError {
  return new AdminApiError({ code, msg: '', data: null, httpStatus, kind: 'api' });
}

function renderPage() {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(OrderDetailPage, { access: everything, orderId: ORDER_ID, clock }),
    ),
  );
}
/** The write entries now rendered (none while locked). */
function entriesShown(): string[] {
  return Object.values(e).filter((name) => screen.queryByRole('button', { name }) !== null);
}
function gets(): number {
  return custom.mock.calls.filter(([request]) => request.method === 'get').length;
}
/** The detail of the page is shown (its sub-order id appears in the header and the body). */
async function detailShown(): Promise<void> {
  expect((await screen.findAllByText('SUB-1')).length).toBeGreaterThan(0);
}

/**
 * A write sent by an earlier mount of the page (甲类): its dialog went before the answer, the
 * request is still open. Returns how to answer it.
 */
async function earlierWriteInFlight() {
  const write = writeHook();
  await settle();
  const post = controlled();
  answers.push(post.answer);
  await act(async () => {
    write.result.current.submit({ note: '核对' });
    await Promise.resolve();
  });
  write.unmount();
  expect(readUnknown(SCOPE)).toBeDefined();
  expect(writePending(ORDER_ID)).toBe(true);
  return post;
}

/** A marker left with nothing open for it any more (a reload, or the write became unknown). */
async function leftMarker(): Promise<void> {
  const write = writeHook();
  await settle();
  answers.push(NETWORK);
  await act(async () => {
    write.result.current.submit({ note: '核对' });
    await Promise.resolve();
  });
  await waitFor(() => expect(write.result.current.phase).toBe('unknown'));
  write.unmount();
  expect(readUnknown(SCOPE)).toBeDefined();
  expect(writePending(ORDER_ID)).toBe(false);
}

async function openAbandon(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: p.abandon });
  await act(async () => {
    fireEvent.click(button);
  });
  const dialogs = await screen.findAllByRole('dialog', { name: p.abandonTitle });
  return dialogs[dialogs.length - 1]!;
}

it('[AC-F1-07ee-UNIT#17] A2/A3 遗留标记 + 详情已显示：无【关闭】，有【放弃这次提交】；二次确认写明仍可能稍后生效；【继续等待】什么都不变', async () => {
  await leftMarker();
  answers.push(() => Promise.resolve({ data: v7 }));
  renderPage();
  await detailShown();
  expect(await screen.findByRole('button', { name: p.abandon })).toBeDefined();
  expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  expect(entriesShown()).toEqual([]);

  const dialog = await openAbandon();
  expect(within(dialog).getByText(p.abandonConfirm)).toBeDefined();
  expect(p.abandonConfirm).toContain('仍可能在稍后生效');
  expect(readUnknown(SCOPE), 'nothing dropped before the confirmation').toBeDefined();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: p.abandonCancel }));
  });
  expect(readUnknown(SCOPE), 'kept after 【继续等待】').toBeDefined();
  expect(entriesShown()).toEqual([]);
  expect(screen.getByRole('button', { name: p.abandon })).toBeDefined();
  expect(gets()).toBe(1);
});

it('[AC-F1-07ee-UNIT#18] A4 【确认放弃】：标记清、详情恰多读一次；重读回答前没有任何写入口，回答后按新详情出现', async () => {
  await leftMarker();
  answers.push(() => Promise.resolve({ data: v7 }));
  renderPage();
  await detailShown();
  const reread = controlled();
  answers.push(reread.answer);
  const dialog = await openAbandon();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: p.abandonOk }));
  });
  expect(readUnknown(SCOPE)).toBeUndefined();
  await waitFor(() => expect(gets()).toBe(2));
  // The reread has no answer yet: locked, the earlier detail is not shown as the current one.
  expect(entriesShown()).toEqual([]);
  expect(screen.getByText(ordersTexts.detail.loading)).toBeDefined();
  expect(screen.queryByRole('button', { name: p.abandon })).toBeNull();
  await act(async () => {
    reread.resolve({ data: v8held });
    await Promise.resolve();
  });
  expect(await screen.findByRole('button', { name: e.unhold })).toBeDefined();
  expect(screen.queryByRole('button', { name: e.hold })).toBeNull();
  expect(gets()).toBe(2);
});

it('[AC-F1-07ee-UNIT#19] A1 详情读取中、读取失败时都没有【放弃这次提交】', async () => {
  await leftMarker();
  const first = controlled();
  answers.push(first.answer);
  renderPage();
  expect(await screen.findByText(p.notice)).toBeDefined();
  expect(screen.getByText(ordersTexts.detail.loading)).toBeDefined();
  expect(screen.queryByRole('button', { name: p.abandon })).toBeNull();
  await act(async () => {
    first.reject(networkError());
    await Promise.resolve();
  });
  expect(await screen.findByText(ordersTexts.detail.loadFailedTitle)).toBeDefined();
  expect(screen.getByText(p.notice)).toBeDefined();
  expect(screen.queryByRole('button', { name: p.abandon })).toBeNull();
  expect(entriesShown()).toEqual([]);
});

it('[AC-F1-07ee-UNIT#20] A5/A9 旧实例请求在途时重新挂载：无写入口、无【放弃这次提交】；旧请求变成结果未知后才出现', async () => {
  const post = await earlierWriteInFlight();
  answers.push(() => Promise.resolve({ data: v7 }));
  renderPage();
  await detailShown();
  expect(await screen.findByText(p.notice)).toBeDefined();
  expect(screen.getByText((text) => text.includes(p.waiting))).toBeDefined();
  expect(screen.queryByRole('button', { name: p.abandon })).toBeNull();
  expect(entriesShown()).toEqual([]);
  await act(async () => {
    post.reject(networkError());
    await Promise.resolve();
  });
  expect(await screen.findByRole('button', { name: p.abandon })).toBeDefined();
  expect(readUnknown(SCOPE)).toBeDefined();
  expect(entriesShown()).toEqual([]);
  expect(gets()).toBe(1);
});

it('[AC-F1-07ee-UNIT#21] A6 旧请求成功（版本 8、已暂停）：自动重读恰一次；重读回答前无写入口；回答后入口是【恢复结算】', async () => {
  const post = await earlierWriteInFlight();
  answers.push(() => Promise.resolve({ data: v7 }));
  renderPage();
  await detailShown();
  expect(screen.getByText(ordersTexts.flags.noHold)).toBeDefined();
  expect(entriesShown()).toEqual([]);
  const reread = controlled();
  answers.push(reread.answer);
  await act(async () => {
    post.resolve({ data: v8held });
    await Promise.resolve();
  });
  await waitFor(() => expect(readUnknown(SCOPE)).toBeUndefined());
  await waitFor(() => expect(gets()).toBe(2));
  expect(entriesShown()).toEqual([]);
  expect(screen.getByText(ordersTexts.detail.loading)).toBeDefined();
  expect(
    screen.queryByText(ordersTexts.flags.noHold),
    'the version 7 detail is not shown',
  ).toBeNull();
  await act(async () => {
    reread.resolve({ data: v8held });
    await Promise.resolve();
  });
  expect(await screen.findByRole('button', { name: e.unhold })).toBeDefined();
  expect(screen.queryByRole('button', { name: e.hold })).toBeNull();
  expect(screen.queryByText(ordersTexts.flags.noHold)).toBeNull();
  await settle();
  expect(gets()).toBe(2);
});

it('[AC-F1-07ee-UNIT#22] A6 旧请求 20902 或明确拒绝：同样自动重读恰一次，重读显示后写入口才出现', async () => {
  for (const cause of [apiError(20902, 409), apiError(42901, 429)]) {
    const post = await earlierWriteInFlight();
    answers.push(() => Promise.resolve({ data: v7 }));
    renderPage();
    await detailShown();
    expect(entriesShown()).toEqual([]);
    const reread = controlled();
    answers.push(reread.answer);
    await act(async () => {
      post.reject(cause);
      await Promise.resolve();
    });
    await waitFor(() => expect(readUnknown(SCOPE)).toBeUndefined());
    await waitFor(() => expect(gets()).toBe(2));
    expect(entriesShown()).toEqual([]);
    await act(async () => {
      reread.resolve({ data: v7 });
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: e.hold })).toBeDefined();
    await settle();
    expect(gets()).toBe(2);
    cleanup();
    custom.mockClear();
    answers.length = 0;
  }
});

it('[AC-F1-07ee-UNIT#23] A7 重读失败：读取失败态、无写入口；【重试】成功后写入口才出现', async () => {
  const post = await earlierWriteInFlight();
  answers.push(() => Promise.resolve({ data: v7 }));
  renderPage();
  await detailShown();
  answers.push(NETWORK);
  await act(async () => {
    post.resolve({ data: v8held });
    await Promise.resolve();
  });
  expect(await screen.findByText(ordersTexts.detail.loadFailedTitle)).toBeDefined();
  expect(entriesShown()).toEqual([]);
  expect(gets()).toBe(2);
  answers.push(() => Promise.resolve({ data: v8held }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: ordersTexts.retry }));
  });
  expect(await screen.findByRole('button', { name: e.unhold })).toBeDefined();
  expect(gets()).toBe(3);
});

it('[AC-F1-07ee-UNIT#24] A8 标记消失时首次读取还在途：那次回答不采用，以重发的回答为准', async () => {
  const post = await earlierWriteInFlight();
  const first = controlled();
  answers.push(first.answer);
  renderPage();
  await waitFor(() => expect(gets()).toBe(1));
  const reread = controlled();
  answers.push(reread.answer);
  await act(async () => {
    post.resolve({ data: v8held });
    await Promise.resolve();
  });
  await waitFor(() => expect(gets()).toBe(2));
  // The first read (sent before the write took effect) answers with version 7: dropped.
  await act(async () => {
    first.resolve({ data: v7 });
    await Promise.resolve();
  });
  expect(screen.queryByText('SUB-1')).toBeNull();
  expect(screen.getByText(ordersTexts.detail.loading)).toBeDefined();
  expect(entriesShown()).toEqual([]);
  await act(async () => {
    reread.resolve({ data: v8held });
    await Promise.resolve();
  });
  expect(await screen.findByRole('button', { name: e.unhold })).toBeDefined();
  expect(screen.queryByRole('button', { name: e.hold })).toBeNull();
  expect(gets()).toBe(2);
});

it('[AC-F1-07ee-UNIT#26] 回答到达时先动标记、后结束在途：任何通知时刻都不出现「标记还在且不在途」', async () => {
  for (const settleWith of [
    (post: ReturnType<typeof controlled>) => post.resolve({ data: v8held }),
    (post: ReturnType<typeof controlled>) => post.reject(apiError(42901, 429)),
    (post: ReturnType<typeof controlled>) => post.reject(apiError(20902, 409)),
  ]) {
    const post = await earlierWriteInFlight();
    const seen: { readonly marked: boolean; readonly pending: boolean }[] = [];
    const record = () =>
      seen.push({ marked: readUnknown(SCOPE) !== undefined, pending: writePending(ORDER_ID) });
    const offMarkers = subscribeMarkers(record);
    const offWrites = subscribeWrites(record);
    try {
      await act(async () => {
        settleWith(post);
        await Promise.resolve();
      });
      await waitFor(() => expect(writePending(ORDER_ID)).toBe(false));
    } finally {
      offMarkers();
      offWrites();
    }
    expect(seen).toEqual([
      { marked: false, pending: true },
      { marked: false, pending: false },
    ]);
  }
});

it('[AC-F1-07ee-UNIT#27] A10 旧实例收到 10001：标记留下、不重读；之后与 A2 相同，只给【放弃这次提交】', async () => {
  const post = await earlierWriteInFlight();
  answers.push(() => Promise.resolve({ data: v7 }));
  renderPage();
  await detailShown();
  expect(screen.queryByRole('button', { name: p.abandon })).toBeNull();
  await act(async () => {
    post.reject(apiError(10001, 401));
    await Promise.resolve();
  });
  expect(await screen.findByRole('button', { name: p.abandon })).toBeDefined();
  expect(readUnknown(SCOPE)).toBeDefined();
  expect(entriesShown()).toEqual([]);
  expect(gets()).toBe(1);
});

it('[AC-F1-07ee-UNIT#28] A11 遗留标记消失后重读回答前：没有【同步此单】、不发 order-syncs；标记还在时与重读显示后都有', async () => {
  const syncEntry = () => screen.queryByRole('button', { name: ordersTexts.sync.thisOrderEntry });
  const syncPosts = () =>
    custom.mock.calls.filter(([request]) => request.url === '/admin/v1/order-syncs').length;
  // The marker goes in either way: the earlier mount's request succeeds, or it is given up.
  const drops: readonly ((reread: ReturnType<typeof controlled>) => Promise<void>)[] = [
    async (reread) => {
      const post = await earlierWriteInFlight();
      answers.push(() => Promise.resolve({ data: v7 }));
      renderPage();
      await detailShown();
      // The left marker is still there: 【同步此单】 as before (r5 on).
      expect(syncEntry(), 'shown while the marker is there').not.toBeNull();
      answers.push(reread.answer);
      await act(async () => {
        post.resolve({ data: v8held });
        await Promise.resolve();
      });
    },
    async (reread) => {
      await leftMarker();
      answers.push(() => Promise.resolve({ data: v7 }));
      renderPage();
      await detailShown();
      expect(await screen.findByRole('button', { name: p.abandon })).toBeDefined();
      expect(syncEntry(), 'shown while the marker is there').not.toBeNull();
      answers.push(reread.answer);
      const dialog = await openAbandon();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: p.abandonOk }));
      });
    },
  ];
  for (const drop of drops) {
    const reread = controlled();
    await drop(reread);
    await waitFor(() => expect(readUnknown(SCOPE)).toBeUndefined());
    await waitFor(() => expect(gets()).toBe(2));
    // The reread has no answer yet: no 【同步此单】 (nor any write entry), nothing synced.
    expect(screen.getByText(ordersTexts.detail.loading)).toBeDefined();
    expect(syncEntry(), 'no 【同步此单】 before the reread is shown').toBeNull();
    expect(entriesShown()).toEqual([]);
    expect(syncPosts()).toBe(0);
    await act(async () => {
      reread.resolve({ data: v8held });
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('button', { name: ordersTexts.sync.thisOrderEntry }),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: e.unhold })).toBeDefined();
    expect(syncPosts()).toBe(0);
    await settle();
    expect(gets()).toBe(2);
    cleanup();
    custom.mockClear();
    answers.length = 0;
  }
});

// ---- r9 (D10-3234): 10003 after an unknown result; BR-TEXT-05 in the status area ----

const w = ordersTexts.writes;
const TARGET_UID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
const STEP_UP_DIALOG = '二次验证 · 动态码';
const STEP_UP = fail({ code: 10003, httpStatus: 403, data: { tier: 'totp' } });
const unowned = order({
  user: null,
  user_basis: null,
  rebate_status: 'UNATTRIBUTED',
  display_status: null,
  commission_split: null,
  reason: null,
  reason_sub: null,
});
const owned = order({
  user: { user_id: TARGET_UID, phone_masked: '137****4321' },
  user_basis: 'admin',
  flags: { locked: true, status_locked: false, rights_pending: false, hold: false },
  rebate_status: 'WAITING',
  display_status: 'WAITING',
  commission_split: null,
  reason: null,
  reason_sub: null,
  row_version: 8,
});

/** A button name as antd may render it (a space inserted between two CJK characters). */
function named(text: string): RegExp {
  return new RegExp(`^${[...text].join('\\s?')}$`);
}
function reassignPosts() {
  return custom.mock.calls
    .map(
      ([request]) => request as { url: string; payload?: unknown; meta?: { stepUpToken?: string } },
    )
    .filter((request) => request.url.endsWith('/reassign'))
    .map((request) => ({ body: request.payload, token: request.meta?.stepUpToken ?? null }));
}
async function openAssign(): Promise<HTMLElement> {
  answers.push(() => Promise.resolve({ data: unowned }));
  renderPage();
  await detailShown();
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: named(e.assign) }));
  });
  const dialog = await screen.findByRole('dialog', { name: e.assign });
  fireEvent.change(within(dialog).getByLabelText(w.assign.user), {
    target: { value: TARGET_UID },
  });
  fireEvent.change(within(dialog).getByLabelText(w.assign.reason), {
    target: { value: '凭购物凭证核实订单归属' },
  });
  return dialog;
}
async function clickIn(scope: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(within(scope).getByRole('button', { name: named(name) }));
  });
}
const SENT = {
  user_id: TARGET_UID,
  expected_user_id: null,
  expected_locked: false,
  reason: '凭购物凭证核实订单归属',
};

it('[AC-F1-07ee-UNIT#29] 结果未知后的【重试】收到 10003：标记保留；动态码取消回到结果未知（锁定、只有【重试】、不能关）；再验证后原体带新令牌重发成功才清标记', async () => {
  await settle();
  const dialog = await openAssign();
  answers.push(NETWORK);
  await clickIn(dialog, w.submit.assign);
  const unknownDialog = await screen.findByRole('dialog', { name: e.assign });
  expect(await within(unknownDialog).findByText(w.result.unknown)).toBeDefined();

  answers.push(STEP_UP);
  await clickIn(unknownDialog, w.retry);
  let stepUp = await screen.findByRole('dialog', { name: STEP_UP_DIALOG });
  expect(readUnknown(SCOPE), 'a 10003 after an unknown result settles nothing').toBeDefined();
  await clickIn(stepUp, '取消');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: STEP_UP_DIALOG })).toBeNull());

  // Back to result unknown: locked, only 【重试】, not closable, no 「验证失败」.
  const back = await screen.findByRole('dialog', { name: e.assign });
  expect(within(back).getByText(w.result.unknown)).toBeDefined();
  expect(within(back).queryByText(w.result.stepUpFailed)).toBeNull();
  expect((within(back).getByLabelText(w.assign.user) as HTMLInputElement).disabled).toBe(true);
  expect((within(back).getByLabelText(w.assign.reason) as HTMLTextAreaElement).disabled).toBe(true);
  expect(
    (within(back).getByRole('button', { name: named(w.submit.assign) }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (within(back).getByRole('button', { name: named(w.cancel) }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(within(back).queryByRole('button', { name: '关闭' })).toBeNull();
  expect(within(back).getByRole('button', { name: named(w.retry) })).toBeDefined();
  expect(readUnknown(SCOPE)).toBeDefined();

  // 【重试】 → 10003 → verify → the same body with the new token → saved.
  answers.push(STEP_UP);
  await clickIn(back, w.retry);
  stepUp = await screen.findByRole('dialog', { name: STEP_UP_DIALOG });
  expect(readUnknown(SCOPE)).toBeDefined();
  fireEvent.change(within(stepUp).getByLabelText('动态码', { exact: true }), {
    target: { value: '123456' },
  });
  answers.push(() => Promise.resolve({ data: { step_up_token: 'tok-r9' } }));
  answers.push(() => Promise.resolve({ data: owned }));
  await clickIn(stepUp, '验证并继续');
  expect(await screen.findByText(w.result.assigned)).toBeDefined();
  await waitFor(() => expect(readUnknown(SCOPE)).toBeUndefined());
  // The detail shown is the one the success answered with (its masked phone).
  expect(document.body.textContent).toContain('137****4321');
  expect(reassignPosts()).toEqual([
    { body: SENT, token: null },
    { body: SENT, token: null },
    { body: SENT, token: null },
    { body: SENT, token: 'tok-r9' },
  ]);
});

it('[AC-F1-07ee-UNIT#30] 此前未曾结果未知的提交收到 10003：照旧清标记、进动态码；取消后回到可编辑并提示验证失败', async () => {
  await settle();
  const dialog = await openAssign();
  answers.push(STEP_UP);
  await clickIn(dialog, w.submit.assign);
  const stepUp = await screen.findByRole('dialog', { name: STEP_UP_DIALOG });
  expect(readUnknown(SCOPE)).toBeUndefined();
  await clickIn(stepUp, '取消');
  const back = await screen.findByRole('dialog', { name: e.assign });
  expect(within(back).getByText(w.result.stepUpFailed)).toBeDefined();
  expect(within(back).queryByText(w.result.unknown)).toBeNull();
  expect((within(back).getByLabelText(w.assign.user) as HTMLInputElement).disabled).toBe(false);
  expect(within(back).queryByRole('button', { name: named(w.retry) })).toBeNull();
  expect(reassignPosts()).toEqual([{ body: SENT, token: null }]);
});

/** The value cell of a status item (antd Descriptions, vertical layout: label row, value row). */
function statusCell(label: string): HTMLElement {
  const labelCell = screen
    .getAllByText(label)
    .map((node) => node.closest('th, td'))
    .find((cell): cell is HTMLElement => cell instanceof HTMLElement) as HTMLElement;
  const row = labelCell.parentElement as HTMLTableRowElement;
  const index = Array.from(row.children).indexOf(labelCell);
  const valueRow = row.nextElementSibling as HTMLTableRowElement;
  return valueRow.children[index] as HTMLElement;
}

it('[AC-F1-07ee-UNIT#31] 状态区按 BR-TEXT-05 / BR-TEXT-12：不认识的平台状态 / 返利状态 / 用户侧显示只显示 order_status.UNKNOWN 的「状态更新中」，状态区各格都不出现原始编码；有不认识的状态时用户侧显示也是「状态更新中」（含 null）；全部认识时照旧', async () => {
  const s = ordersTexts.detail.status;
  const cells = () => [s.platformStatus, s.rebateStatus, s.displayStatus].map(statusCell);
  const noRawCode = (raw: string) => {
    for (const cell of cells()) expect(cell.textContent).not.toContain(raw);
  };

  answers.push(() => Promise.resolve({ data: { ...unowned, platform_status: 'DELIVERED_V2' } }));
  renderPage();
  await detailShown();
  let platform = statusCell(s.platformStatus);
  expect(within(platform).getByText(s.unknownDisplay)).toBeDefined();
  expect(platform.textContent).toBe(s.unknownDisplay);
  expect(within(statusCell(s.displayStatus)).getByText(s.unknownDisplay)).toBeDefined();
  expect(statusCell(s.displayStatus).textContent).toBe(s.unknownDisplay);
  expect(within(statusCell(s.rebateStatus)).queryByText(s.unknownDisplay)).toBeNull();
  noRawCode('DELIVERED_V2');
  cleanup();

  answers.push(() => Promise.resolve({ data: order({ rebate_status: 'PAUSED_V2' }) }));
  renderPage();
  await detailShown();
  expect(within(statusCell(s.rebateStatus)).getByText(s.unknownDisplay)).toBeDefined();
  expect(statusCell(s.rebateStatus).textContent).toBe(s.unknownDisplay);
  expect(within(statusCell(s.platformStatus)).queryByText(s.unknownDisplay)).toBeNull();
  expect(within(statusCell(s.displayStatus)).getByText(s.unknownDisplay)).toBeDefined();
  expect(statusCell(s.displayStatus).textContent).toBe(s.unknownDisplay);
  noRawCode('PAUSED_V2');
  cleanup();

  answers.push(() => Promise.resolve({ data: order({ display_status: 'WAITING_V2' }) }));
  renderPage();
  await detailShown();
  expect(within(statusCell(s.displayStatus)).getByText(s.unknownDisplay)).toBeDefined();
  expect(statusCell(s.displayStatus).textContent).toBe(s.unknownDisplay);
  expect(within(statusCell(s.platformStatus)).queryByText(s.unknownDisplay)).toBeNull();
  expect(within(statusCell(s.rebateStatus)).queryByText(s.unknownDisplay)).toBeNull();
  noRawCode('WAITING_V2');
  cleanup();

  // All known: as before (null display shows the dash, a known one its code).
  answers.push(() => Promise.resolve({ data: unowned }));
  renderPage();
  await detailShown();
  expect(screen.queryByText(s.unknownDisplay)).toBeNull();
  expect(statusCell(s.displayStatus).textContent).toBe(ordersTexts.dash);
  cleanup();
  answers.push(() => Promise.resolve({ data: order() }));
  renderPage();
  await detailShown();
  expect(screen.queryByText(s.unknownDisplay)).toBeNull();
  expect(statusCell(s.displayStatus).textContent).toBe('WAITING');
  platform = statusCell(s.platformStatus);
  expect(platform.textContent).toContain('RECEIVED');
});
