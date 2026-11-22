import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearUnknown, markUnknown, readUnknown } from '../../components/unknown-marker/index.ts';
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
const FORBIDDEN: Partial<AdminApiErrorDetails> = { code: 10403, httpStatus: 403 };
const ENDED: Partial<AdminApiErrorDetails> = { code: 10001, httpStatus: 401 };
const KEY_CONFLICT: Partial<AdminApiErrorDetails> = { code: 20901, httpStatus: 409 };

/** An answer held back until `answer()` (the request is under way meanwhile). */
function held(details: Partial<AdminApiErrorDetails>) {
  let answer: () => void = () => {};
  const reply = () =>
    new Promise<unknown>((_, reject) => {
      answer = () =>
        reject(
          new AdminApiError({
            code: 0,
            msg: '',
            data: null,
            httpStatus: 200,
            kind: 'api',
            ...details,
          }),
        );
    });
  return { reply, answer: () => answer() };
}
function keysSent(): string[] {
  return custom.mock.calls.map(
    (call) => (call as unknown as [{ meta: { idempotencyKey: string } }])[0].meta.idempotencyKey,
  );
}

beforeEach(() => {
  now = AT;
});
afterEach(() => {
  cleanup();
  clearUnknown(SCOPE);
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

async function submit(
  hook: { result: { current: { submit: (b: { reason: string }) => void } } },
  reason = 'r',
) {
  await act(async () => {
    hook.result.current.submit({ reason });
  });
}
function bodiesSent(): unknown[] {
  return custom.mock.calls.map((call) => (call as unknown as [{ payload: unknown }])[0].payload);
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

it('[AC-F1-08atb-UNIT#5] an enveloped 5xx, then the same key refused 10403 before the replay: still unknown, the key and the marker stay', async () => {
  const { hook, failed } = await mounted();
  answers.push(SERVER_ERROR, fail(FORBIDDEN));
  await submit(hook);
  now = AT + 60_000;
  await submit(hook);
  expect(failed).toHaveBeenCalledTimes(2);
  expect(failed.mock.calls[1]?.[1], 'the earlier result under this key is still unknown').toBe(
    true,
  );
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:00:00.000Z');
  // The next submission replays the same key; its settled success drops the marker.
  answers.push(DONE);
  await submit(hook);
  const keys = keysSent();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).toBe(keys[0]);
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08atb-UNIT#6] an enveloped 5xx, then the same key refused 10403 after the dialog was left: the marker stays', async () => {
  const { hook, failed } = await mounted();
  const refusal = held(FORBIDDEN);
  answers.push(SERVER_ERROR, refusal.reply);
  await submit(hook);
  await submit(hook);
  hook.unmount();
  now = AT + 60_000;
  await act(async () => {
    refusal.answer();
  });
  const keys = keysSent();
  expect(keys[1]).toBe(keys[0]);
  expect(failed, 'the left dialog is not told').toHaveBeenCalledTimes(1);
  expect(readUnknown(SCOPE)).toEqual({
    page: 'adjustments',
    unknown: true,
    at: '2026-11-18T04:00:00.000Z',
  });
});

it('[AC-F1-08atb-UNIT#7] a first send under way at 【关闭】 answered 10001: the marker is kept at the moment of the 10001', async () => {
  // The prompt of an earlier submission (before this dialog opened).
  markUnknown(SCOPE, { now: () => AT - 3_600_000 });
  const { hook } = await mounted();
  const ended = held(ENDED);
  answers.push(ended.reply);
  await submit(hook);
  now = AT + 60_000;
  act(() => clearUnknown(SCOPE));
  expect(readUnknown(SCOPE), 'closed: nothing until the answer').toBeUndefined();
  now = AT + 120_000;
  await act(async () => {
    ended.answer();
  });
  expect(readUnknown(SCOPE)).toEqual({
    page: 'adjustments',
    unknown: true,
    at: '2026-11-18T04:02:00.000Z',
  });
});

it('[AC-F1-08atb-UNIT#8] an enveloped 5xx, then the body edited and sent under the same key, refused 20901 after the dialog was left: the marker stays at the moment of the 5xx', async () => {
  const { hook, failed } = await mounted();
  const conflict = held(KEY_CONFLICT);
  answers.push(SERVER_ERROR, conflict.reply);
  await submit(hook);
  now = AT + 60_000;
  await submit(hook, 'edited');
  hook.unmount();
  now = AT + 120_000;
  await act(async () => {
    conflict.answer();
  });
  const keys = keysSent();
  expect(keys[1], 'the edited body went out under the key of the 5xx').toBe(keys[0]);
  expect(bodiesSent()).toEqual([{ reason: 'r' }, { reason: 'edited' }]);
  expect(failed, 'the left dialog is not told').toHaveBeenCalledTimes(1);
  expect(readUnknown(SCOPE)).toEqual({
    page: 'adjustments',
    unknown: true,
    at: '2026-11-18T04:00:00.000Z',
  });
});

it('[AC-F1-08atb-UNIT#9] after the edited body was refused 20901 the next submission takes a new key and holds on its own: its success keeps the marker of the 5xx, 【关闭】 drops it', async () => {
  const { hook, failed } = await mounted();
  answers.push(SERVER_ERROR, fail(KEY_CONFLICT), DONE);
  await submit(hook);
  now = AT + 60_000;
  await submit(hook, 'edited');
  expect(failed).toHaveBeenCalledTimes(2);
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:00:00.000Z');
  now = AT + 120_000;
  await submit(hook, 'edited');
  const keys = keysSent();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2], '20901: the next submission takes a new key').not.toBe(keys[0]);
  expect(readUnknown(SCOPE)).toEqual({
    page: 'adjustments',
    unknown: true,
    at: '2026-11-18T04:00:00.000Z',
  });
  act(() => clearUnknown(SCOPE));
  expect(readUnknown(SCOPE)).toBeUndefined();
});

it('[AC-F1-08atb-UNIT#10] an enveloped 5xx, then the body edited under the same key and a settled refusal or a success: none of them drops the marker of the 5xx', async () => {
  const { hook } = await mounted();
  answers.push(SERVER_ERROR, SETTLED, DONE);
  await submit(hook);
  now = AT + 60_000;
  await submit(hook, 'edited');
  expect(readUnknown(SCOPE)?.at, 'a settled refusal of the edited body').toBe(
    '2026-11-18T04:00:00.000Z',
  );
  await submit(hook, 'edited again');
  expect(readUnknown(SCOPE)?.at, 'a success of a later body').toBe('2026-11-18T04:00:00.000Z');
});

it('[AC-F1-08atb-UNIT#11] an enveloped 5xx, then the same body under the same key answered 20901: not settled, the marker stays; an unedited replay of a 5xx still settles it', async () => {
  const first = await mounted();
  answers.push(SERVER_ERROR, fail(KEY_CONFLICT));
  await submit(first.hook);
  now = AT + 60_000;
  await submit(first.hook);
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:00:00.000Z');
  first.hook.unmount();
  act(() => clearUnknown(SCOPE));
  // Control: the same body replayed after a 5xx and settled drops the marker (as before).
  const second = await mounted();
  answers.push(SERVER_ERROR, DONE);
  await submit(second.hook);
  expect(readUnknown(SCOPE)?.at).toBe('2026-11-18T04:01:00.000Z');
  await submit(second.hook);
  expect(readUnknown(SCOPE)).toBeUndefined();
});
