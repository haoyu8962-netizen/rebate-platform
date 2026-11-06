// B1-04zzk (D10-725 ①, FU-TB-OAUTH-TIMEOUT), SPEC_REF 18f0015: the station-owner token exchange
// hands the injected transport an AbortSignal that aborts after the union offline timeout
// (unionPolicy('offline').timeoutMs, platform/http), and the exchange is then refused without
// echoing the code, a token or the secret. authorizeUrl calls no transport and is not covered here.
//
// Time runs on vitest fake timers (setTimeout / clearTimeout / performance): a timer of the
// implementation must go through them (a bare setTimeout, or the platform/http systemScheduler).
// The hanging stub never answers; it only rejects once the signal it was handed aborts. Every value
// is synthetic (kit of B1-04zzi); nothing goes on the network.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { unionPolicy } from '../../../../apps/api/src/modules/platform/http/index.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { createTaobaoSiteOAuth } from '../../../../apps/api/src/modules/union/infra/taobao/site-oauth.ts';
import {
  ACCESS,
  APP_ID,
  CODE,
  DAY_S,
  DESCRIPTION,
  NOW,
  REDIRECT,
  REFRESH,
  SECRET,
  UNION_ACCOUNT_ID,
  expectHidden,
  jsonAnswer,
  tokenAnswer,
  trackedCredentials,
  visible,
} from '../taobao-site-oauth/kit.ts';

// Task-local AC labels ([AC-B1-04zzk#n]) identify this task's acceptance points, not business rules.

const TIMEOUT_MS = unionPolicy('offline').timeoutMs;
const INPUT = { appId: APP_ID, unionAccountId: UNION_ACCOUNT_ID };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The provider over `transport`, with the B1-04zzi kit's credentials, clock and redirect. */
function providerOver(transport: UnionTransport) {
  return createTaobaoSiteOAuth({
    credentials: trackedCredentials().credentials,
    transport,
    clock: new FixedClock(NOW),
    redirectUri: REDIRECT,
  });
}

/** A recording transport that answers `answer` (after `delayMs` of fake time when given). */
function answeringTransport(answer: () => UnionTransportResponse, delayMs?: number) {
  const requests: UnionTransportRequest[] = [];
  const abortedAtAnswer: (boolean | undefined)[] = [];
  const transport: UnionTransport = (request) => {
    requests.push(request);
    return new Promise((resolve) => {
      const reply = () => {
        abortedAtAnswer.push(request.signal?.aborted);
        resolve(answer());
      };
      if (delayMs === undefined) reply();
      else setTimeout(reply, delayMs);
    });
  };
  return { requests, abortedAtAnswer, transport };
}

/**
 * A recording transport that never answers: it rejects with `rejection(signal)` once the signal it
 * was handed aborts, and hangs for good without a signal.
 */
function hangingTransport(rejection: (signal: AbortSignal) => unknown) {
  const requests: UnionTransportRequest[] = [];
  const transport: UnionTransport = (request) => {
    requests.push(request);
    return new Promise<UnionTransportResponse>((_resolve, reject) => {
      const signal = request.signal;
      if (!(signal instanceof AbortSignal)) return;
      const abort = () => reject(rejection(signal));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  return { requests, transport };
}

/** Watches a promise without awaiting it (a rejection is recorded, never left unhandled). */
function track(promise: Promise<unknown>) {
  const state: { settled: boolean; fulfilled: boolean; value: unknown; reason: unknown } = {
    settled: false,
    fulfilled: false,
    value: undefined,
    reason: undefined,
  };
  void promise.then(
    (value) => {
      state.settled = true;
      state.fulfilled = true;
      state.value = value;
    },
    (reason: unknown) => {
      state.settled = true;
      state.reason = reason;
    },
  );
  return state;
}

it('[AC-B1-04zzk#1] 换令牌请求带 AbortSignal；即时应答时 signal 未中止、结果与原口径相同', async () => {
  const stub = answeringTransport(() => jsonAnswer(200, tokenAnswer()));
  const oauth = providerOver(stub.transport);
  const outcome = track(oauth.exchange({ ...INPUT, code: CODE }));
  await vi.advanceTimersByTimeAsync(0);
  expect(stub.requests).toHaveLength(1);
  expect(stub.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(stub.abortedAtAnswer).toEqual([false]);
  expect(outcome.settled).toBe(true);
  expect(outcome.fulfilled).toBe(true);
  expect(outcome.value).toEqual({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: new Date(new Date(NOW).getTime() + DAY_S * 1000),
  });
});

it('[AC-B1-04zzk#2] 应答在 timeoutMs − 1 时到达：signal 未中止，交换照常成功', async () => {
  const stub = answeringTransport(() => jsonAnswer(200, tokenAnswer()), TIMEOUT_MS - 1);
  const oauth = providerOver(stub.transport);
  const outcome = track(oauth.exchange({ ...INPUT, code: CODE }));
  await vi.advanceTimersByTimeAsync(0);
  expect(stub.requests).toHaveLength(1);
  const signal = stub.requests[0]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
  expect(stub.abortedAtAnswer).toEqual([false]);
  expect(outcome.settled).toBe(true);
  expect(outcome.fulfilled).toBe(true);
  expect(outcome.value).toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH });
});

const REJECTIONS: [string, (signal: AbortSignal) => unknown][] = [
  [
    'AbortError（报文里带 secret、code 与原文）',
    () => new DOMException(`aborted ${SECRET} ${CODE} ${DESCRIPTION} ${ACCESS}`, 'AbortError'),
  ],
  [
    'TimeoutError（报文里带 secret 与 code）',
    () => new DOMException(`timed out ${SECRET} ${CODE}`, 'TimeoutError'),
  ],
  ['原样抛出 signal.reason', (signal) => signal.reason],
];

it.each(REJECTIONS)(
  '[AC-B1-04zzk#3] 传输挂起不应答、中止时以 %s 拒绝 → 早 1 ms 仍未结束；到 unionPolicy(offline).timeoutMs 时 signal 中止、交换被拒，错误不含 code、令牌、secret',
  async (_label, rejection) => {
    const stub = hangingTransport(rejection);
    const oauth = providerOver(stub.transport);
    const outcome = track(oauth.exchange({ ...INPUT, code: CODE }));
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.requests).toHaveLength(1);
    const signal = stub.requests[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(signal?.aborted, 'aborted before the offline timeout').toBe(false);
    expect(outcome.settled, 'settled before the offline timeout').toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted, 'the signal aborts at the offline timeout').toBe(true);
    expect(outcome.settled, 'the exchange ends at the offline timeout').toBe(true);
    expect(outcome.fulfilled, 'the exchange must be refused').toBe(false);
    expect(stub.requests).toHaveLength(1);

    const error = outcome.reason;
    expect(error).toBeInstanceOf(Error);
    expect(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']).not.toContain(
      (error as Error).name,
    );
    expect((error as Error).message).not.toMatch(/\bNotImplemented\b/);
    expect(error).not.toHaveProperty('cause');
    expectHidden(visible(error), [CODE, SECRET, ACCESS, REFRESH, DESCRIPTION]);
  },
);
