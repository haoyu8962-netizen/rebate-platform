import { expect, it } from 'vitest';
import {
  intervalSeconds,
  isRescanWindowMinutes,
  nextWindow,
  parseInstantMs,
  RESCAN_MAX_WINDOW_MINUTES,
  windowSingletonKey,
} from './sync-window.ts';

const NOW = new Date('2026-10-17T02:00:00.000Z');
const CAP = 30 * 60_000;

it('[AC-B1-08g#u1] nextWindow 按上限切分、截到 now、空窗返回 null', () => {
  const start = Date.parse('2026-10-17T00:00:00.000Z');
  expect(nextWindow(start, NOW, CAP)).toEqual({
    window_start: '2026-10-17T00:00:00.000Z',
    window_end: '2026-10-17T00:30:00.000Z',
  });
  expect(nextWindow(Date.parse('2026-10-17T01:50:00.000Z'), NOW, CAP)?.window_end).toBe(
    '2026-10-17T02:00:00.000Z',
  );
  expect(nextWindow(NOW.getTime(), NOW, CAP)).toBeNull();
  expect(nextWindow(NOW.getTime() + 1, NOW, CAP)).toBeNull();
});

it('[AC-B1-08g#u2] parseInstantMs 拒绝非 ISO 值', () => {
  expect(() => parseInstantMs('not-a-date', 'x')).toThrow(TypeError);
  expect(() => parseInstantMs(42, 'x')).toThrow(TypeError);
  expect(parseInstantMs('2026-10-17T00:00:00.000Z', 'x')).toBe(Date.UTC(2026, 9, 17));
});

it('[AC-B1-08g#u3] 间隔配置只接受正整数秒，其余取默认 60', () => {
  expect(intervalSeconds(undefined)).toBe(60);
  expect(intervalSeconds(0)).toBe(60);
  expect(intervalSeconds(1.5)).toBe(60);
  expect(intervalSeconds('abc')).toBe(60);
  expect(intervalSeconds(120)).toBe(120);
  expect(intervalSeconds('90')).toBe(90);
});

it('[AC-B1-08g#u4] singletonKey 带全部流维度与窗口起点', () => {
  expect(
    windowSingletonKey({
      platform: 'pdd',
      union_account_id: 'acc',
      query_kind: 'increment',
      scene: '-',
      window_start: '2026-10-17T00:00:00.000Z',
    }),
  ).toBe('pdd:acc:increment:-:2026-10-17T00:00:00.000Z');
});

it('[AC-B1-04zzz#u1] 回扫窗口分钟只接受 1～180 的整数，181 及以上与其它非法值一样不合格', () => {
  expect(RESCAN_MAX_WINDOW_MINUTES).toBe(180);
  expect(isRescanWindowMinutes(1)).toBe(true);
  expect(isRescanWindowMinutes(60)).toBe(true);
  expect(isRescanWindowMinutes(180)).toBe(true);
  expect(isRescanWindowMinutes(181)).toBe(false);
  expect(isRescanWindowMinutes(10_000)).toBe(false);
  expect(isRescanWindowMinutes(0)).toBe(false);
  expect(isRescanWindowMinutes(-5)).toBe(false);
  expect(isRescanWindowMinutes(1.5)).toBe(false);
  expect(isRescanWindowMinutes('60')).toBe(false);
  expect(isRescanWindowMinutes(null)).toBe(false);
});
