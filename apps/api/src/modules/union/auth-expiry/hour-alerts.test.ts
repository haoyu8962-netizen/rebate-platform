// B1-22zd: the hour alert jobs of one authorization (no database: the queue is a recorder).
// 错实现下怎么红：跳过规则不用于排任务（6 小时授权仍排 h6）、补排窗口不截断（untilMs 之后的也排）、
// 同一轮重复发送同一 key、payload 里写到期时刻的 ISO 串（会被当成 expiry_due 任务），任一都会让下面断言红。
import { expect, it } from 'vitest';
import type { JobQueue } from '../../platform/index.ts';
import { JOB_HOUR_ALERT, UNION_AUTH_QUEUE, hourAlertKey, sendHourAlerts } from './hour-alerts.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-22T01:30:00.000Z');

function recorder() {
  const calls: Parameters<JobQueue['send']>[] = [];
  const queue: Pick<JobQueue, 'send'> = {
    send: async (...args) => {
      calls.push(args);
      return 'job';
    },
  };
  return { calls, queue };
}

function target(totalHours: number) {
  const expiresAt = new Date(NOW + totalHours * HOUR);
  return { appId: 'unit-app', unionAccountId: 'unit-account', expiresAt, renewedAt: new Date(NOW) };
}

it('[B1-22zd][BR-ID-24] 每个未跳过的未来小时节点一条单例任务，delay 对到节点时刻，payload 不含 ISO 到期', async () => {
  const { calls, queue } = recorder();
  const t = target(24);
  await sendHourAlerts(queue, { trx: null, target: t, hours: [6, 1], nowMs: NOW });
  expect(calls.map(([q, name]) => [q, name])).toEqual([
    [UNION_AUTH_QUEUE, JOB_HOUR_ALERT],
    [UNION_AUTH_QUEUE, JOB_HOUR_ALERT],
  ]);
  expect(calls.map(([, , , o]) => o.delaySeconds)).toEqual([18 * 3600, 23 * 3600]);
  expect(calls.map(([, , , o]) => o.singletonKey)).toEqual([
    hourAlertKey(t, 6),
    hourAlertKey(t, 1),
  ]);
  expect(calls[0]![2]).toEqual({
    app_id: 'unit-app',
    union_account_id: 'unit-account',
    hours: 6,
    expires_ms: t.expiresAt.getTime(),
    renewed_ms: NOW,
  });
  expect(JSON.stringify(calls)).not.toContain(t.expiresAt.toISOString());
});

it('[B1-22zd][BR-ID-24] 6 小时授权只排 h1；补排窗口外与已过的节点不排；同一轮同 key 只发一次', async () => {
  const short = recorder();
  await sendHourAlerts(short.queue, { trx: null, target: target(6), hours: [6, 1], nowMs: NOW });
  expect(short.calls.map(([, , p]) => p['hours'])).toEqual([1]);

  const windowed = recorder();
  const sent = new Set<string>();
  const t = target(28);
  const input = { trx: null, target: t, hours: [6, 1], nowMs: NOW, untilMs: NOW + 24 * HOUR, sent };
  await sendHourAlerts(windowed.queue, input);
  await sendHourAlerts(windowed.queue, input);
  expect(windowed.calls.map(([, , p]) => p['hours'])).toEqual([6]);

  const late = recorder();
  await sendHourAlerts(late.queue, {
    trx: null,
    target: target(24),
    hours: [6, 1],
    nowMs: NOW + 20 * HOUR,
  });
  expect(late.calls.map(([, , p]) => p['hours'])).toEqual([1]);
});
