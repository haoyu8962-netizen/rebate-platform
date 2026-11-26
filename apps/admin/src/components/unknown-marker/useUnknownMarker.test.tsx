import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearUnknown, readUnknown, subscribeMarkers } from './marker.ts';
import { useUnknownMarker } from './useUnknownMarker.ts';

// F1-08at: the hook as one long-lived dialog instance uses it (ManualPaid on 提现审核, the detail's
// 【执行打款】 / 【手动成功】): mark() on every answer that leaves the result unknown, leave() on
// 【去列表核对】 / 【核对】, sessionEnded() on a 10001, clear() on every settled answer (also when this
// submission never marked). F1-08atb: each submission holds the marker on its own; 【关闭】
// (clearUnknown) while one is under way does not write it back, its later unknown answer does;
// begin() notes a send going out, so a 10001 after 【关闭】 holds it even for a first send.
// The login guard's identity is admin-1; `identity` lets a test hold it back.
let identity: Promise<unknown> = Promise.resolve({ admin_id: 'admin-1' });
const getIdentity = () => identity;
vi.mock('@refinedev/core', () => ({
  useActiveAuthProvider: () => ({ getIdentity }),
}));

const SCOPE = { page: 'withdrawals', account: 'admin-1' } as const;
/** Far from the real time: a moment from Date.now() would not match. */
const T1 = Date.parse('2001-02-03T04:05:06.000Z');
const T2 = T1 + 60_000;
let now = T1;
const clock = { now: () => now };

beforeEach(() => {
  now = T1;
  identity = Promise.resolve({ admin_id: 'admin-1' });
});
afterEach(() => {
  cleanup();
  clearUnknown(SCOPE);
  window.sessionStorage.clear();
});

async function mounted() {
  const hook = renderHook(() => useUnknownMarker('withdrawals', clock));
  // The login guard answers first (the account of the marker).
  await act(async () => {});
  return hook;
}

it('[AC-F1-08at-UNIT#14] after 【去列表核对】 the next batch settled (20001 or success) keeps the first batch marker', async () => {
  const hook = await mounted();
  // Batch 1: no settled answer.
  act(() => hook.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  // 【去列表核对】 closes the dialog while batch 1 is still unknown.
  act(() => hook.result.current.leave());
  // Batch 2 of the same instance: a settled refusal (20001) runs clear().
  act(() => hook.result.current.clear());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  // Batch 3: unknown as well, then its retry succeeds: only its own holding goes.
  now = T2;
  act(() => hook.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  act(() => hook.result.current.clear());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  // Only 【关闭】 on the prompt drops it.
  clearUnknown(SCOPE);
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08at-UNIT#15] without 【去列表核对】 the settled answer of the same submission drops its marker', async () => {
  const hook = await mounted();
  act(() => hook.result.current.mark());
  act(() => hook.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  act(() => hook.result.current.clear());
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08at-UNIT#16] marked and left before the account is known: kept at the clock moment, a later settled answer keeps it', async () => {
  let answer: (value: unknown) => void = () => {};
  identity = new Promise((resolve) => {
    answer = resolve;
  });
  const hook = renderHook(() => useUnknownMarker('withdrawals', clock));
  act(() => hook.result.current.mark());
  act(() => hook.result.current.leave());
  now = T2;
  await act(async () => {
    answer({ admin_id: 'admin-1' });
  });
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  act(() => hook.result.current.clear());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
});

it('[AC-F1-08at-UNIT#17] the moment is the injected clock, never the time read by the hook', async () => {
  const spy = vi.spyOn(Date, 'now');
  try {
    const hook = await mounted();
    now = T2;
    act(() => hook.result.current.mark());
    expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:06:06.000Z');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

const T3 = T1 + 180_000;

it('[AC-F1-08atb-UNIT#1] 【关闭】 while a submission is under way: nothing written back until its answer; an unknown answer holds it afresh at that moment, a settled one leaves nothing', async () => {
  // The prompt of an earlier submission (left at T1).
  const earlier = await mounted();
  act(() => earlier.result.current.mark());
  act(() => earlier.result.current.leave());
  // Under way at 【关闭】: one kept the marker before sending (自动到账设置), one never marked.
  const kept = await mounted();
  const plain = await mounted();
  act(() => kept.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  now = T2;
  act(() => clearUnknown(SCOPE));
  expect(readUnknown(SCOPE), 'closed: nothing written back before an answer').toBeUndefined();
  // The plain one's answer leaves the result unknown at T3: held afresh at T3.
  now = T3;
  act(() => plain.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:08:06.000Z');
  // The kept one's unknown answer joins it; the earlier moment of the joined marker stays.
  now = T3 + 60_000;
  act(() => kept.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:08:06.000Z');
  act(() => plain.result.current.clear());
  expect(readUnknown(SCOPE)?.at, 'the kept one still holds it').toBe('2001-02-03T04:08:06.000Z');
  act(() => kept.result.current.clear());
  expect(readUnknown(SCOPE)).toBeUndefined();

  // Under way at 【关闭】 and then settled: nothing is left.
  now = T1;
  act(() => kept.result.current.mark());
  act(() => clearUnknown(SCOPE));
  act(() => kept.result.current.clear());
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08atb-UNIT#2] two submissions each release only their own holding; the marker goes with the last', async () => {
  const first = await mounted();
  const second = await mounted();
  act(() => first.result.current.mark());
  now = T2;
  act(() => second.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  act(() => first.result.current.clear());
  expect(readUnknown(SCOPE)?.at, 'the second still holds it').toBe('2001-02-03T04:05:06.000Z');
  // A settled answer of the first instance's next submission (never marked) changes nothing.
  act(() => first.result.current.clear());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  act(() => second.result.current.clear());
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08atb-UNIT#3] a 10001 after 【关闭】 holds the marker afresh only for a submission that had marked; 【去列表核对】 after 【关闭】 writes nothing', async () => {
  const marked = await mounted();
  const never = await mounted();
  act(() => marked.result.current.mark());
  act(() => clearUnknown(SCOPE));
  // 【去列表核对】 is no answer: the marker 【关闭】 dropped is not written again.
  const left = await mounted();
  act(() => left.result.current.mark());
  act(() => clearUnknown(SCOPE));
  act(() => left.result.current.leave());
  expect(readUnknown(SCOPE)).toBeUndefined();
  // A first send answered 10001 that never marked keeps nothing.
  now = T2;
  act(() => never.result.current.sessionEnded());
  expect(readUnknown(SCOPE)).toBeUndefined();
  // The marked one answered 10001 at T3: held afresh at T3 and given up (its next clear keeps it).
  now = T3;
  act(() => marked.result.current.sessionEnded());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:08:06.000Z');
  act(() => marked.result.current.clear());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:08:06.000Z');
});

it('[AC-F1-08atb-UNIT#4] a first send under way at 【关闭】 (begin, never marked) answered 10001: held at the moment of the 10001; without a 【关闭】 meanwhile, or settled, nothing is kept', async () => {
  // The prompt of an earlier submission (left at T1).
  const earlier = await mounted();
  act(() => earlier.result.current.mark());
  act(() => earlier.result.current.leave());
  // A first send goes out (nothing stored by it), then the prompt is closed.
  const first = await mounted();
  act(() => first.result.current.begin());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  now = T2;
  act(() => clearUnknown(SCOPE));
  expect(readUnknown(SCOPE), 'closed: nothing until the answer').toBeUndefined();
  // Its answer is 10001 at T3: held at T3 and given up (a later clear keeps it).
  now = T3;
  act(() => first.result.current.sessionEnded());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:08:06.000Z');
  act(() => first.result.current.clear());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:08:06.000Z');
  act(() => clearUnknown(SCOPE));

  // A first send with no 【关闭】 while under way: its 10001 keeps nothing.
  const plain = await mounted();
  act(() => plain.result.current.begin());
  act(() => plain.result.current.sessionEnded());
  expect(readUnknown(SCOPE)).toBeUndefined();
  // Under way at 【关闭】 and then settled: nothing; its next send's 10001 without a 【关闭】 neither.
  act(() => plain.result.current.begin());
  act(() => clearUnknown(SCOPE));
  act(() => plain.result.current.clear());
  act(() => plain.result.current.begin());
  act(() => plain.result.current.sessionEnded());
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08atb-UNIT#17] independent handles each hold and release only their own; marked before the account is known, each is kept at its own moment (the earlier wins)', async () => {
  const hook = await mounted();
  const one = hook.result.current.open();
  const two = hook.result.current.open();
  act(() => one.mark());
  now = T2;
  act(() => two.mark());
  act(() => hook.result.current.mark());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  act(() => one.clear());
  act(() => one.clear());
  expect(readUnknown(SCOPE)?.at, 'two and the default handle still hold it').toBe(
    '2001-02-03T04:05:06.000Z',
  );
  act(() => hook.result.current.clear());
  expect(readUnknown(SCOPE)?.at, 'two still holds it').toBe('2001-02-03T04:05:06.000Z');
  // The same handle marks again (the same submission): it holds again, then settles.
  act(() => one.mark());
  act(() => two.clear());
  expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:05:06.000Z');
  act(() => one.clear());
  expect(readUnknown(SCOPE)).toBeUndefined();
  cleanup();

  // The account not known yet: each handle (and the default one) waits with its own moment.
  let answer: (value: unknown) => void = () => {};
  identity = new Promise((resolve) => {
    answer = resolve;
  });
  const waiting = renderHook(() => useUnknownMarker('withdrawals', clock));
  const first = waiting.result.current.open();
  const second = waiting.result.current.open();
  now = T2;
  act(() => second.mark());
  now = T1;
  act(() => first.mark());
  now = T3;
  act(() => waiting.result.current.mark());
  act(() => second.mark());
  expect(readUnknown(SCOPE)).toBeUndefined();
  await act(async () => {
    answer({ admin_id: 'admin-1' });
  });
  expect(readUnknown(SCOPE)?.at, 'the earliest mark').toBe('2001-02-03T04:05:06.000Z');
  act(() => first.clear());
  act(() => waiting.result.current.clear());
  expect(readUnknown(SCOPE)?.at, 'the second still holds it').toBe('2001-02-03T04:05:06.000Z');
  act(() => second.clear());
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08atb-UNIT#18] the use without begin() (订单详情): mark() before sending, mark() again on 【重试】 keeps the moment, clear() releases only its own, leave() keeps it until clearUnknown; every change is announced; three items stored', async () => {
  const events = vi.fn();
  const unsubscribe = subscribeMarkers(events);
  try {
    const page = await mounted();
    const other = await mounted();
    act(() => page.result.current.mark());
    expect(events).toHaveBeenCalledTimes(1);
    const stored = window.sessionStorage.getItem('couli.admin.unknown-marker:withdrawals:admin-1');
    expect(Object.keys(JSON.parse(stored ?? '{}') as object).sort()).toEqual([
      'at',
      'page',
      'unknown',
    ]);
    now = T2;
    act(() => page.result.current.mark());
    expect(readUnknown(SCOPE)?.at, '【重试】 keeps the moment').toBe('2001-02-03T04:05:06.000Z');
    act(() => other.result.current.mark());
    act(() => other.result.current.clear());
    expect(readUnknown(SCOPE)?.at, 'the other releases only its own').toBe(
      '2001-02-03T04:05:06.000Z',
    );
    act(() => page.result.current.clear());
    expect(readUnknown(SCOPE)).toBeUndefined();
    expect(events).toHaveBeenCalledTimes(2);

    // 10001 on the order page: leave(); the marker stays until 【关闭】.
    now = T3;
    act(() => page.result.current.mark());
    act(() => page.result.current.leave());
    act(() => page.result.current.clear());
    expect(readUnknown(SCOPE)?.at).toBe('2001-02-03T04:08:06.000Z');
    act(() => other.result.current.mark());
    act(() => clearUnknown(SCOPE));
    expect(readUnknown(SCOPE)).toBeUndefined();
    expect(events).toHaveBeenCalledTimes(4);
    // After clearUnknown a release of an old holder does nothing and announces nothing.
    act(() => other.result.current.clear());
    expect(readUnknown(SCOPE)).toBeUndefined();
    expect(events).toHaveBeenCalledTimes(4);
  } finally {
    unsubscribe();
  }
});
