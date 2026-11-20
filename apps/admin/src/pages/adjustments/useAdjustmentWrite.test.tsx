import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readUnknown } from '../../components/unknown-marker/index.ts';
import { AdminApiError, type AdminApiErrorDetails } from '../../providers/data/index.ts';
import { useAdjustmentWrite } from './useAdjustmentWrite.tsx';

// F1-08at: the hook's result-unknown marker (D10-2075). The data provider answers from `answers`;
// the login guard's identity is admin-1. The write is the reject (no step-up) to keep it short.
const answers: (() => Promise<unknown>)[] = [];
const custom = vi.fn(() => {
  const next = answers.shift();
  if (next === undefined) throw new Error('unexpected request');
  return next();
});
const getIdentity = () => Promise.resolve({ admin_id: 'admin-1' });
vi.mock('@refinedev/core', () => ({
  useDataProvider: () => () => ({ custom }),
  useActiveAuthProvider: () => ({ getIdentity }),
}));

const SCOPE = { page: 'adjustments', account: 'admin-1' } as const;
const AT = Date.parse('2026-11-18T04:00:00.000Z');
let now = AT;
const clock = { now: () => now };

function fail(details: Partial<AdminApiErrorDetails>): () => Promise<unknown> {
  return () =>
    Promise.reject(
      new AdminApiError({ code: 0, msg: '', data: null, httpStatus: 200, kind: 'api', ...details }),
    );
}
const SERVER_ERROR = fail({ code: 50000, httpStatus: 500 });
const NETWORK = fail({ code: -1, httpStatus: 0, kind: 'network' });
const SETTLED = fail({ code: 20001, httpStatus: 409 });
const SESSION_ENDED = fail({ code: 10001, httpStatus: 401 });
const DONE = () => Promise.resolve({ data: { id: 'adj_1' } });

beforeEach(() => {
  now = AT;
});
afterEach(() => {
  cleanup();
  answers.length = 0;
  custom.mockClear();
  window.sessionStorage.clear();
});

async function mounted() {
  const failed = vi.fn();
  const hook = renderHook(() =>
    useAdjustmentWrite<{ reason: string }, { id: string }>({
      operation: 'reject',
      url: '/admin/v1/adjustments/adj_1/reject',
      verify: false,
      onDone: () => {},
      onFailed: failed,
      clock,
    }),
  );
  // The login guard answers first (the account of the marker).
  await act(async () => {});
  return { hook, failed };
}

async function submit(hook: { result: { current: { submit: (b: { reason: string }) => void } } }) {
  await act(async () => {
    hook.result.current.submit({ reason: 'r' });
  });
}

it('[AC-F1-08at-UNIT#11] an enveloped 5xx keeps the key and the marker; the settled replay drops it', async () => {
  const { hook, failed } = await mounted();
  answers.push(SERVER_ERROR);
  await submit(hook);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(readUnknown(SCOPE)).toEqual({
    page: 'adjustments',
    unknown: true,
    at: '2026-11-18T04:00:00.000Z',
  });
  now = AT + 60_000;
  answers.push(DONE);
  await submit(hook);
  const keys = custom.mock.calls.map(
    (call) => (call as unknown as [{ meta: { idempotencyKey: string } }])[0].meta.idempotencyKey,
  );
  expect(keys[1]).toBe(keys[0]);
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08at-UNIT#12] a 5xx then a settled refusal: the marker goes; a 5xx then 10001: it stays', async () => {
  const { hook } = await mounted();
  answers.push(SERVER_ERROR, SETTLED);
  await submit(hook);
  await submit(hook);
  expect(readUnknown(SCOPE)).toBeUndefined();
  answers.push(SERVER_ERROR, SESSION_ENDED, DONE);
  await submit(hook);
  await submit(hook);
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:00:00.000Z');
  // A later new submission's success does not drop the marker of the one given up at 10001.
  await submit(hook);
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:00:00.000Z');
});

it('[AC-F1-08at-UNIT#13] a second write entering unknown keeps the first moment; its success leaves the first marker', async () => {
  const first = await mounted();
  answers.push(NETWORK);
  await submit(first.hook);
  expect(first.hook.result.current.unknown).toBe(true);
  now = AT + 60_000;
  const second = await mounted();
  answers.push(NETWORK);
  await submit(second.hook);
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:00:00.000Z');
  answers.push(DONE);
  await act(async () => {
    second.hook.result.current.retry();
  });
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:00:00.000Z');
  answers.push(DONE);
  await act(async () => {
    first.hook.result.current.retry();
  });
  expect(readUnknown(SCOPE)).toBeUndefined();
});
