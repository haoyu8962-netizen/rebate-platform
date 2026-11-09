// B2-09zj: createMetricsRegistry({ entry, …, collectWithdrawalFail? }). Only entry 'worker' with a
// collectWithdrawalFail function exports the three payout failure gauges couli_withdrawals_w6_today,
// couli_withdrawals_w5w6_today and couli_withdrawals_w6_streak: # HELP and # TYPE gauge lines, one
// sample per app_id of each snapshot record (only label app_id), filled at scrape time (render),
// never by a resident polling loop. A rejected or throwing collection rejects render() (no 0 is made
// up, no older value reused). The surfaces of B1-01zzh, B1-01zzi, B1-01zzp, B2-05o, B2-09j and
// B2-09ze stay as they were.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type AutoPayoutDailySnapshot,
  type WithdrawalFailSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { FUND_METRIC_NAMES, fundFromText, fundNamesIn } from '../../fund-metrics/kit.ts';
import { FIRST, WORKER } from '../../metrics-followups/kit.ts';
import { AUTO_METRIC_NAMES, autoFromText, autoNamesIn } from '../fund-alerts/kit.ts';
import { overdueValue } from '../review-overdue/kit.ts';
import {
  businessNamesIn,
  expectProcessMetrics,
  families,
  gauge,
  METRIC_KEYS,
  METRIC_NAMES,
} from '../kit.ts';
import { waterLowGauge } from '../water-level/water-harness.ts';
import { waterStaleGauge } from '../water-stale/stale-harness.ts';
import {
  FAIL_METRIC_NAMES,
  W5W6_TODAY_METRIC,
  W6_STREAK_METRIC,
  W6_TODAY_METRIC,
  failFromText,
  helpOf,
  mentionsAnyFail,
} from './fail-harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

const AUTO: AutoPayoutDailySnapshot = {
  totalFen: { fail_a: 1_000 },
  capFen: { fail_a: 2_000 },
};

/** Different app sets per gauge: each record is rendered as it is. */
const SNAPSHOT: WithdrawalFailSnapshot = {
  w6Today: { fail_a: 1, fail_b: 0 },
  w5w6Today: { fail_a: 30, fail_b: 12 },
  w6Streak: { fail_a: 1, fail_b: 0, fail_c: 3 },
};

it('[AC-B2-09zj#1] worker 的 registry 在 scrape 时调 collectWithdrawalFail：三个指标各有 # HELP 与 # TYPE gauge，每个 app_id 一个样本、只有 app_id 标签、值与快照一致（三个记录的 app 集合可以不同）；其余指标（含水位两个）照旧', async () => {
  const collectWithdrawalFail = vi.fn(async (): Promise<WithdrawalFailSnapshot> => SNAPSHOT);
  const registry = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    collectWaterLow: async () => ({ waterLow: { fail_a: 0 } }),
    collectWaterStale: async () => ({ waterStale: { fail_a: 1 } }),
    collectWithdrawalFail,
  });
  expect(collectWithdrawalFail).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collectWithdrawalFail).toHaveBeenCalledTimes(1);

  for (const metric of FAIL_METRIC_NAMES) {
    expect(families(text).get(metric), `# TYPE of ${metric}`).toBe('gauge');
    expect(helpOf(text, metric).length, `# HELP of ${metric}`).toBeGreaterThan(0);
  }
  expect(failFromText(text)).toEqual(SNAPSHOT);
  expect(text).toMatch(new RegExp(`^${W6_TODAY_METRIC}\\{app_id="fail_a"\\} 1$`, 'm'));
  expect(text).toMatch(new RegExp(`^${W5W6_TODAY_METRIC}\\{app_id="fail_a"\\} 30$`, 'm'));
  expect(text).toMatch(new RegExp(`^${W6_STREAK_METRIC}\\{app_id="fail_c"\\} 3$`, 'm'));

  // The surfaces of B1-01zzh, B1-01zzi, B1-01zzp, B2-05o, B2-09j and B2-09ze are unchanged.
  for (const key of METRIC_KEYS) expect(gauge(text, key), key).toEqual(WORKER[key]);
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
  expect(fundFromText(text)).toEqual(FIRST);
  expect(autoNamesIn(text)).toEqual(AUTO_METRIC_NAMES);
  expect(autoFromText(text)).toEqual(AUTO);
  expect(overdueValue(text)).toBe(3);
  expect(waterLowGauge(text)).toEqual({ fail_a: 0 });
  expect(waterStaleGauge(text)).toEqual({ fail_a: 1 });
  expectProcessMetrics(text);
});

it('[AC-B2-09zj#2] 样本跟随每次快照、不常驻轮询：消失的 app 没有样本（不留旧值），快照为空时三个指标只有 # TYPE 行没有样本', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collectWithdrawalFail = vi.fn<() => Promise<WithdrawalFailSnapshot>>();
  const second: WithdrawalFailSnapshot = {
    w6Today: { fail_b: 2 },
    w5w6Today: { fail_b: 21 },
    w6Streak: { fail_b: 2 },
  };
  const empty: WithdrawalFailSnapshot = { w6Today: {}, w5w6Today: {}, w6Streak: {} };
  collectWithdrawalFail
    .mockResolvedValueOnce(SNAPSHOT)
    .mockResolvedValueOnce(second)
    .mockResolvedValueOnce(empty);
  const worker = createMetricsRegistry({ entry: 'worker', collectWithdrawalFail });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collectWithdrawalFail).not.toHaveBeenCalled();
  vi.useRealTimers();

  expect(failFromText(await worker.render())).toEqual(SNAPSHOT);
  expect(failFromText(await worker.render())).toEqual(second);
  const text = await worker.render();
  for (const metric of FAIL_METRIC_NAMES) {
    expect(families(text).get(metric), `${metric}: the family stays`).toBe('gauge');
  }
  expect(failFromText(text), 'no sample').toEqual(empty);
  expect(collectWithdrawalFail).toHaveBeenCalledTimes(3);
});

it('[AC-B2-09zj#3] 只在 worker 且给了 collectWithdrawalFail 时出现：api / stream / admin / payout 给了也不调用、不出指标名；worker 不给也没有', async () => {
  // Baseline first: the worker with collectWithdrawalFail does export them.
  const baseline = await createMetricsRegistry({
    entry: 'worker',
    collectWithdrawalFail: async () => SNAPSHOT,
  }).render();
  expect(mentionsAnyFail(baseline), 'worker baseline').toBe(true);

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collectWithdrawalFail = vi.fn(async () => SNAPSHOT);
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collectWithdrawalFail }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(mentionsAnyFail(text), entry).toBe(false);
    }
    expect(collectWithdrawalFail, entry).not.toHaveBeenCalled();
  }
  for (const registry of [
    createMetricsRegistry({ entry: 'worker' }),
    createMetricsRegistry({
      entry: 'worker',
      collect: async () => WORKER,
      collectFund: async () => FIRST,
      collectAutoPayout: async () => AUTO,
      collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
      collectWaterLow: async () => ({ waterLow: { fail_a: 1 } }),
      collectWaterStale: async () => ({ waterStale: { fail_a: 1 } }),
    }),
  ]) {
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(mentionsAnyFail(text)).toBe(false);
  }
});

it('[AC-B2-09zj#4] collectWithdrawalFail 拒绝或同步抛出时 render() 拒绝（抓取失败可见）：不把值编造成 0，也不沿用上一次的值；恢复后下一次 scrape 取新值', async () => {
  const failure = new Error('payout failure collection failed');
  const rejecting = vi.fn(async (): Promise<WithdrawalFailSnapshot> => {
    throw failure;
  });
  const failing = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    collectWaterLow: async () => ({ waterLow: {} }),
    collectWaterStale: async () => ({ waterStale: {} }),
    collectWithdrawalFail: rejecting,
  });
  await expect(failing.render()).rejects.toBe(failure);
  expect(rejecting).toHaveBeenCalledTimes(1);

  const throwing = createMetricsRegistry({
    entry: 'worker',
    collectWithdrawalFail: (): Promise<WithdrawalFailSnapshot> => {
      throw failure;
    },
  });
  await expect(throwing.render()).rejects.toBe(failure);

  const recovered: WithdrawalFailSnapshot = {
    w6Today: { fail_a: 0 },
    w5w6Today: { fail_a: 31 },
    w6Streak: { fail_a: 0 },
  };
  const collectWithdrawalFail = vi.fn<() => Promise<WithdrawalFailSnapshot>>();
  collectWithdrawalFail
    .mockResolvedValueOnce(SNAPSHOT)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(recovered);
  const worker = createMetricsRegistry({ entry: 'worker', collectWithdrawalFail });
  expect(failFromText(await worker.render())).toEqual(SNAPSHOT);
  await expect(worker.render()).rejects.toBe(failure);
  expect(failFromText(await worker.render())).toEqual(recovered);
  expect(collectWithdrawalFail).toHaveBeenCalledTimes(3);
});
