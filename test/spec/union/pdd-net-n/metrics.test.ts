// B1-08zh（D10-574）指标与告警：couli_pdd_service_fee_missing_total 是进程内计数器，不带金额、不带订单号；
// infra/monitoring/rules/couli.yaml 有一条 warning 读它的 increase(...[1h]) > 0。
// YAML 用仓库的严格子集读取器（tools/lib/yaml-lite）。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { countPddServiceFeeMissing } from '../../../../apps/api/src/modules/platform/metrics/pdd-service-fee.ts';

const METRIC = 'couli_pdd_service_fee_missing_total';

const RULES = new URL('../../../../infra/monitoring/rules/couli.yaml', import.meta.url);

interface MetricSample {
  readonly labels: string;
  readonly value: number;
}

/** /metrics 文本里这个指标的样本；没有样本为空数组。 */
function metricSamples(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const line of text.split('\n')) {
    const match = /^couli_pdd_service_fee_missing_total(\{.*\})? (\S+)$/.exec(line);
    if (match !== null) samples.push({ labels: match[1] ?? '', value: Number(match[2]) });
  }
  return samples;
}

/** 所有序列的合计；还没有序列时是 0。 */
function metricTotal(text: string): number {
  return metricSamples(text).reduce((sum, sample) => sum + sample.value, 0);
}

interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly for: unknown;
  readonly labels: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

function rules(): Rule[] {
  const doc = parseYamlLite(readFileSync(RULES, 'utf8')) as {
    readonly groups: readonly { readonly rules: readonly Rule[] }[];
  };
  return doc.groups.flatMap((group) => group.rules);
}

it('[AC-B1-08zh#14] /metrics 里有这个计数器：类型 counter，从未计数时就有样本（否则 increase 看不到第一次），每计一次 +1', async () => {
  const registry = createMetricsRegistry({ entry: 'worker' });
  const first = await registry.render();
  expect(first).toContain(`# TYPE ${METRIC} counter`);
  expect(metricSamples(first).length).toBeGreaterThan(0);

  const before = metricTotal(first);
  countPddServiceFeeMissing();
  expect(metricTotal(await registry.render())).toBe(before + 1);
  countPddServiceFeeMissing();
  expect(metricTotal(await registry.render())).toBe(before + 2);
});

it('[AC-B1-08zh#15][BR-ID-33] 指标的标签里没有金额和订单号', async () => {
  const registry = createMetricsRegistry({ entry: 'worker' });
  countPddServiceFeeMissing();
  const samples = metricSamples(await registry.render());
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(sample.labels).not.toMatch(/fen|amount|commission|fee|order|sub_order|sn=/i);
    // 标签值也不能是一串数字（金额或单号）。
    expect(sample.labels).not.toMatch(/="[-\d.]+"/);
  }
});

it('[AC-B1-08zh#16] couli.yaml 有且只有一条读它的告警：warning，increase(...[1h]) > 0，有 summary，不带 fund 标签', () => {
  const found = rules().filter((rule) => rule.expr.includes(METRIC));
  expect(found).toHaveLength(1);
  const rule = found[0]!;
  expect(rule.expr.replace(/\s+/g, ' ').trim()).toBe(`increase(${METRIC}[1h]) > 0`);
  expect(rule.labels['severity']).toBe('warning');
  expect(rule.labels['fund']).toBeUndefined();
  expect(rule.alert).toEqual(expect.any(String));
  expect(rule.for).toEqual(expect.any(String));
  expect(rule.annotations['summary']).toEqual(expect.any(String));
  expect(String(rule.annotations['summary']).trim().length).toBeGreaterThan(0);
});
