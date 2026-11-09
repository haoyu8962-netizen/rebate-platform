// B2-02v: createMetricsRegistry({ entry, …, collectCreditPostcheck? }). Only entry 'worker' with a
// collectCreditPostcheck function exports couli_credit_postcheck_mismatch_open: # HELP and # TYPE
// gauge lines, one sample per app_id of the snapshot, filled at scrape time (render), never by a
// resident polling loop. A rejected or throwing collection rejects render() (no 0 is made up, no
// older value reused). The surfaces next to it stay as they were.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMetricsRegistry,
  type AutoPayoutDailySnapshot,
  type CreditPostcheckSnapshot,
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
  CREDIT_POSTCHECK_METRIC,
  creditPostcheckGauge,
  creditPostcheckHelp,
  mentionsCreditPostcheck,
} from './postcheck-harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

const AUTO: AutoPayoutDailySnapshot = {
  totalFen: { postcheck_a: 1_000 },
  capFen: { postcheck_a: 2_000 },
};

it('[AC-B2-02v#1] worker 的 registry 在 scrape 时调 collectCreditPostcheck：有 # HELP 与 # TYPE gauge，每个 app_id 一个样本、只有 app_id 标签、值与快照一致；其余指标照旧', async () => {
  const collectCreditPostcheck = vi.fn(async (): Promise<CreditPostcheckSnapshot> => ({
    open: { postcheck_a: 1, postcheck_b: 3 },
  }));
  const registry = createMetricsRegistry({
    entry: 'worker',
    collect: async () => WORKER,
    collectFund: async () => FIRST,
    collectAutoPayout: async () => AUTO,
    collectReviewOverdue: async () => ({ reviewOverdue: 3 }),
    collectWaterLow: async () => ({ waterLow: { postcheck_a: 0 } }),
    collectWaterStale: async () => ({ waterStale: { postcheck_a: 1 } }),
    collectCreditPostcheck,
  });
  expect(collectCreditPostcheck).not.toHaveBeenCalled();
  const text = await registry.render();
  expect(collectCreditPostcheck).toHaveBeenCalledTimes(1);

  expect(families(text).get(CREDIT_POSTCHECK_METRIC), `# TYPE of ${CREDIT_POSTCHECK_METRIC}`).toBe(
    'gauge',
  );
  expect(creditPostcheckHelp(text).length, `# HELP of ${CREDIT_POSTCHECK_METRIC}`).toBeGreaterThan(
    0,
  );
  expect(creditPostcheckGauge(text)).toEqual({ postcheck_a: 1, postcheck_b: 3 });
  expect(text).toMatch(new RegExp(`^${CREDIT_POSTCHECK_METRIC}\\{app_id="postcheck_a"\\} 1$`, 'm'));
  expect(text).toMatch(new RegExp(`^${CREDIT_POSTCHECK_METRIC}\\{app_id="postcheck_b"\\} 3$`, 'm'));

  // The surfaces next to it are unchanged.
  for (const key of METRIC_KEYS) expect(gauge(text, key), key).toEqual(WORKER[key]);
  expect(businessNamesIn(text)).toEqual(METRIC_NAMES);
  expect(fundNamesIn(text)).toEqual(FUND_METRIC_NAMES);
  expect(fundFromText(text)).toEqual(FIRST);
  expect(autoNamesIn(text)).toEqual(AUTO_METRIC_NAMES);
  expect(autoFromText(text)).toEqual(AUTO);
  expect(overdueValue(text)).toBe(3);
  expect(waterLowGauge(text)).toEqual({ postcheck_a: 0 });
  expect(waterStaleGauge(text)).toEqual({ postcheck_a: 1 });
  expectProcessMetrics(text);
});

it('[AC-B2-02v#2] 样本跟随每次快照、不常驻轮询：没有未结单的 app 没有样本（不是 0、不留旧值），快照为空时只有 # TYPE 行没有样本', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  const collectCreditPostcheck = vi.fn<() => Promise<CreditPostcheckSnapshot>>();
  collectCreditPostcheck
    .mockResolvedValueOnce({ open: { postcheck_a: 1, postcheck_b: 2 } })
    .mockResolvedValueOnce({ open: { postcheck_b: 1 } })
    .mockResolvedValueOnce({ open: {} });
  const worker = createMetricsRegistry({ entry: 'worker', collectCreditPostcheck });
  vi.advanceTimersByTime(15 * 60_000);
  expect(collectCreditPostcheck).not.toHaveBeenCalled();
  vi.useRealTimers();

  expect(creditPostcheckGauge(await worker.render())).toEqual({ postcheck_a: 1, postcheck_b: 2 });
  expect(creditPostcheckGauge(await worker.render())).toEqual({ postcheck_b: 1 });
  const empty = await worker.render();
  expect(families(empty).get(CREDIT_POSTCHECK_METRIC), 'the family stays').toBe('gauge');
  expect(creditPostcheckGauge(empty), 'no sample').toEqual({});
  expect(collectCreditPostcheck).toHaveBeenCalledTimes(3);
});

it('[AC-B2-02v#3] 只在 worker 且给了 collectCreditPostcheck 时出现：api / stream / admin / payout 给了也不调用、不出指标名；worker 不给也没有', async () => {
  // Baseline first: the worker with collectCreditPostcheck does export it.
  const baseline = await createMetricsRegistry({
    entry: 'worker',
    collectCreditPostcheck: async () => ({ open: { postcheck_a: 1 } }),
  }).render();
  expect(mentionsCreditPostcheck(baseline), 'worker baseline').toBe(true);

  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    const collectCreditPostcheck = vi.fn(async () => ({ open: { postcheck_a: 1 } }));
    for (const registry of [
      createMetricsRegistry({ entry }),
      createMetricsRegistry({ entry, collectCreditPostcheck }),
    ]) {
      const text = await registry.render();
      expectProcessMetrics(text);
      expect(mentionsCreditPostcheck(text), entry).toBe(false);
    }
    expect(collectCreditPostcheck, entry).not.toHaveBeenCalled();
  }
  const text = await createMetricsRegistry({ entry: 'worker' }).render();
  expectProcessMetrics(text);
  expect(mentionsCreditPostcheck(text)).toBe(false);
});

it('[AC-B2-02v#4] collectCreditPostcheck 拒绝或同步抛出时 render() 拒绝（抓取失败可见）：不把值编造成 0，也不沿用上一次的值；恢复后下一次 scrape 取新值', async () => {
  const failure = new Error('open diffs collection failed');
  const rejecting = vi.fn(async (): Promise<CreditPostcheckSnapshot> => {
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
    collectCreditPostcheck: rejecting,
  });
  await expect(failing.render()).rejects.toBe(failure);
  expect(rejecting).toHaveBeenCalledTimes(1);

  const throwing = createMetricsRegistry({
    entry: 'worker',
    collectCreditPostcheck: (): Promise<CreditPostcheckSnapshot> => {
      throw failure;
    },
  });
  await expect(throwing.render()).rejects.toBe(failure);

  const collectCreditPostcheck = vi.fn<() => Promise<CreditPostcheckSnapshot>>();
  collectCreditPostcheck
    .mockResolvedValueOnce({ open: { postcheck_a: 1 } })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ open: { postcheck_a: 2 } });
  const worker = createMetricsRegistry({ entry: 'worker', collectCreditPostcheck });
  expect(creditPostcheckGauge(await worker.render())).toEqual({ postcheck_a: 1 });
  await expect(worker.render()).rejects.toBe(failure);
  expect(creditPostcheckGauge(await worker.render())).toEqual({ postcheck_a: 2 });
  expect(collectCreditPostcheck).toHaveBeenCalledTimes(3);
});
