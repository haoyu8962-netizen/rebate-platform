// B2-09ze: createMetricsRegistry({ entry, …, collectWaterStale? }). Only entry 'worker' with a
// collectWaterStale function exports couli_payout_water_stale: # HELP and # TYPE gauge lines, one
// sample per app_id of the snapshot, filled at scrape time (render), never by a resident polling loop.
// A rejected or throwing collection rejects render() (no 0 is made up, no older value reused). The
// surfaces of B1-01zzh, B1-01zzi, B1-01zzp, B2-05o and B2-09j stay as they were.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type AutoPayoutDailySnapshot,
  type WaterStaleSnapshot,
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
import {
  WATER_STALE_METRIC,
  mentionsWaterStale,
  waterStaleGauge,
  waterStaleHelp,
} from './stale-harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

const AUTO: AutoPayoutDailySnapshot = {
  totalFen: { stale_a: 1_000 },
  capFen: { stale_a: 2_000 },
};

it('[AC-B2-09ze#1] worker 的 registry 在 scrape 时调 collectWaterStale：有 # HELP 与 # TYPE couli_payout_water_stale gauge，每个 app_id 一个样本、只有 app_id 标签、值与快照一致；其余指标（含 couli_payout_water_low）照旧', async () => {
  const collectWaterStale = vi.fn(async (): Promise<WaterStaleSnapshot> => ({
    waterStale: { stale_a: 1, stale_b: 0 },
  }));
  const registry = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    collectWaterLow: async () => ({ waterLow: { stale_a: 0 } }),
    collectWaterStale,
  });
  expect(collectWaterStale).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collectWaterStale).toHaveBeenCalledTimes(1);

  expect(families(text).get(WATER_STALE_METRIC), `# TYPE of ${WATER_STALE_METRIC}`).toBe('gauge');
  expect(waterStaleHelp(text).length, `# HELP of ${WATER_STALE_METRIC}`).toBeGreaterThan(0);
  expect(waterStaleGauge(text)).toEqual({ stale_a: 1, stale_b: 0 });
  expect(text).toMatch(new RegExp(`^${WATER_STALE_METRIC}\\{app_id="stale_a"\\} 1$`, 'm'));
  expect(text).toMatch(new RegExp(`^${WATER_STALE_METRIC}\\{app_id="stale_b"\\} 0$`, 'm'));

  // The surfaces of B1-01zzh, B1-01zzi, B1-01zzp, B2-05o and B2-09j are unchanged next to it.
  for (const key of METRIC_KEYS) expect(gauge(text, key), key).toEqual(WORKER[key]);
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
  expect(fundFromText(text)).toEqual(FIRST);
  expect(autoNamesIn(text)).toEqual(AUTO_METRIC_NAMES);
  expect(autoFromText(text)).toEqual(AUTO);
  expect(overdueValue(text)).toBe(3);
  expect(waterLowGauge(text)).toEqual({ stale_a: 0 });
  expectProcessMetrics(text);
});

it('[AC-B2-09ze#2] 样本跟随每次快照、不常驻轮询：消失的 app 没有样本（不留旧值），快照为空时只有 # TYPE 行没有样本', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collectWaterStale = vi.fn<() => Promise<WaterStaleSnapshot>>();
  collectWaterStale
    .mockResolvedValueOnce({ waterStale: { stale_a: 1, stale_b: 0 } })
    .mockResolvedValueOnce({ waterStale: { stale_b: 1 } })
    .mockResolvedValueOnce({ waterStale: {} });
  const worker = createMetricsRegistry({ entry: 'worker', collectWaterStale });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collectWaterStale).not.toHaveBeenCalled();
  vi.useRealTimers();

  expect(waterStaleGauge(await worker.render())).toEqual({ stale_a: 1, stale_b: 0 });
  expect(waterStaleGauge(await worker.render())).toEqual({ stale_b: 1 });
  const empty = await worker.render();
  expect(families(empty).get(WATER_STALE_METRIC), 'the family stays').toBe('gauge');
  expect(waterStaleGauge(empty), 'no sample').toEqual({});
  expect(collectWaterStale).toHaveBeenCalledTimes(3);
});

it('[AC-B2-09ze#3] 只在 worker 且给了 collectWaterStale 时出现：api / stream / admin / payout 给了也不调用、不出指标名；worker 不给也没有', async () => {
  // Baseline first: the worker with collectWaterStale does export it.
  const baseline = await createMetricsRegistry({
    entry: 'worker',
    collectWaterStale: async () => ({ waterStale: { stale_a: 1 } }),
  }).render();
  expect(mentionsWaterStale(baseline), 'worker baseline').toBe(true);

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collectWaterStale = vi.fn(async () => ({ waterStale: { stale_a: 1 } }));
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collectWaterStale }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(mentionsWaterStale(text), entry).toBe(false);
    }
    expect(collectWaterStale, entry).not.toHaveBeenCalled();
  }
  for (const registry of [
    createMetricsRegistry({ entry: 'worker' }),
    createMetricsRegistry({
      entry: 'worker',
      collect: async () => WORKER,
      collectFund: async () => FIRST,
      collectAutoPayout: async () => AUTO,
      collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
      collectWaterLow: async () => ({ waterLow: { stale_a: 1 } }),
    }),
  ]) {
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(mentionsWaterStale(text)).toBe(false);
  }
});

it('[AC-B2-09ze#4] collectWaterStale 拒绝或同步抛出时 render() 拒绝（抓取失败可见）：不把值编造成 0，也不沿用上一次的值；恢复后下一次 scrape 取新值', async () => {
  const failure = new Error('stale W collection failed');
  const rejecting = vi.fn(async (): Promise<WaterStaleSnapshot> => {
    throw failure;
  });
  const failing = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    collectWaterLow: async () => ({ waterLow: {} }),
    collectWaterStale: rejecting,
  });
  await expect(failing.render()).rejects.toBe(failure);
  expect(rejecting).toHaveBeenCalledTimes(1);

  const throwing = createMetricsRegistry({
    entry: 'worker',
    collectWaterStale: (): Promise<WaterStaleSnapshot> => {
      throw failure;
    },
  });
  await expect(throwing.render()).rejects.toBe(failure);

  const collectWaterStale = vi.fn<() => Promise<WaterStaleSnapshot>>();
  collectWaterStale
    .mockResolvedValueOnce({ waterStale: { stale_a: 1 } })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ waterStale: { stale_a: 0 } });
  const worker = createMetricsRegistry({ entry: 'worker', collectWaterStale });
  expect(waterStaleGauge(await worker.render())).toEqual({ stale_a: 1 });
  await expect(worker.render()).rejects.toBe(failure);
  expect(waterStaleGauge(await worker.render())).toEqual({ stale_a: 0 });
  expect(collectWaterStale).toHaveBeenCalledTimes(3);
});
