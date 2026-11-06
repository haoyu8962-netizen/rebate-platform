// Unit tests of the pure feedback rules (no database).
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  DEFAULT_DAILY_LIMIT,
  chinaDayOf,
  dailyLimit,
  feedbackEnabled,
  isUuid,
  recordedUserId,
  requestAppOfDevice,
  retryAfterSeconds,
} from './rules.ts';

const at = (iso: string): Date => new FixedClock(iso).now();

it('[AC-B1-28p] feedback.enabled: only an explicit false turns it off; absent or malformed is on', () => {
  expect(feedbackEnabled(false)).toBe(false);
  expect(feedbackEnabled(true)).toBe(true);
  expect(feedbackEnabled(undefined)).toBe(true);
  expect(feedbackEnabled('false')).toBe(true);
  expect(feedbackEnabled(0)).toBe(true);
});

it('[AC-B1-28p] daily limit: a whole number ≥ 1, else the default 20', () => {
  expect(DEFAULT_DAILY_LIMIT).toBe(20);
  expect(dailyLimit(3)).toBe(3);
  expect(dailyLimit(1)).toBe(1);
  for (const value of [undefined, null, 0, -1, 2.5, '5', Number.NaN, 2 ** 60]) {
    expect(dailyLimit(value)).toBe(20);
  }
});

it('[AC-B1-28p] the natural day is +08:00: 07:30 and 23:59:59 +08:00 share a day across the UTC date line', () => {
  const early = chinaDayOf(at('2026-11-06T07:30:00+08:00'));
  const late = chinaDayOf(at('2026-11-06T23:59:59+08:00'));
  expect(early).toEqual(late);
  expect(early.start.toISOString()).toBe('2026-11-05T16:00:00.000Z');
  expect(early.end.toISOString()).toBe('2026-11-06T16:00:00.000Z');
  expect(chinaDayOf(at('2026-11-07T00:00:00+08:00')).start.toISOString()).toBe(
    '2026-11-06T16:00:00.000Z',
  );
});

it('[AC-B1-28p] Retry-After counts whole seconds to the next +08:00 midnight, at least 1', () => {
  expect(retryAfterSeconds(at('2026-11-06T23:59:59+08:00'))).toBe(1);
  expect(retryAfterSeconds(at('2026-11-06T23:59:59.500+08:00'))).toBe(1);
  expect(retryAfterSeconds(at('2026-11-06T00:00:00+08:00'))).toBe(86_400);
  expect(retryAfterSeconds(at('2026-11-06T10:00:00+08:00'))).toBe(14 * 3600);
});

it('[AC-B1-28p] link ids that cannot be a uuid never reach the database', () => {
  expect(isUuid('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70')).toBe(true);
  expect(isUuid('0199A3B4-5C6D-7E8F-9A0B-1C2D3E4F5A70')).toBe(true);
  expect(isUuid('x')).toBe(false);
  expect(isUuid('0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70 ')).toBe(false);
});

it('[AC-B1-28p#32] recordedUserId: only an account with deletion status none keeps its user_id', () => {
  expect(recordedUserId('u', 'none')).toBe('u');
  expect(recordedUserId('u', 'processing')).toBeNull();
  expect(recordedUserId('u', 'done')).toBeNull();
  expect(recordedUserId('u', undefined)).toBeNull();
  expect(recordedUserId(null, 'none')).toBeNull();
});

it('[AC-B1-28p#35] requestAppOfDevice: the device must belong to the token app or the guest X-App-Id', () => {
  expect(requestAppOfDevice('a', 'a', 'a')).toBe('a');
  expect(requestAppOfDevice('b', 'a', 'a')).toBeNull();
  expect(requestAppOfDevice('b', 'a', 'b')).toBeNull();
  expect(requestAppOfDevice('b', undefined, 'a')).toBeNull();
  expect(requestAppOfDevice('a', undefined, 'a')).toBe('a');
  expect(requestAppOfDevice('a', undefined, undefined)).toBe('a');
  expect(requestAppOfDevice('a', undefined, ['a', 'b'])).toBe('a');
});
