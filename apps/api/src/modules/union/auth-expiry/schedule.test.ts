// B1-22b: the pure day arithmetic of the site authorization check (task §9 判定口径).
import { expect, it } from 'vitest';
import {
  DEFAULT_PROBE_TIME,
  authStatusAt,
  authTotalMs,
  dueNode,
  hourNodeAt,
  hourNodeReached,
  liveDayNodes,
  liveHourNodes,
  parseAlertHours,
  nextCheckSlot,
  parseAlertDays,
  parseProbeCron,
  reachedNode,
  remainingDays,
  statusFor,
} from './schedule.ts';

const ms = (iso: string): number => Date.parse(iso);

it('[BR-ID-24] 节点取 1–999 去重降序，任一不合法整组无效；巡检只认每日 m h * * *', () => {
  expect(parseAlertDays([30, 7, 30, 1])).toEqual([30, 7, 1]);
  for (const bad of [null, [], [0], [1000], [1.5], ['7'], '14,7,1', [14, 0]]) {
    expect(parseAlertDays(bad)).toBeNull();
  }
  expect(parseProbeCron('15 10 * * *')).toEqual({ hour: 10, minute: 15 });
  for (const bad of [null, '*/5 * * * *', '0 24 * * *', '60 9 * * *', '0 9 * * 1']) {
    expect(parseProbeCron(bad)).toBeNull();
  }
});

it('[BR-ID-24] 剩余天数按最近巡检时刻所在 +08 日期计，含闰日', () => {
  const expires = ms('2026-12-29T16:00:00Z');
  expect(remainingDays(expires, ms('2026-12-16T00:59:00Z'), DEFAULT_PROBE_TIME)).toBe(15);
  expect(remainingDays(expires, ms('2026-12-16T01:00:00Z'), DEFAULT_PROBE_TIME)).toBe(14);
  const leap = ms('2028-02-29T16:00:00Z');
  const at1015 = { hour: 10, minute: 15 };
  expect(remainingDays(leap, ms('2028-02-29T02:14:59.999Z'), at1015)).toBe(2);
  expect(remainingDays(leap, ms('2028-02-29T02:15:00Z'), at1015)).toBe(1);
});

it('[BR-ID-24] 下一巡检时刻严格晚于当前，标签为 +08 分钟', () => {
  const at1015 = { hour: 10, minute: 15 };
  expect(nextCheckSlot(ms('2026-12-16T01:00:00Z'), at1015)).toEqual({
    dueMs: ms('2026-12-16T02:15:00Z'),
    label: '2026-12-16T10:15',
  });
  expect(nextCheckSlot(ms('2026-12-16T02:15:00Z'), at1015)).toEqual({
    dueMs: ms('2026-12-17T02:15:00Z'),
    label: '2026-12-17T10:15',
  });
  expect(nextCheckSlot(ms('2028-02-28T16:00:00Z'), DEFAULT_PROBE_TIME).label).toBe(
    '2028-02-29T09:00',
  );
});

it('[BR-ID-24] 只提醒已到达的最小节点，跳过的不补、已发的不倒退', () => {
  const nodes = [14, 7, 1];
  expect(dueNode(15, nodes, 'none')).toBeNull();
  expect(dueNode(14, nodes, 'none')).toBe(14);
  expect(dueNode(5, nodes, 'none')).toBe(7);
  expect(dueNode(5, nodes, 'd7')).toBeNull();
  expect(dueNode(1, nodes, 'd7')).toBe(1);
  expect(dueNode(14, [30, 14, 7, 1], 'd7')).toBeNull();
  expect(dueNode(1, nodes, 'expired')).toBeNull();
  expect(reachedNode(4, nodes)).toBe(7);
  expect(statusFor(14, nodes)).toBe('expiring');
  expect(statusFor(15, nodes)).toBe('active');
});

// B1-22zd: 错实现下怎么红——缺省或非法不回退 [6, 1]（或空数组也回退默认）则第一条红；
// 721 / 0 / 1.5 / '6' 被接受、720 被拒，同样第一条红。
it('[B1-22zd][BR-ID-24] 小时节点取 1–720 去重降序；缺省或任一非法回退 [6, 1]，空数组关闭', () => {
  expect(parseAlertHours(null)).toEqual([6, 1]);
  expect(parseAlertHours(undefined)).toEqual([6, 1]);
  expect(parseAlertHours([])).toEqual([]);
  expect(parseAlertHours([1, 720, 1])).toEqual([720, 1]);
  expect(parseAlertHours([3])).toEqual([3]);
  for (const bad of ['6', [3, 0], [3, 721], [3, 1.5], [3, '6'], { 0: 6 }]) {
    expect(parseAlertHours(bad)).toEqual([6, 1]);
  }
});

// 错实现下怎么红：提前量与总时长比较用 > 而非 ≥（恰好相等不跳过）则 d1 / h1 两处断言红；
// 总时长未知（auth_renewed_at 为空）也跳过则 null 那组红；状态不计小时节点则最后一组红。
it('[B1-22zd][BR-ID-24] 提前量不小于总时长的节点跳过（恰好相等也跳过），总时长未知不跳过', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  expect(authTotalMs(DAY, 0)).toBe(DAY);
  expect(authTotalMs(DAY, null)).toBeNull();
  expect(authTotalMs(DAY, DAY)).toBeNull();
  expect(liveDayNodes([14, 7, 1], DAY)).toEqual([]);
  expect(liveDayNodes([14, 7, 1], 7 * DAY)).toEqual([1]);
  expect(liveDayNodes([14, 7, 1], 7 * DAY + 60_000)).toEqual([7, 1]);
  expect(liveDayNodes([14, 7, 1], null)).toEqual([14, 7, 1]);
  expect(liveHourNodes([6, 1], HOUR)).toEqual([]);
  expect(liveHourNodes([6, 1], HOUR + 60_000)).toEqual([1]);
  expect(liveHourNodes([6, 1], 6 * HOUR)).toEqual([1]);
  expect(liveHourNodes([6, 1], null)).toEqual([6, 1]);

  const renewed = ms('2026-11-22T09:29:00Z');
  const expires = renewed + DAY;
  const judge = (nowMs: number, renewedMs: number | null) =>
    authStatusAt({
      expiresMs: expires,
      renewedMs,
      nowMs,
      days: [14, 7, 1],
      hours: [6, 1],
      probeTime: DEFAULT_PROBE_TIME,
    });
  expect(judge(renewed, renewed)).toBe('active');
  expect(judge(renewed, null)).toBe('expiring');
  expect(judge(expires - 6 * HOUR - 1, renewed)).toBe('active');
  expect(judge(expires - 6 * HOUR, renewed)).toBe('expiring');
  expect(hourNodeReached(expires, expires - HOUR, [1])).toBe(true);
  expect(hourNodeAt(expires, 6)).toBe(expires - 6 * HOUR);
});
