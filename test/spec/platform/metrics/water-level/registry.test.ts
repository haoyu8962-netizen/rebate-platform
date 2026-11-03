// B2-09j: createMetricsRegistry({ entry, …, collectWaterLow? }). Only entry 'worker' with a
// collectWaterLow function exports couli_payout_water_low: # HELP and # TYPE gauge lines, one sample
// per app_id of the snapshot, filled at scrape time (render), never by a resident polling loop. 0 is
// a value ("checked, not low"); an app_id without a conclusion is simply not in the snapshot, so it
// has no sample. A rejected or throwing collection rejects render() (no 0 is made up, no older value
// reused). The surfaces of B1-01zzh, B1-01zzi, B1-01zzp and B2-05o stay as they were.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type AutoPayoutDailySnapshot,
  type WaterLowSnapshot,
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
import {
  WATER_LOW_METRIC,
  mentionsWaterLow,
  waterLowGauge,
  waterLowHelp,
} from './water-harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

const AUTO: AutoPayoutDailySnapshot = {
  totalFen: { water_a: 1_000 },
  capFen: { water_a: 2_000 },
};

it('[AC-B2-09j#13] worker 的 registry 在 scrape 时调 collectWaterLow：有 # HELP 与 # TYPE couli_payout_water_low gauge，每个 app_id 一个样本、只有 app_id 标签、值与快照一致；其余指标照旧', async () => {
  const collectWaterLow = vi.fn(async (): Promise<WaterLowSnapshot> => ({
    waterLow: { water_a: 1, water_b: 0 },
  }));
  const registry = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    collectWaterLow,
  });
  expect(collectWaterLow).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collectWaterLow).toHaveBeenCalledTimes(1);

  expect(families(text).get(WATER_LOW_METRIC), `# TYPE of ${WATER_LOW_METRIC}`).toBe('gauge');
  expect(waterLowHelp(text).length, `# HELP of ${WATER_LOW_METRIC}`).toBeGreaterThan(0);
  expect(waterLowGauge(text)).toEqual({ water_a: 1, water_b: 0 });
  expect(text).toMatch(new RegExp(`^${WATER_LOW_METRIC}\\{app_id="water_a"\\} 1$`, 'm'));
  expect(text).toMatch(new RegExp(`^${WATER_LOW_METRIC}\\{app_id="water_b"\\} 0$`, 'm'));

  // The surfaces of B1-01zzh, B1-01zzi, B1-01zzp and B2-05o are unchanged next to the new gauge.
  for (const key of METRIC_KEYS) expect(gauge(text, key), key).toEqual(WORKER[key]);
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
  expect(fundFromText(text)).toEqual(FIRST);
  expect(autoNamesIn(text)).toEqual(AUTO_METRIC_NAMES);
  expect(autoFromText(text)).toEqual(AUTO);
  expect(overdueValue(text)).toBe(3);
  expectProcessMetrics(text);
});

it('[AC-B2-09j#14] 样本跟随每次快照、不常驻轮询：结论消失的 app 没有样本（不留旧值、不补 0），快照为空时只有 # TYPE 行没有样本', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collectWaterLow = vi.fn<() => Promise<WaterLowSnapshot>>();
  collectWaterLow
    .mockResolvedValueOnce({ waterLow: { water_a: 1, water_b: 0 } })
    .mockResolvedValueOnce({ waterLow: { water_b: 1 } })
    .mockResolvedValueOnce({ waterLow: {} });
  const worker = createMetricsRegistry({ entry: 'worker', collectWaterLow });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collectWaterLow).not.toHaveBeenCalled();
  vi.useRealTimers();

  expect(waterLowGauge(await worker.render())).toEqual({ water_a: 1, water_b: 0 });
  expect(waterLowGauge(await worker.render())).toEqual({ water_b: 1 });
  const empty = await worker.render();
  expect(families(empty).get(WATER_LOW_METRIC), 'the family stays').toBe('gauge');
  expect(waterLowGauge(empty), 'no conclusion, no sample').toEqual({});
  expect(collectWaterLow).toHaveBeenCalledTimes(3);
});

it('[AC-B2-09j#15] 只在 worker 且给了 collectWaterLow 时出现：api / stream / admin / payout 给了也不调用、不出指标名；worker 不给也没有', async () => {
  // Baseline first: the worker with collectWaterLow does export it.
  const baseline = await createMetricsRegistry({
    entry: 'worker',
    collectWaterLow: async () => ({ waterLow: { water_a: 1 } }),
  }).render();
  expect(mentionsWaterLow(baseline), 'worker baseline').toBe(true);

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collectWaterLow = vi.fn(async () => ({ waterLow: { water_a: 1 } }));
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collectWaterLow }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(mentionsWaterLow(text), entry).toBe(false);
    }
    expect(collectWaterLow, entry).not.toHaveBeenCalled();
  }
  for (const registry of [
    createMetricsRegistry({ entry: 'worker' }),
    createMetricsRegistry({
      entry: 'worker',
      collect: async () => WORKER,
      collectFund: async () => FIRST,
      collectAutoPayout: async () => AUTO,
      collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    }),
  ]) {
    const text = await registry.render();
    expectProcessMetrics(text);
    expect(mentionsWaterLow(text)).toBe(false);
  }
});

it('[AC-B2-09j#16] collectWaterLow 拒绝或同步抛出时 render() 拒绝（抓取失败可见）：不把结论编造成 0，也不沿用上一次的值；恢复后下一次 scrape 取新值', async () => {
  const failure = new Error('water level collection failed');
  const rejecting = vi.fn(async (): Promise<WaterLowSnapshot> => {
    throw failure;
  });
  const failing = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    collectWaterLow: rejecting,
  });
  await expect(failing.render()).rejects.toBe(failure);
  expect(rejecting).toHaveBeenCalledTimes(1);

  const throwing = createMetricsRegistry({
    entry: 'worker',
    collectWaterLow: (): Promise<WaterLowSnapshot> => {
      throw failure;
    },
  });
  await expect(throwing.render()).rejects.toBe(failure);

  const collectWaterLow = vi.fn<() => Promise<WaterLowSnapshot>>();
  collectWaterLow
    .mockResolvedValueOnce({ waterLow: { water_a: 1 } })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ waterLow: { water_a: 0 } });
  const worker = createMetricsRegistry({ entry: 'worker', collectWaterLow });
  expect(waterLowGauge(await worker.render())).toEqual({ water_a: 1 });
  await expect(worker.render()).rejects.toBe(failure);
  expect(waterLowGauge(await worker.render())).toEqual({ water_a: 0 });
  expect(collectWaterLow).toHaveBeenCalledTimes(3);
});
