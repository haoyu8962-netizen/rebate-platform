import { afterEach, expect, it } from 'vitest';
import { clearUnknown, markUnknown, readUnknown, subscribeMarkers } from './marker.ts';
import { beijingMoment } from './UnknownMarkerBanner.tsx';

const AT = Date.parse('2026-11-18T04:00:00.000Z');
const clock = { now: () => AT };
const FIRST = { page: 'withdrawals', account: 'admin-1' } as const;

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

it('[AC-F1-08at-UNIT#1] keeps exactly {page, unknown, at} for the page and account, nothing else', () => {
  markUnknown(FIRST, clock);
  expect(window.sessionStorage.length).toBe(1);
  const key = window.sessionStorage.key(0)!;
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toEqual({
    page: 'withdrawals',
    unknown: true,
    at: '2026-11-18T04:00:00.000Z',
  });
  expect(readUnknown(FIRST)).toEqual({
    page: 'withdrawals',
    unknown: true,
    at: '2026-11-18T04:00:00.000Z',
  });
  expect(window.localStorage.length).toBe(0);
});

it('[AC-F1-08at-UNIT#2] another account or page sees nothing; without an account nothing is kept', () => {
  markUnknown(FIRST, clock);
  expect(readUnknown({ page: 'withdrawals', account: 'admin-2' })).toBeUndefined();
  expect(readUnknown({ page: 'adjustments', account: 'admin-1' })).toBeUndefined();
  window.sessionStorage.clear();
  markUnknown({ page: 'withdrawals', account: undefined }, clock);
  expect(window.sessionStorage.length).toBe(0);
  expect(readUnknown({ page: 'withdrawals', account: undefined })).toBeUndefined();
});

it('[AC-F1-08at-UNIT#3] clearing drops the item and tells the listeners', () => {
  let calls = 0;
  const stop = subscribeMarkers(() => {
    calls += 1;
  });
  markUnknown(FIRST, clock);
  clearUnknown(FIRST);
  stop();
  expect(calls).toBe(2);
  expect(window.sessionStorage.length).toBe(0);
  expect(readUnknown(FIRST)).toBeUndefined();
});

it('[AC-F1-08at-UNIT#4] a malformed stored item counts as none', () => {
  markUnknown(FIRST, clock);
  const key = window.sessionStorage.key(0)!;
  for (const raw of [
    'not json',
    '[]',
    '{"page":"withdrawals","unknown":true}',
    '{"page":"withdrawals","unknown":"yes","at":"2026-11-18T04:00:00.000Z"}',
    '{"page":"adjustments","unknown":true,"at":"2026-11-18T04:00:00.000Z"}',
    '{"page":"withdrawals","unknown":true,"at":"yesterday"}',
    '{"page":"withdrawals","unknown":true,"at":"2026-11-18T04:00:00.000Z","amount":1}',
  ]) {
    window.sessionStorage.setItem(key, raw);
    expect(readUnknown(FIRST), raw).toBeUndefined();
  }
});

it('[AC-F1-08at-UNIT#5] the moment shows in Beijing time as YYYY-MM-DD HH:mm:ss', () => {
  expect(beijingMoment('2026-11-18T04:00:00.000Z')).toBe('2026-11-18 12:00:00');
  expect(beijingMoment('2026-12-31T16:30:05.000Z')).toBe('2027-01-01 00:30:05');
  expect(beijingMoment('bad')).toBe('');
});
