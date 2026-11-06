// 维权 / 违规的定时器（规划/02 §7.1：每 30 分钟拉维权退款与处罚订单，每天回扫近 60 天；任务书第 9 节第 3、6、7
// 条）。构造与 start() 都不投递；增量与违规 30 分钟一轮；回扫一天走完 60 天、3 小时一窗，即每 180 秒一跳；
// 没有维权、违规来源的平台不起定时器；一轮失败只记日志，后面照常；stop() 之后不再投递、不留定时器。
import { afterEach, expect, it, vi } from 'vitest';
import { createRightsSyncScheduler } from '../../../../apps/api/src/modules/orders/application/rights-sync.ts';
import {
  HOUR_MS,
  INCREMENT,
  NOW_MS,
  PUNISH_JOB,
  RESCAN_TICK_MS,
  ROUND_MS,
  fixture,
  iso,
  taobaoAccount,
} from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('[AC-B1-04zza#17] 构造与启动零投递；30 分钟一轮投维权增量窗与违规窗；停止后不再投递、不留定时器', async () => {
  vi.useFakeTimers();
  const f = fixture({ cursors: { [INCREMENT]: iso(NOW_MS - 10 * HOUR_MS) } });
  const scheduler = createRightsSyncScheduler(f.scheduler);
  expect(f.send).not.toHaveBeenCalled();
  const loop = scheduler.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ROUND_MS - 1);
    expect(f.rightsOf('-')).toEqual([]);
    expect(f.payloads(PUNISH_JOB)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.rightsOf('-')).toHaveLength(1);
    expect(f.payloads(PUNISH_JOB)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ROUND_MS);
    expect(f.rightsOf('-')).toHaveLength(2);
    expect(f.payloads(PUNISH_JOB)).toHaveLength(2);
  } finally {
    await loop.stop();
  }
  const sent = f.send.mock.calls.length;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(4 * HOUR_MS);
  expect(f.send).toHaveBeenCalledTimes(sent);
});

it('[AC-B1-04zza#18] 回扫每 180 秒一跳，一天走完近 60 天；不投违规窗', async () => {
  vi.useFakeTimers();
  const f = fixture({ cursors: { [INCREMENT]: iso(NOW_MS - 10 * HOUR_MS) } });
  const loop = createRightsSyncScheduler(f.scheduler).start();
  try {
    await vi.advanceTimersByTimeAsync(RESCAN_TICK_MS - 1);
    expect(f.rightsOf('rescan')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.rightsOf('rescan')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RESCAN_TICK_MS);
    // 假的游标没推进：同一窗再投一次也算一跳。
    expect(f.rightsOf('rescan')).toHaveLength(2);
    expect(f.payloads(PUNISH_JOB)).toEqual([]);
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zza#19] 没有维权、违规来源的平台不起定时器；有来源的才起', async () => {
  vi.useFakeTimers();
  const none = fixture({ capable: { taobao: 'none', jd: 'missing', pdd: 'missing' } });
  const idle = createRightsSyncScheduler(none.scheduler).start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(none.send).not.toHaveBeenCalled();
  } finally {
    await idle.stop();
  }

  const f = fixture({ capable: { taobao: 'both' } });
  const loop = createRightsSyncScheduler(f.scheduler).start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  } finally {
    await loop.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-04zza#20] 一轮失败只记日志，下一轮照常投递', async () => {
  vi.useFakeTimers();
  const f = fixture({ cursors: { [INCREMENT]: iso(NOW_MS - 10 * HOUR_MS) } });
  f.listEnabledAccounts.mockRejectedValue(new Error('synthetic round failure'));
  const loop = createRightsSyncScheduler(f.scheduler).start();
  try {
    await vi.advanceTimersByTimeAsync(ROUND_MS);
    expect(f.rightsOf('-')).toEqual([]);
    expect(f.logger.error).toHaveBeenCalled();
    f.listEnabledAccounts.mockResolvedValue([taobaoAccount]);
    await vi.advanceTimersByTimeAsync(ROUND_MS);
    expect(f.rightsOf('-')).toHaveLength(1);
    expect(f.payloads(PUNISH_JOB)).toHaveLength(1);
  } finally {
    await loop.stop();
  }
});
