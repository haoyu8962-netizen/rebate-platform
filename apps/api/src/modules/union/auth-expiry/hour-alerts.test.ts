// B1-22zd: the hour alert jobs of one authorization (no database: the queue is a recorder).
// 错实现下怎么红：跳过规则不用于排任务（6 小时授权仍排 h6）、补排窗口不截断（untilMs 之后的也排）、
// 同一轮重复发送同一 key、payload 里写到期时刻的 ISO 串（会被当成 expiry_due 任务），任一都会让下面断言红。
// r2（Codex money r1）：补排不补「已到点但没处理」的节点（丢任务后只剩跳过）、补了更大的已到节点、
// 不看 hour_alert_key 照样重补、超过队列最大延迟（30 天）的节点照排（send 会被拒），任一都会让后两条红。
// r3（Codex money r2）：键只按「等于本节点」判断（已处理 h1 后改配置为 [6] 仍补 h6）、把别的到期时刻
// 或格式不对的键当成已处理、节点 7 与 h1 前缀相同被误认，任一都会让最后一条红。
import { expect, it } from 'vitest';
import type { JobQueue } from '../../platform/index.ts';
import {
  HOUR_JOB_MAX_DELAY_SECONDS,
  JOB_HOUR_ALERT,
  UNION_AUTH_QUEUE,
  hourAlertKey,
  hourAlertMark,
  hourNodeHandled,
  sendHourAlerts,
} from './hour-alerts.ts';

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

it('[B1-22zd][BR-ID-24] 补排：已到点而本次授权未处理的最小节点立即发（不带延迟），更大的已到节点不补，未到点的照常延迟', async () => {
  const t = target(24);
  const expiresMs = t.expiresAt.getTime();
  const base = { trx: null, target: t, hours: [6, 1] };

  // 18h10m 后：h6 已到点、h1 未到；任务丢了（hour_alert_key 为空）→ h6 立即，h1 延迟。
  const lost = recorder();
  const at = NOW + 18 * HOUR + 600_000;
  await sendHourAlerts(lost.queue, { ...base, nowMs: at, catchUp: { doneMark: null } });
  expect(lost.calls.map(([, , p, o]) => [p['hours'], o.delaySeconds])).toEqual([
    [6, undefined],
    [1, Math.ceil((expiresMs - HOUR - at) / 1000)],
  ]);
  expect(lost.calls[0]![3]).toEqual({ trx: null, singletonKey: hourAlertKey(t, 6) });

  // h6 已处理（键是 h6）→ 只排 h1。
  const done = recorder();
  await sendHourAlerts(done.queue, {
    ...base,
    nowMs: at,
    catchUp: { doneMark: hourAlertMark(expiresMs, 6) },
  });
  expect(done.calls.map(([, , p]) => p['hours'])).toEqual([1]);

  // 23h10m 后：h6、h1 都已到，只补 h1（h6 不补发）；已处理 h1 则什么都不发。
  const both = recorder();
  const later = NOW + 23 * HOUR + 600_000;
  await sendHourAlerts(both.queue, { ...base, nowMs: later, catchUp: { doneMark: null } });
  expect(both.calls.map(([, , p, o]) => [p['hours'], o.delaySeconds])).toEqual([[1, undefined]]);
  const quiet = recorder();
  await sendHourAlerts(quiet.queue, {
    ...base,
    nowMs: later,
    catchUp: { doneMark: hourAlertMark(expiresMs, 1) },
  });
  expect(quiet.calls).toEqual([]);

  // 不带 catchUp（新授权排程）不补已到节点；已过到期时刻也不补。
  const plain = recorder();
  await sendHourAlerts(plain.queue, { ...base, nowMs: later });
  expect(plain.calls).toEqual([]);
  const expired = recorder();
  await sendHourAlerts(expired.queue, {
    ...base,
    nowMs: expiresMs,
    catchUp: { doneMark: null },
  });
  expect(expired.calls).toEqual([]);
});

it('[B1-22zd][BR-ID-24] 超过队列最大延迟的节点不排（留给每日补排），以内的照排', async () => {
  const { calls, queue } = recorder();
  // 90 天授权：h720 在 60 天后、h1 在约 90 天后，都超过 30 天 → 不排。
  await sendHourAlerts(queue, { trx: null, target: target(90 * 24), hours: [720, 1], nowMs: NOW });
  expect(calls).toEqual([]);
  // 31 天授权：h720 在 1 天后照排，h1 在 31 天减 1 小时后，超过上限不排。
  await sendHourAlerts(queue, { trx: null, target: target(31 * 24), hours: [720, 1], nowMs: NOW });
  expect(calls.map(([, , p, o]) => [p['hours'], o.delaySeconds])).toEqual([[720, 24 * 3600]]);
  expect(calls.every(([, , , o]) => (o.delaySeconds ?? 0) <= HOUR_JOB_MAX_DELAY_SECONDS)).toBe(
    true,
  );
});

it('[B1-22zd][BR-ID-24] hour_alert_key：同一到期时刻下已处理节点 ≤ 候选节点即不再补发；别的到期时刻或坏格式不算', async () => {
  const expiresMs = NOW + 24 * HOUR;
  const h1 = hourAlertMark(expiresMs, 1);
  expect(hourNodeHandled(h1, expiresMs, 1)).toBe(true);
  expect(hourNodeHandled(h1, expiresMs, 6)).toBe(true);
  expect(hourNodeHandled(hourAlertMark(expiresMs, 6), expiresMs, 1)).toBe(false);
  expect(hourNodeHandled(hourAlertMark(expiresMs, 6), expiresMs, 6)).toBe(true);
  expect(hourNodeHandled(hourAlertMark(expiresMs, 12), expiresMs, 7)).toBe(false);
  expect(hourNodeHandled(hourAlertMark(expiresMs, 7), expiresMs, 12)).toBe(true);
  expect(hourNodeHandled(null, expiresMs, 6)).toBe(false);
  expect(hourNodeHandled(hourAlertMark(expiresMs - HOUR, 1), expiresMs, 6)).toBe(false);
  expect(hourNodeHandled(`${expiresMs}:hx`, expiresMs, 6)).toBe(false);
  expect(hourNodeHandled(`${expiresMs}0:h1`, expiresMs, 6)).toBe(false);

  // 补排：h1 已处理后配置改为 [6]，6 小时内（h6 已到）不补 h6。
  const t = target(24);
  const later = NOW + 23 * HOUR + 600_000;
  const changed = recorder();
  await sendHourAlerts(changed.queue, {
    trx: null,
    target: t,
    hours: [6],
    nowMs: later,
    catchUp: { doneMark: h1 },
  });
  expect(changed.calls).toEqual([]);
  // 上一次授权的键不挡这一次。
  const stale = recorder();
  await sendHourAlerts(stale.queue, {
    trx: null,
    target: t,
    hours: [6],
    nowMs: later,
    catchUp: { doneMark: hourAlertMark(expiresMs - HOUR, 1) },
  });
  expect(stale.calls.map(([, , p, o]) => [p['hours'], o.delaySeconds])).toEqual([[6, undefined]]);
});
