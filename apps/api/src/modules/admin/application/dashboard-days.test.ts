import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { dueWindow, newestDueDay, shiftDay, yesterdayOf } from './dashboard-days.ts';

const at = (instant: string): Date => new FixedClock(instant).now();

it('[AC-B1-34q-UNIT#1] D 在 D+1 00:10:00 +08:00 到期：前一毫秒最新到期日仍是 D−1', () => {
  // 2032-06-16 00:09:59.999 +08:00 / 00:10:00.000 +08:00.
  expect(newestDueDay(at('2032-06-15T16:09:59.999Z'))).toBe('2032-06-14');
  expect(newestDueDay(at('2032-06-15T16:10:00.000Z'))).toBe('2032-06-15');
});

it('[AC-B1-34q-UNIT#2] 窗口是最近 7 个到期日，从早到晚，跨月照算', () => {
  expect(dueWindow(at('2032-07-02T18:00:00.000Z'))).toEqual([
    '2032-06-26',
    '2032-06-27',
    '2032-06-28',
    '2032-06-29',
    '2032-06-30',
    '2032-07-01',
    '2032-07-02',
  ]);
});

it('[AC-B1-34q-UNIT#3] 昨天按 now 的 +08:00 会计日取', () => {
  expect(yesterdayOf(at('2032-06-15T15:59:59.999Z'))).toBe('2032-06-14');
  expect(yesterdayOf(at('2032-06-15T16:00:00.000Z'))).toBe('2032-06-15');
  // 2033-01-01 00:00 +08:00: yesterday is the last day of 2032.
  expect(yesterdayOf(at('2032-12-31T16:00:00.000Z'))).toBe('2032-12-31');
});

it('[AC-B1-34q-UNIT#4] shiftDay 跨月、跨年、闰日', () => {
  const like = at('2032-01-01T00:00:00.000Z');
  expect(shiftDay('2032-03-01', -1, like)).toBe('2032-02-29');
  expect(shiftDay('2032-12-31', 1, like)).toBe('2033-01-01');
  expect(shiftDay('2032-06-15', -6, like)).toBe('2032-06-09');
  expect(() => shiftDay('2032-02-30', 0, like)).toThrow(RangeError);
});
