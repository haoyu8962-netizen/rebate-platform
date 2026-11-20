import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearUnknown, readUnknown } from './marker.ts';
import { useUnknownMarker } from './useUnknownMarker.ts';

// F1-08at: the hook as one long-lived dialog instance uses it (ManualPaid on 提现审核, the detail's
// 【执行打款】 / 【手动成功】): mark() on the first unknown answer, leave() on 【去列表核对】 / 【核对】 or a
// 10001, clear() on every settled answer (also when this submission never marked). The login
// guard's identity is admin-1; `identity` lets a test hold it back.
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
